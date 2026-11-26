import {
  atr,
  buildTrendlineLifecycles,
  classifyMarketRegime,
  findConfirmedSwings,
  type SwingPoint,
  type Trendline,
  type TrendlineLifecycle
} from "@crypto-signal/indicators";
import type { MarketTimeframe } from "@crypto-signal/market-data";
import {
  evaluateBreakAndRetestState,
  evaluateLiquiditySweep,
  evaluateOrderBlockRetest,
  evaluateTopDownTrendline,
  TOP_DOWN_TIMEFRAMES,
  type EntryMode,
  type PriceLevel,
  type TopDownBias,
  type TopDownTimeframe
} from "@crypto-signal/strategies";
import type { Candle, StrategyId } from "@crypto-signal/shared";
import {
  runRegimeBreakdown,
  type RegimeBreakdownResult
} from "@crypto-signal/backtesting";
import type {
  BacktestConfig,
  BacktestSetup,
  SignalEvaluator
} from "@crypto-signal/backtesting";

const TIMEFRAME_FOR_BIAS: Readonly<Record<TopDownTimeframe, HistoricalTimeframeId>> = {
  "1M": "1M",
  "1W": "1w",
  "1D": "1d",
  "4H": "4h",
  "1H": "1h"
};
const TOP_DOWN_VARIATIONS: readonly EntryMode[] = ["break", "bounce", "retest"];
const MAX_RECENT_SWINGS_PER_DIRECTION = 50;
const TRENDLINE_LOOKBACK_BARS = 500;
const TRENDLINE_MINIMUM_TOUCHES = 3;
const SAFETY_STOP_BUFFER_PERCENT = 0.1;

export interface HistoricalTimeframe {
  readonly candles: readonly Candle[];
  readonly swings: readonly SwingPoint[];
  readonly regimes: readonly string[];
  readonly structureRegimes: readonly ("bullish" | "bearish" | "neutral")[];
}

export type HistoricalTimeframeId = "1M" | "1w" | "1d" | "4h" | "1h" | "5m";
export type HistoricalTimeframes =
  Readonly<Record<HistoricalTimeframeId, HistoricalTimeframe>>;

function upperBound<T>(
  values: readonly T[],
  value: number,
  selector: (item: T) => number
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (selector(values[middle]!) <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function regimeHistory(
  candles: readonly Candle[],
  swings: readonly SwingPoint[]
): string[] {
  const regimes: string[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    regimes.push(classifyMarketRegime(
      candles.slice(0, index + 1),
      swings
    ).regime);
  }
  return regimes;
}

function structureHistory(
  candles: readonly Candle[],
  swings: readonly SwingPoint[]
): ("bullish" | "bearish" | "neutral")[] {
  const regimes: ("bullish" | "bearish" | "neutral")[] = [];
  let swingIndex = 0;
  let latestHigh: SwingPoint | undefined;
  let latestLow: SwingPoint | undefined;
  for (let index = 0; index < candles.length; index += 1) {
    while (
      swingIndex < swings.length &&
      swings[swingIndex]!.confirmedIndex <= index
    ) {
      const swing = swings[swingIndex++]!;
      if (swing.direction === "high") latestHigh = swing;
      else latestLow = swing;
    }
    regimes.push(!latestHigh || !latestLow
      ? "neutral"
      : latestHigh.index > latestLow.index ? "bullish" : "bearish");
  }
  return regimes;
}

export function prepareHistoricalTimeframe(
  candles: readonly Candle[],
  timeframe: MarketTimeframe
): HistoricalTimeframe {
  const closed = Object.freeze(candles.filter((candle) => candle.closed));
  const swings = Object.freeze(findConfirmedSwings(closed, {
    leftBars: 2,
    rightBars: 2
  }));
  const structureRegimes = Object.freeze(structureHistory(closed, swings));
  return Object.freeze({
    candles: closed,
    swings,
    regimes: timeframe === "4h"
      ? Object.freeze(regimeHistory(closed, swings))
      : structureRegimes,
    structureRegimes
  });
}

function levelsAt(
  timeframes: HistoricalTimeframes,
  executionIndex: number,
  analysisTime: number,
  signalOpenTime: number
): PriceLevel[] {
  const levels: PriceLevel[] = [];
  for (const timeframe of ["4h", "1h", "5m"] as const) {
    const data = timeframes[timeframe];
    const confirmedCount = upperBound(
      data.swings,
      timeframe === "5m" ? executionIndex : analysisTime,
      timeframe === "5m"
        ? (swing) => swing.confirmedIndex
        : (swing) => swing.confirmedAt
    );
    const eligible = data.swings
      .slice(0, confirmedCount)
      .filter((swing) => swing.openTime < signalOpenTime);
    for (const direction of ["high", "low"] as const) {
      const selected = eligible
        .filter((swing) => swing.direction === direction)
        .slice(-MAX_RECENT_SWINGS_PER_DIRECTION);
      for (const swing of selected) {
        levels.push({
          id: `${timeframe}:${swing.direction}:${swing.openTime}`,
          kind: swing.direction === "high" ? "swing_high" : "swing_low",
          price: swing.price,
          confirmedAt: swing.confirmedAt
        });
      }
    }
  }
  return levels;
}

function timeframeIndexAt(
  data: HistoricalTimeframe,
  timestamp: number
): number {
  return upperBound(data.candles, timestamp, (candle) => candle.closeTime) - 1;
}

function topDownBiasAt(
  timeframes: HistoricalTimeframes,
  timestamp: number
): TopDownBias | undefined {
  const bias: TopDownBias = {};
  for (const timeframe of TOP_DOWN_TIMEFRAMES) {
    const marketData = timeframes[TIMEFRAME_FOR_BIAS[timeframe]];
    const index = timeframeIndexAt(marketData, timestamp);
    if (index < 0) return undefined;
    bias[timeframe] = {
      regime: marketData.structureRegimes[index]!,
      availableAt: marketData.candles[index]!.closeTime
    };
  }
  return bias;
}

interface LifecycleLine {
  readonly lifecycle: TrendlineLifecycle;
  readonly line: Trendline;
}

function makeTrendline(
  lifecycle: TrendlineLifecycle,
  candles: readonly Candle[]
): Trendline {
  const confirmedAtIndex = candles.findIndex((candle) =>
    candle.closeTime === lifecycle.createdAt
  );
  const brokenAtIndex = lifecycle.brokenAt === null
    ? undefined
    : candles.findIndex((candle) => candle.closeTime === lifecycle.brokenAt);
  if (
    confirmedAtIndex < 0 ||
    (lifecycle.brokenAt !== null && (brokenAtIndex === undefined || brokenAtIndex < 0))
  ) {
    throw new Error(`Historical lifecycle ${lifecycle.id} references an unavailable candle`);
  }
  return Object.freeze({
    id: lifecycle.id,
    direction: lifecycle.direction,
    anchorA: Object.freeze({
      candleIndex: lifecycle.pointA.candleIndex,
      openTime: lifecycle.pointA.openTime,
      price: lifecycle.pointA.price
    }),
    anchorB: Object.freeze({
      candleIndex: lifecycle.pointB.candleIndex,
      openTime: lifecycle.pointB.openTime,
      price: lifecycle.pointB.price
    }),
    slope: lifecycle.slope,
    touchIndices: lifecycle.touchpoints.map(({ candleIndex }) => candleIndex),
    qualifyingTouchCount: lifecycle.qualifyingTouchCount,
    confirmedAtIndex,
    confirmedAtTime: lifecycle.createdAt,
    brokenAtIndex
  });
}

function currentTrendlines(
  candles: readonly Candle[],
  index: number
): LifecycleLine[] {
  const start = Math.max(0, index - TRENDLINE_LOOKBACK_BARS + 1);
  const window = candles.slice(start, index + 1);
  const swings = findConfirmedSwings(window, { leftBars: 2, rightBars: 2 });
  return buildTrendlineLifecycles(window, swings, {
    timeframe: "4h",
    minimumTouches: TRENDLINE_MINIMUM_TOUCHES,
    asOfIndex: window.length - 1,
    maximumTrendlines: 40
  }).map((lifecycle) => ({
    lifecycle,
    line: makeTrendline(lifecycle, window)
  }));
}

const trendlineHistoryCache = new WeakMap<
  HistoricalTimeframe,
  Map<number, LifecycleLine[]>
>();

function trendlinesAt(
  timeframe: HistoricalTimeframe,
  index: number
): LifecycleLine[] {
  let cache = trendlineHistoryCache.get(timeframe);
  if (!cache) {
    cache = new Map();
    trendlineHistoryCache.set(timeframe, cache);
  }
  const cached = cache.get(index);
  if (cached) return cached;
  const lines = currentTrendlines(timeframe.candles, index);
  cache.set(index, lines);
  return lines;
}

function lineAt(
  line: Trendline,
  timestamp: number
): number {
  const duration = line.anchorB.openTime - line.anchorA.openTime;
  if (duration <= 0) throw new Error(`Invalid historical trendline anchors: ${line.id}`);
  return line.anchorA.price +
    (line.anchorB.price - line.anchorA.price) *
    (timestamp - line.anchorA.openTime) / duration;
}

function backtestSetup(
  strategy: StrategyId,
  side: "buy" | "sell",
  signalTime: number,
  stopPrice: number
): BacktestSetup {
  return { strategy, side, signalTime, stopPrice };
}

export function createHistoricalEvaluator(
  symbol: string,
  strategy: StrategyId,
  timeframes: HistoricalTimeframes,
  variation?: EntryMode
): SignalEvaluator {
  const execution = timeframes["5m"].candles;
  if (strategy === "top_down_trendline") {
    if (!variation) throw new Error("Top-down historical evaluation requires an entry variation");
    return Object.assign((candles: readonly Candle[], index: number) => {
      const current = candles[index];
      if (!current) return undefined;
      const fourHourIndex = timeframeIndexAt(timeframes["4h"], current.closeTime);
      if (fourHourIndex < 0) return undefined;
      const cachedLines = trendlinesAt(timeframes["4h"], fourHourIndex);
      const bias = topDownBiasAt(timeframes, current.closeTime);
      if (!bias) return undefined;
      const executionWindow = execution.slice(Math.max(0, index - 12), index + 1);
      const signal = evaluateTopDownTrendline({
        symbol,
        mode: variation,
        executionCandles: executionWindow,
        fourHourTrendlines: cachedLines.map(({ line }) => line),
        higherTimeframeBias: bias
      });
      if (!signal) return undefined;

      const action = cachedLines.find(({ line }) => line.id === signal.trendlineId);
      if (!action) return undefined;
      const expectedBreakStatus = signal.side === "buy" ? "broken_above" : "broken_below";
      const actionConfirmed = variation === "bounce"
        ? action.lifecycle.isValid && action.lifecycle.breakStatus === "unbroken"
        : action.lifecycle.breakStatus === expectedBreakStatus &&
          action.lifecycle.brokenAt !== null &&
          action.lifecycle.brokenAt <= current.closeTime;
      if (!actionConfirmed) return undefined;

      const safety = cachedLines
        .filter(({ line, lifecycle }) =>
          line.direction !== action.line.direction &&
          lifecycle.isValid &&
          lifecycle.breakStatus === "unbroken"
        )
        .map((item) => ({ ...item, projected: lineAt(item.line, current.closeTime) }))
        .filter(({ projected }) =>
          signal.side === "buy"
            ? projected < Number(current.close)
            : projected > Number(current.close)
        )
        .sort((left, right) =>
          signal.side === "buy"
            ? right.projected - left.projected
            : left.projected - right.projected
        )[0];
      if (!safety) return undefined;
      const stopPrice = safety.projected * (
        signal.side === "buy"
          ? 1 - SAFETY_STOP_BUFFER_PERCENT / 100
          : 1 + SAFETY_STOP_BUFFER_PERCENT / 100
      );
      return backtestSetup(strategy, signal.side, current.closeTime, stopPrice);
    }, { historyMode: "indexed-full" as const });
  }

  const atrValues = atr(execution);
  return Object.assign((candles: readonly Candle[], index: number) => {
    const current = candles[index];
    if (!current) return undefined;
    const levels = levelsAt(timeframes, index, current.closeTime, current.openTime);
    if (strategy === "break_and_retest") {
      const setup = evaluateBreakAndRetestState({
        symbol,
        candles: execution.slice(Math.max(0, index - 12), index + 1),
        levels
      }).setup;
      return setup
        ? backtestSetup(strategy, setup.side, setup.signalCandle.closeTime, setup.stopLoss)
        : undefined;
    }
    if (strategy === "liquidity_sweep_reversal") {
      const fourHourIndex = timeframeIndexAt(timeframes["4h"], current.closeTime);
      const regime = fourHourIndex < 0
        ? "neutral"
        : timeframes["4h"].structureRegimes[fourHourIndex];
      const setup = evaluateLiquiditySweep({
        symbol,
        candles: execution.slice(index, index + 1),
        levels,
        higherTimeframeBias: regime ?? "neutral"
      });
      return setup
        ? backtestSetup(strategy, setup.side, setup.signalCandle.closeTime, setup.stopLoss)
        : undefined;
    }
    if (strategy === "order_block_retest") {
      const start = Math.max(0, index - 101);
      const setup = evaluateOrderBlockRetest({
        symbol,
        candles: execution.slice(start, index + 1),
        atrValues: atrValues.slice(start, index + 1)
      });
      return setup
        ? backtestSetup(strategy, setup.side, setup.signalCandle.closeTime, setup.stopLoss)
        : undefined;
    }
    throw new Error(`Unsupported historical strategy: ${strategy}`);
  }, { historyMode: "indexed-full" as const });
}

export interface HistoricalStrategyResult {
  readonly strategy: StrategyId;
  readonly variation?: EntryMode;
  readonly report: RegimeBreakdownResult;
}

export function validateHistoricalMarket(request: {
  readonly symbol: string;
  readonly timeframes: HistoricalTimeframes;
  readonly options: BacktestConfig;
  readonly warmupBars: number;
  readonly evaluationBars: number;
}): HistoricalStrategyResult[] {
  const strategies: readonly {
    readonly strategy: StrategyId;
    readonly variation?: EntryMode;
  }[] = [
    { strategy: "break_and_retest" },
    { strategy: "liquidity_sweep_reversal" },
    { strategy: "order_block_retest" },
    ...TOP_DOWN_VARIATIONS.map((variation) => ({
      strategy: "top_down_trendline" as const,
      variation
    }))
  ];
  return strategies.map(({ strategy, variation }) => {
    const evaluator = createHistoricalEvaluator(
      request.symbol,
      strategy,
      request.timeframes,
      variation
    );
    const report = runRegimeBreakdown({
      candles: request.timeframes["5m"].candles,
      options: { ...request.options, strategy },
      evaluateSignal: evaluator,
      validation: {
        warmupBars: request.warmupBars,
        evaluationBars: request.evaluationBars
      },
      regimeForCandle: (candle) => {
        const index = timeframeIndexAt(request.timeframes["4h"], candle.openTime);
        return index < 0
          ? "transition_uncertain"
          : request.timeframes["4h"].regimes[index]!;
      }
    });
    return {
      strategy,
      ...(variation === undefined ? {} : { variation }),
      report
    };
  });
}
