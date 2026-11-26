import { classifyMarketStructure, findConfirmedSwings } from "@crypto-signal/indicators";
import type { MarketTimeframe } from "@crypto-signal/market-data";
import type { Candle } from "@crypto-signal/shared";
import {
  evaluateQuantitativeConsistency,
  type QuantSignalResult
} from "@crypto-signal/strategies";
import type {
  LiveSignalSummary,
  QuantSignalSummary,
  TelegramApiClient,
  TelegramUserStateStore
} from "@crypto-signal/telegram";
import { renderSignalChart, type RenderedSignalChart } from "./chart-image.js";
import type { SignalChart } from "./market-analysis.js";
import { scoreSignalQuality, type SignalQualityResult, type StrategyQualityEvidence } from "./signal-quality.js";
import type { SignalCandidate } from "./signal-scanner.js";

const QUANT_TIMEFRAMES: readonly MarketTimeframe[] = ["5m", "1h", "4h"];
const MAX_CAPTION_LENGTH = 1024;
const MAX_RETAINED_LIVE_SIGNALS = 20;

export interface SignalAlertBroadcasterOptions {
  readonly api: Pick<TelegramApiClient, "sendPhoto">;
  readonly users: TelegramUserStateStore;
  readonly evidence: Partial<Record<SignalCandidate["strategy"], StrategyQualityEvidence>>;
  readonly now?: () => number;
  readonly onDeliverySuccess?: (eventId: string) => void;
  readonly onDeliveryError?: (eventId: string, error: unknown) => void;
}

function truncateCaption(caption: string): string {
  if (caption.length <= MAX_CAPTION_LENGTH) return caption;
  return `${caption.slice(0, MAX_CAPTION_LENGTH - 3)}...`;
}

function maxQuantAgeMs(timeframe: string): number {
  switch (timeframe) {
    case "5m":
      return 30 * 60_000;
    case "1h":
      return 3 * 60 * 60_000;
    case "4h":
      return 8 * 60 * 60_000;
    default:
      return 4 * 60 * 60_000;
  }
}

function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return String(price);
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toPrecision(5);
}

function candidateCaption(candidate: SignalCandidate, quality: SignalQualityResult): string {
  const risk = Math.abs(candidate.entryPrice - candidate.stopLoss);
  const reward = Math.abs(candidate.target2 - candidate.entryPrice);
  const rr = risk > 0 ? reward / risk : candidate.minimumRiskReward;
  return truncateCaption([
    `LIVE SIGNAL · ${candidate.symbol} — ${candidate.side.toUpperCase()}`,
    `Strategy: ${candidate.strategy.replaceAll("_", " ")} (5M)`,
    `Higher-TF bias: ${candidate.higherTimeframeBias}`,
    `Entry: ${formatPrice(candidate.entryPrice)} | Stop: ${formatPrice(candidate.stopLoss)}`,
    `TP1: ${formatPrice(candidate.target1)} | TP2: ${formatPrice(candidate.target2)} | TP3: Trailing`,
    `Risk/Reward: ${rr.toFixed(2)}R`,
    `Quality: ${quality.score}/100 · Grade ${quality.strategyGrade}`,
    `Use /paper on with /account to simulate 1%-risk trades.`
  ].join("\n"));
}

function quantCaption(signal: QuantSignalResult): string {
  return truncateCaption([
    `QUANT SIGNAL · ${signal.symbol} (${signal.timeframe.toUpperCase()}) — ${signal.side.toUpperCase()}`,
    `Strategy: ${signal.strategy.replaceAll("_", " ")} | Confidence: ${signal.confidence.toUpperCase()}`,
    `Entry: ${formatPrice(signal.entryPrice)} | Stop: ${formatPrice(signal.stopLoss)}`,
    `TP1: ${formatPrice(signal.target1)} | TP2: ${formatPrice(signal.target2)}`,
    `Consistency: ${signal.consistencyScore}% | Expectancy: ${signal.expectancyScore}R (${signal.riskRewardRatio.toFixed(1)}:1 R:R)`,
    signal.rationale
  ].join("\n"));
}

function resolveHigherTimeframeBias(
  datasets: ReadonlyMap<MarketTimeframe, readonly Candle[]>
): "bullish" | "bearish" | "neutral" {
  for (const timeframe of ["4h", "1d"] as const) {
    const candles = (datasets.get(timeframe) ?? []).filter((candle) => candle.closed);
    if (candles.length < 10) continue;
    const swings = findConfirmedSwings(candles, { leftBars: 2, rightBars: 2 });
    return classifyMarketStructure(candles, swings).regime;
  }
  return "neutral";
}

function buildQuantChartSpec(
  signal: QuantSignalResult,
  closedCandles: readonly Candle[]
): SignalChart | undefined {
  const signalIndex = closedCandles.findIndex((candle) => candle.closeTime === signal.timestamp);
  if (signalIndex < 1) return undefined;
  const chartCandles = closedCandles.slice(Math.max(0, signalIndex - 119), signalIndex + 1);
  const signalCandle = chartCandles.at(-1);
  if (!signalCandle || chartCandles.length < 2) return undefined;
  return {
    snapshotId: `${signal.symbol}:${signal.timeframe}:${signalCandle.openTime}`,
    symbol: signal.symbol,
    strategy: signal.strategy,
    side: signal.side,
    signalCandle,
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    target1: signal.target1,
    target2: signal.target2,
    chartCandles,
    chartAnnotations: { levels: [], zones: [] }
  };
}

export class SignalAlertBroadcaster {
  private readonly now: () => number;
  private readonly latestQuantBySymbol = new Map<string, readonly QuantSignalResult[]>();
  private readonly latestLiveSignals: LiveSignalSummary[] = [];

  constructor(private readonly options: SignalAlertBroadcasterOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  getLatestQuantSignals(): readonly QuantSignalSummary[] {
    return [...this.latestQuantBySymbol.values()]
      .flat()
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  getLatestLiveSignals(): readonly LiveSignalSummary[] {
    return [...this.latestLiveSignals];
  }

  async processCandidate(candidate: SignalCandidate): Promise<number> {
    const quality = scoreSignalQuality(candidate, this.options.evidence[candidate.strategy]);
    if (!quality.publishEligible) return 0;

    this.recordLiveSignal({
      signalId: candidate.signalId,
      symbol: candidate.symbol,
      strategy: candidate.strategy,
      side: candidate.side,
      entryPrice: candidate.entryPrice,
      stopLoss: candidate.stopLoss,
      target1: candidate.target1,
      target2: candidate.target2,
      score: quality.score,
      grade: quality.strategyGrade,
      closeTime: candidate.signalCandle.closeTime
    });

    const eligibleUsers = this.options.users.listUsers().filter(({ state }) =>
      state.signalAlertsEnabled &&
      !state.paused &&
      state.enabledStrategies.includes(candidate.strategy)
    );
    if (eligibleUsers.length === 0) return 0;

    let chart: RenderedSignalChart | undefined;
    let sentCount = 0;
    const eventKey = `signal:${candidate.signalId}`;
    const caption = candidateCaption(candidate, quality);

    for (const { chatId } of eligibleUsers) {
      if (!this.options.users.claimNotificationEvent(chatId, eventKey)) continue;
      try {
        chart ??= renderSignalChart(candidate);
        await this.options.api.sendPhoto(chatId, chart.image, caption);
        sentCount += 1;
        this.options.onDeliverySuccess?.(eventKey);
      } catch (error) {
        this.options.onDeliveryError?.(eventKey, error);
      }
    }
    return sentCount;
  }

  async processDatasets(
    symbolInput: string,
    datasets: ReadonlyMap<MarketTimeframe, readonly Candle[]>
  ): Promise<number> {
    const symbol = symbolInput.trim().toUpperCase();
    const higherTimeframeBias = resolveHigherTimeframeBias(datasets);
    const symbolSignals: { signal: QuantSignalResult; candles: readonly Candle[] }[] = [];

    for (const timeframe of QUANT_TIMEFRAMES) {
      const closedCandles = (datasets.get(timeframe) ?? []).filter((candle) => candle.closed);
      if (closedCandles.length < 25) continue;
      const evaluated = evaluateQuantitativeConsistency({
        symbol,
        timeframe,
        candles: closedCandles,
        higherTimeframeBias
      });
      for (const signal of evaluated) {
        symbolSignals.push({ signal, candles: closedCandles });
      }
    }

    symbolSignals.sort((a, b) => b.signal.timestamp - a.signal.timestamp);
    this.latestQuantBySymbol.set(
      symbol,
      symbolSignals.map(({ signal }) => signal)
    );

    const eligibleUsers = this.options.users.listUsers();
    if (eligibleUsers.length === 0 || symbolSignals.length === 0) return 0;

    const currentTime = this.now();
    let sentCount = 0;

    for (const { signal, candles } of symbolSignals) {
      if (currentTime - signal.timestamp > maxQuantAgeMs(signal.timeframe)) continue;
      const recipients = eligibleUsers.filter(({ state }) =>
        state.signalAlertsEnabled &&
        !state.paused &&
        state.enabledStrategies.includes(signal.strategy)
      );
      if (recipients.length === 0) continue;

      const chartSpec = buildQuantChartSpec(signal, candles);
      if (!chartSpec) continue;

      let chart: RenderedSignalChart | undefined;
      const eventKey = `quant:${signal.id}`;
      const caption = quantCaption(signal);

      for (const { chatId } of recipients) {
        if (!this.options.users.claimNotificationEvent(chatId, eventKey)) continue;
        try {
          chart ??= renderSignalChart(chartSpec);
          await this.options.api.sendPhoto(chatId, chart.image, caption);
          sentCount += 1;
          this.options.onDeliverySuccess?.(eventKey);
        } catch (error) {
          this.options.onDeliveryError?.(eventKey, error);
        }
      }
    }

    return sentCount;
  }

  private recordLiveSignal(entry: LiveSignalSummary): void {
    const existingIndex = this.latestLiveSignals.findIndex(
      (item) => item.signalId === entry.signalId
    );
    if (existingIndex >= 0) this.latestLiveSignals.splice(existingIndex, 1);
    this.latestLiveSignals.unshift(entry);
    if (this.latestLiveSignals.length > MAX_RETAINED_LIVE_SIGNALS) {
      this.latestLiveSignals.length = MAX_RETAINED_LIVE_SIGNALS;
    }
  }
}
