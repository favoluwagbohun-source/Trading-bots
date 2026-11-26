import { atr, classifyMarketStructure, detectTrendlines, findConfirmedSwings } from "@crypto-signal/indicators";
import type { Candle, StrategyId } from "@crypto-signal/shared";
import {
  activateAtNextOpen,
  activateSetupAtNextOpen,
  evaluateBreakAndRetest,
  evaluateLiquiditySweep,
  evaluateOrderBlockRetest,
  evaluateTopDownTrendline,
  TOP_DOWN_TIMEFRAMES,
  type EntryMode,
  type TopDownBias,
  type TopDownTimeframe
} from "@crypto-signal/strategies";
import type { BinanceRestClient } from "@crypto-signal/market-data";
import type { MarketTimeframe } from "@crypto-signal/market-data";

const TIMEFRAME_MAP: Readonly<Record<TopDownTimeframe, MarketTimeframe>> = {
  "1M": "1M",
  "1W": "1w",
  "1D": "1d",
  "4H": "4h",
  "1H": "1h"
};
const SCAN_TIMEFRAMES: readonly MarketTimeframe[] = [
  "1M", "1w", "1d", "4h", "1h", "5m"
];
const TOP_DOWN_MODES: readonly EntryMode[] = ["break", "bounce", "retest"];
const CANDIDATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SignalCandidate {
  readonly signalId: string;
  readonly snapshotId: string;
  readonly symbol: string;
  readonly strategy: StrategyId;
  readonly side: "buy" | "sell";
  readonly signalCandle: Candle;
  readonly entryCandleOpenTime: number;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly target1: number;
  readonly target2: number;
  readonly target3: "trailing_runner";
  readonly minimumRiskReward: number;
  readonly higherTimeframeBias: string;
  readonly chartCandles: readonly Candle[];
  readonly chartAnnotations: ChartAnnotations;
  readonly mode?: EntryMode;
}

export interface ChartAnnotations {
  readonly trendline?: {
    readonly id: string;
    readonly anchorA: { readonly openTime: number; readonly price: number };
    readonly anchorB: { readonly openTime: number; readonly price: number };
  };
  readonly levels: readonly { readonly label: string; readonly price: number }[];
  readonly zones: readonly {
    readonly label: string;
    readonly low: number;
    readonly high: number;
  }[];
}

export interface SignalScannerOptions {
  readonly symbols: readonly string[];
  readonly client: Pick<BinanceRestClient, "getHistoricalKlines">;
  readonly scanIntervalMs: number;
  readonly onCandidate: (candidate: SignalCandidate) => void | Promise<void>;
  readonly onError: (symbol: string, error: unknown) => void;
  readonly historyLimit?: number;
}

function normalizeSymbols(symbols: readonly string[]): string[] {
  const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))];
  if (
    normalized.length === 0 ||
    normalized.some((symbol) => !/^[A-Z0-9]{6,20}$/.test(symbol))
  ) {
    throw new Error("Configure at least one valid Binance symbol in the watchlist");
  }
  return normalized;
}

function closedCandlesAsOf(candles: readonly Candle[], asOfTime: number): Candle[] {
  return candles.filter((candle) => candle.closed && candle.closeTime <= asOfTime);
}

function timeframeBias(candles: readonly Candle[]): TopDownBias[TopDownTimeframe] | undefined {
  const latest = candles.at(-1);
  if (!latest) return undefined;
  const swings = findConfirmedSwings(candles, { leftBars: 2, rightBars: 2 });
  const structure = classifyMarketStructure(candles, swings);
  return { regime: structure.regime, availableAt: latest.closeTime };
}

function toCandidate(
  args: {
    readonly symbol: string;
    readonly strategy: StrategyId;
    readonly side: "buy" | "sell";
    readonly signalCandle: Candle;
    readonly entryCandleOpenTime: number;
    readonly entryPrice: number;
    readonly stopLoss: number;
    readonly target1: number;
    readonly target2: number;
    readonly target3: "trailing_runner";
    readonly minimumRiskReward: number;
    readonly higherTimeframeBias: string;
    readonly chartCandles: readonly Candle[];
    readonly chartAnnotations: ChartAnnotations;
    readonly mode?: EntryMode;
  }
): SignalCandidate {
  const suffix = args.mode ? `:${args.mode}` : "";
  return {
    signalId: `${args.symbol}:${args.strategy}${suffix}:${args.signalCandle.openTime}`,
    snapshotId: `${args.symbol}:5m:${args.signalCandle.openTime}`,
    ...args
  };
}

function asTopDownBias(
  datasets: ReadonlyMap<MarketTimeframe, readonly Candle[]>,
  asOfTime: number
): TopDownBias {
  const result: TopDownBias = {};
  for (const timeframe of TOP_DOWN_TIMEFRAMES) {
    const candles = closedCandlesAsOf(
      datasets.get(TIMEFRAME_MAP[timeframe]) ?? [],
      asOfTime
    );
    const bias = timeframeBias(candles);
    if (bias) result[timeframe] = bias;
  }
  return result;
}

function createCandidates(
  symbol: string,
  datasets: ReadonlyMap<MarketTimeframe, readonly Candle[]>
): SignalCandidate[] {
  const rawExecutionCandles = datasets.get("5m") ?? [];
  const latestClosed = rawExecutionCandles
    .filter((candle) => candle.closed)
    .at(-1);
  if (!latestClosed) return [];

  const asOfTime = latestClosed.closeTime;
  const executionCandles = closedCandlesAsOf(rawExecutionCandles, asOfTime);
  const nextCandle = rawExecutionCandles.find(
    (candle) => candle.openTime === latestClosed.closeTime + 1
  );
  if (!nextCandle || nextCandle.closed || executionCandles.length < 3) return [];

  const swings = findConfirmedSwings(executionCandles, { leftBars: 2, rightBars: 2 });
  const levels = swings
    .filter((swing) => swing.confirmedAt <= asOfTime)
    .map((swing) => ({
      id: `${swing.direction}:${swing.openTime}`,
      kind: swing.direction === "high" ? "swing_high" as const : "swing_low" as const,
      price: swing.price,
      confirmedAt: swing.confirmedAt
    }));
  const candidates: SignalCandidate[] = [];

  const fourHourCandles = closedCandlesAsOf(datasets.get("4h") ?? [], asOfTime);
  const fourHourSwings = findConfirmedSwings(fourHourCandles, {
    leftBars: 2,
    rightBars: 2
  });
  const trendlines = detectTrendlines(fourHourCandles, fourHourSwings);
  const higherTimeframeBias = asTopDownBias(datasets, asOfTime);
  for (const mode of TOP_DOWN_MODES) {
    const signal = evaluateTopDownTrendline({
      symbol,
      mode,
      executionCandles,
      fourHourTrendlines: trendlines,
      higherTimeframeBias
    });
    if (!signal) continue;
    const plan = activateAtNextOpen(signal, nextCandle);
    const trendline = trendlines.find(({ id }) => id === signal.trendlineId);
    candidates.push(toCandidate({
      symbol,
      strategy: signal.strategy,
      side: signal.side,
      signalCandle: signal.signalCandle,
      entryCandleOpenTime: plan.entryTime,
      entryPrice: plan.entryPrice,
      stopLoss: plan.stopLoss,
      target1: plan.target1,
      target2: plan.target2,
      target3: plan.target3,
      minimumRiskReward: plan.minimumRiskReward,
      higherTimeframeBias: Object.entries(signal.higherTimeframeBias)
        .map(([timeframe, bias]) => `${timeframe}:${bias}`)
        .join(", "),
      chartCandles: executionCandles,
      chartAnnotations: {
        ...(trendline === undefined ? {} : {
          trendline: {
            id: trendline.id,
            anchorA: { openTime: trendline.anchorA.openTime, price: trendline.anchorA.price },
            anchorB: { openTime: trendline.anchorB.openTime, price: trendline.anchorB.price }
          }
        }),
        levels: [],
        zones: []
      },
      mode
    }));
  }

  const setups = [
    evaluateBreakAndRetest({ symbol, candles: executionCandles, levels }),
    evaluateLiquiditySweep({ symbol, candles: executionCandles, levels }),
    evaluateOrderBlockRetest({
      symbol,
      candles: executionCandles,
      atrValues: atr(executionCandles)
    })
  ];
  for (const setup of setups) {
    if (!setup) continue;
    const plan = activateSetupAtNextOpen(setup, nextCandle);
    candidates.push(toCandidate({
      symbol,
      strategy: setup.strategy,
      side: setup.side,
      signalCandle: setup.signalCandle,
      entryCandleOpenTime: plan.entryTime,
      entryPrice: plan.entryPrice,
      stopLoss: plan.stopLoss,
      target1: plan.target1,
      target2: plan.target2,
      target3: plan.target3,
      minimumRiskReward: plan.minimumRiskReward,
      higherTimeframeBias: "not applicable",
      chartCandles: executionCandles,
      chartAnnotations: setup.reference.kind === "level"
        ? {
            levels: [{ label: "Reference level", price: setup.reference.price }],
            zones: []
          }
        : {
            levels: [],
            zones: [{
              label: "Supply/demand zone",
              low: setup.reference.low,
              high: setup.reference.high
            }]
          }
    }));
  }
  return candidates;
}

function waitForNextScan(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class SignalScanner {
  private readonly symbols: readonly string[];
  private readonly historyLimit: number;
  private readonly emittedCandidates = new Map<string, number>();

  constructor(private readonly options: SignalScannerOptions) {
    this.symbols = normalizeSymbols(options.symbols);
    if (!Number.isInteger(options.scanIntervalMs) || options.scanIntervalMs < 5_000) {
      throw new Error("Scan interval must be an integer of at least 5000ms");
    }
    this.historyLimit = options.historyLimit ?? 500;
    if (!Number.isInteger(this.historyLimit) || this.historyLimit < 20 || this.historyLimit > 1000) {
      throw new Error("History limit must be an integer between 20 and 1000");
    }
  }

  async scanOnce(): Promise<SignalCandidate[]> {
    const emitted: SignalCandidate[] = [];
    for (const symbol of this.symbols) {
      try {
        const results = await Promise.allSettled(SCAN_TIMEFRAMES.map((timeframe) =>
          this.options.client.getHistoricalKlines({
              symbol,
              timeframe,
              limit: this.historyLimit
            })
        ));
        const datasets = new Map<MarketTimeframe, readonly Candle[]>();
        for (const [index, result] of results.entries()) {
          const timeframe = SCAN_TIMEFRAMES[index]!;
          if (result.status === "fulfilled") {
            datasets.set(timeframe, result.value);
          } else {
            this.options.onError(
              symbol,
              new Error(`Unable to load ${timeframe} candles: ${String(result.reason)}`)
            );
          }
        }
        if (!datasets.has("5m")) continue;
        const candidates = createCandidates(symbol, datasets);
        for (const candidate of candidates) {
          if (this.emittedCandidates.has(candidate.signalId)) continue;
          await this.options.onCandidate(candidate);
          this.emittedCandidates.set(candidate.signalId, Date.now());
          emitted.push(candidate);
        }
      } catch (error) {
        this.options.onError(symbol, error);
      }
    }

    const cutoff = Date.now() - CANDIDATE_RETENTION_MS;
    for (const [signalId, createdAt] of this.emittedCandidates) {
      if (createdAt < cutoff) this.emittedCandidates.delete(signalId);
    }
    return emitted;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.scanOnce();
      await waitForNextScan(this.options.scanIntervalMs, signal);
    }
  }
}
