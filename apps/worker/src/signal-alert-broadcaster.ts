import { classifyMarketStructure, findConfirmedSwings } from "@crypto-signal/indicators";
import type { MarketTimeframe } from "@crypto-signal/market-data";
import type { Candle } from "@crypto-signal/shared";
import {
  evaluateBreakAndRetestState,
  evaluateQuantitativeConsistency,
  type BreakoutAnticipation,
  type PriceLevel,
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
const BREAKOUT_NOTICE_WINDOW_MS = 4 * 60 * 60_000;
const MAX_CAPTION_LENGTH = 1024;
const MAX_RETAINED_LIVE_SIGNALS = 20;

export interface BreakoutNoticeSummary {
  readonly symbol: string;
  readonly timeframe: MarketTimeframe;
  readonly topDownBias: string;
  readonly anticipation: BreakoutAnticipation;
  readonly timestamp: number;
}

export interface SignalAlertBroadcasterOptions {
  readonly api: Pick<TelegramApiClient, "sendPhoto"> & Partial<Pick<TelegramApiClient, "sendMessage">>;
  readonly users: TelegramUserStateStore;
  readonly evidence: Partial<Record<SignalCandidate["strategy"], StrategyQualityEvidence>>;
  readonly now?: () => number;
  readonly executionTimeframe?: MarketTimeframe;
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

function candidateCaption(
  candidate: SignalCandidate,
  quality: SignalQualityResult,
  executionTimeframe = "5M"
): string {
  const risk = Math.abs(candidate.entryPrice - candidate.stopLoss);
  const reward = Math.abs(candidate.target2 - candidate.entryPrice);
  const rr = risk > 0 ? reward / risk : candidate.minimumRiskReward;
  return truncateCaption([
    `LIVE SIGNAL · ${candidate.symbol} — ${candidate.side.toUpperCase()}`,
    `Strategy: ${candidate.strategy.replaceAll("_", " ")} (${executionTimeframe.toUpperCase()})`,
    `Top-Down Bias (1D → ${executionTimeframe.toUpperCase()}): ${candidate.higherTimeframeBias}`,
    `Entry: ${formatPrice(candidate.entryPrice)}`,
    `SL (Stop Loss): ${formatPrice(candidate.stopLoss)}`,
    `Take Profit TP1: ${formatPrice(candidate.target1)}`,
    `Take Profit TP2: ${formatPrice(candidate.target2)}`,
    `Take Profit TP3: Trailing runner`,
    `Risk/Reward: ${rr.toFixed(2)}R · Quality: ${quality.score}/100 (Grade ${quality.strategyGrade})`
  ].join("\n"));
}

function quantCaption(signal: QuantSignalResult): string {
  return truncateCaption([
    `QUANT SIGNAL · ${signal.symbol} (${signal.timeframe.toUpperCase()}) — ${signal.side.toUpperCase()}`,
    `Strategy: ${signal.strategy.replaceAll("_", " ")} | Confidence: ${signal.confidence.toUpperCase()}`,
    `Entry: ${formatPrice(signal.entryPrice)}`,
    `SL (Stop Loss): ${formatPrice(signal.stopLoss)}`,
    `Take Profit TP1: ${formatPrice(signal.target1)} | TP2: ${formatPrice(signal.target2)}`,
    `Consistency: ${signal.consistencyScore}% | Expectancy: ${signal.expectancyScore}R (${signal.riskRewardRatio.toFixed(1)}:1 R:R)`,
    signal.rationale
  ].join("\n"));
}

function breakoutNoticeText(notice: BreakoutNoticeSummary): string {
  const direction = notice.anticipation.side.toUpperCase();
  const stateLabel =
    notice.anticipation.kind === "awaiting_retest"
      ? "Breakout occurred — waiting for clean retest & rejection confirmation"
      : `Price testing within ${notice.anticipation.distancePercent.toFixed(2)}% of key ${notice.anticipation.side === "buy" ? "Supply/Resistance" : "Demand/Support"} level`;
  return [
    `BREAKOUT NOTICE · ${notice.symbol} (1D → ${notice.timeframe.toUpperCase()})`,
    `Expecting possible ${direction} breakout position.`,
    `Status: ${stateLabel}`,
    `Key Level: ${formatPrice(notice.anticipation.levelPrice)} | Current: ${formatPrice(notice.anticipation.currentPrice)}`,
    `Top-Down Bias: ${notice.topDownBias}`,
    `Note: Respecting key zone — waiting for candle confirmation before issuing Entry / SL / TP signal.`
  ].join("\n");
}

function resolveHigherTimeframeBias(
  datasets: ReadonlyMap<MarketTimeframe, readonly Candle[]>
): { readonly dominant: "bullish" | "bearish" | "neutral"; readonly summary: string } {
  const parts: string[] = [];
  let score = 0;
  for (const timeframe of ["1d", "4h", "1h"] as const) {
    const candles = (datasets.get(timeframe) ?? []).filter((candle) => candle.closed);
    if (candles.length < 10) continue;
    const swings = findConfirmedSwings(candles, { leftBars: 2, rightBars: 2 });
    const regime = classifyMarketStructure(candles, swings).regime;
    const weight = timeframe === "1d" ? 3 : timeframe === "4h" ? 2 : 1;
    if (regime === "bullish") score += weight;
    else if (regime === "bearish") score -= weight;
    parts.push(`${timeframe.toUpperCase()}:${regime}`);
  }
  const dominant: "bullish" | "bearish" | "neutral" =
    score >= 2 ? "bullish" : score <= -2 ? "bearish" : "neutral";
  return {
    dominant,
    summary: parts.length > 0 ? parts.join(", ") : "neutral"
  };
}

function collectTopDownPriceLevels(
  datasets: ReadonlyMap<MarketTimeframe, readonly Candle[]>,
  executionTimeframe: MarketTimeframe,
  beforeTime: number
): PriceLevel[] {
  const frames: readonly MarketTimeframe[] = [...new Set<MarketTimeframe>(["1d", "4h", "1h", executionTimeframe])];
  const levels: PriceLevel[] = [];
  for (const tf of frames) {
    const candles = (datasets.get(tf) ?? []).filter((candle) => candle.closed && candle.closeTime <= beforeTime);
    if (candles.length < 5) continue;
    const swings = findConfirmedSwings(candles, { leftBars: 2, rightBars: 2 });
    for (const swing of swings.slice(-6)) {
      levels.push({
        id: `${tf}:${swing.direction}:${swing.openTime}`,
        kind: swing.direction === "high" ? "swing_high" : "swing_low",
        price: swing.price,
        confirmedAt: swing.confirmedAt
      });
    }
  }
  return levels;
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
  private readonly latestNoticesBySymbol = new Map<string, BreakoutNoticeSummary>();
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

  getLatestBreakoutNotices(): readonly BreakoutNoticeSummary[] {
    return [...this.latestNoticesBySymbol.values()]
      .sort((a, b) => b.timestamp - a.timestamp);
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
    const executionTf = candidate.analysisSnapshot?.executionTimeframe ??
      this.options.executionTimeframe ?? "5m";
    const caption = candidateCaption(candidate, quality, executionTf);

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
    const { dominant: higherTimeframeBias, summary: topDownSummary } = resolveHigherTimeframeBias(datasets);
    const executionTf = this.options.executionTimeframe ?? "5m";
    let sentCount = 0;

    // 1. Evaluate Break & Retest pre-breakout anticipation from Daily down to execution TF
    const execClosed = (datasets.get(executionTf) ?? datasets.get("5m") ?? [])
      .filter((candle) => candle.closed);
    if (execClosed.length >= 6 && this.options.api.sendMessage) {
      const latestClose = execClosed.at(-1)!.closeTime;
      const levels = collectTopDownPriceLevels(datasets, executionTf, latestClose);
      const evaluation = evaluateBreakAndRetestState({
        symbol,
        candles: execClosed,
        levels,
        higherTimeframeBias,
        executionTimeframe: executionTf
      });
      if (evaluation.anticipation) {
        const notice: BreakoutNoticeSummary = {
          symbol,
          timeframe: executionTf,
          topDownBias: topDownSummary,
          anticipation: evaluation.anticipation,
          timestamp: latestClose
        };
        this.latestNoticesBySymbol.set(symbol, notice);

        const noticeUsers = this.options.users.listUsers().filter(({ state }) =>
          state.signalAlertsEnabled &&
          !state.paused &&
          state.enabledStrategies.includes("break_and_retest")
        );
        const windowBucket = Math.floor(latestClose / BREAKOUT_NOTICE_WINDOW_MS);
        const eventKey = `notice:${symbol}:${executionTf}:${evaluation.anticipation.kind}:${evaluation.anticipation.levelId}:${windowBucket}`;
        const text = breakoutNoticeText(notice);
        for (const { chatId } of noticeUsers) {
          if (!this.options.users.claimNotificationEvent(chatId, eventKey)) continue;
          try {
            await this.options.api.sendMessage(chatId, text);
            sentCount += 1;
            this.options.onDeliverySuccess?.(eventKey);
          } catch (error) {
            this.options.onDeliveryError?.(eventKey, error);
          }
        }
      }
    }

    // 2. Quantitative consistency multi-timeframe feed
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
    if (eligibleUsers.length === 0 || symbolSignals.length === 0) return sentCount;

    const currentTime = this.now();

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
