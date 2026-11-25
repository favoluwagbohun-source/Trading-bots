import type { Candle } from "@crypto-signal/shared";
import type { Trendline } from "@crypto-signal/indicators";

export const TOP_DOWN_TIMEFRAMES = ["1M", "1W", "1D", "4H", "1H"] as const;
export type TopDownTimeframe = (typeof TOP_DOWN_TIMEFRAMES)[number];
export type TradeSide = "buy" | "sell";
export type EntryMode = "break" | "bounce" | "retest";
export type DirectionalBias = "bullish" | "bearish" | "neutral";

export interface TimeframeBias {
  readonly regime: DirectionalBias;
  readonly availableAt: number;
}

export type TopDownBias = Partial<Record<TopDownTimeframe, TimeframeBias>>;

export interface TopDownOptions {
  readonly minimumAlignedTimeframes: number;
  readonly touchTolerancePercent: number;
  readonly retestLookbackCandles: number;
  readonly stopBufferPercent: number;
  readonly target1R: number;
  readonly target2R: number;
}

export interface TopDownContext {
  readonly symbol: string;
  readonly mode: EntryMode;
  readonly executionCandles: readonly Candle[];
  readonly fourHourTrendlines: readonly Trendline[];
  readonly higherTimeframeBias: TopDownBias;
  readonly options?: Partial<TopDownOptions>;
}

export interface TopDownSignal {
  readonly strategy: "top_down_trendline";
  readonly symbol: string;
  readonly side: TradeSide;
  readonly mode: EntryMode;
  readonly executionTimeframe: "5m";
  readonly higherTimeframeBias: Readonly<Record<TopDownTimeframe, DirectionalBias>>;
  readonly signalCandle: Candle;
  readonly trendlineId: string;
  readonly trendlinePrice: number;
  readonly minimumRiskReward: 2;
  readonly entryCandleOpenTime: number;
  readonly stopLoss: number;
}

export interface ActivatedTradePlan {
  readonly signal: TopDownSignal;
  readonly entryPrice: number;
  readonly entryTime: number;
  readonly stopLoss: number;
  readonly riskPerUnit: number;
  readonly target1: number;
  readonly target2: number;
  readonly target3: "trailing_runner";
  readonly target1R: number;
  readonly target2R: number;
  readonly minimumRiskReward: number;
}

const DEFAULT_OPTIONS: TopDownOptions = {
  minimumAlignedTimeframes: 5,
  touchTolerancePercent: 0.35,
  retestLookbackCandles: 12,
  stopBufferPercent: 0.1,
  target1R: 1.5,
  target2R: 3
};

function priceAtTime(line: Trendline, time: number): number {
  const duration = line.anchorB.openTime - line.anchorA.openTime;
  if (duration <= 0) throw new Error(`Invalid trendline anchors: ${line.id}`);
  return line.anchorA.price +
    ((line.anchorB.price - line.anchorA.price) / duration) *
    (time - line.anchorA.openTime);
}

function alignedBias(
  bias: TopDownBias,
  asOfTime: number,
  minimum: number
): { side: TradeSide; snapshot: Record<TopDownTimeframe, DirectionalBias> } | undefined {
  const snapshot = {} as Record<TopDownTimeframe, DirectionalBias>;
  let bullish = 0;
  let bearish = 0;

  for (const timeframe of TOP_DOWN_TIMEFRAMES) {
    const item = bias[timeframe];
    if (!item || item.availableAt > asOfTime) return undefined;
    snapshot[timeframe] = item.regime;
    if (item.regime === "bullish") bullish += 1;
    if (item.regime === "bearish") bearish += 1;
  }

  if (bullish >= minimum && bearish === 0) return { side: "buy", snapshot };
  if (bearish >= minimum && bullish === 0) return { side: "sell", snapshot };
  return undefined;
}

function matchesEntry(
  mode: EntryMode,
  side: TradeSide,
  line: Trendline,
  candles: readonly Candle[],
  index: number,
  lineAtClose: number,
  tolerancePercent: number,
  retestLookbackCandles: number
): boolean {
  const candle = candles[index]!;
  const close = Number(candle.close);
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const tolerance = Math.abs(lineAtClose) * tolerancePercent / 100;
  const previous = candles[index - 1];
  const previousLineAtClose = previous ? priceAtTime(line, previous.closeTime) : undefined;

  if (mode === "break") {
    if (!previous || previousLineAtClose === undefined) return false;
    if (side === "buy") {
      return line.direction === "descending" &&
        Number(previous.close) <= previousLineAtClose &&
        close > lineAtClose;
    }
    return line.direction === "ascending" &&
      Number(previous.close) >= previousLineAtClose &&
      close < lineAtClose;
  }

  if (mode === "bounce") {
    if (side === "buy") {
      return line.direction === "ascending" &&
        low <= lineAtClose + tolerance &&
        close > lineAtClose &&
        close > open;
    }
    return line.direction === "descending" &&
      high >= lineAtClose - tolerance &&
      close < lineAtClose &&
      close < open;
  }

  if (!previous || previousLineAtClose === undefined) return false;
  let recentBreakout = false;
  const firstPossibleBreakout = Math.max(1, index - retestLookbackCandles);
  for (let breakoutIndex = firstPossibleBreakout; breakoutIndex < index; breakoutIndex += 1) {
    const beforeBreak = candles[breakoutIndex - 1];
    const breakout = candles[breakoutIndex];
    if (!beforeBreak?.closed || !breakout?.closed) continue;
    const beforeLine = priceAtTime(line, beforeBreak.closeTime);
    const breakoutLine = priceAtTime(line, breakout.closeTime);
    if (side === "buy") {
      recentBreakout ||= Number(beforeBreak.close) <= beforeLine &&
        Number(breakout.close) > breakoutLine;
    } else {
      recentBreakout ||= Number(beforeBreak.close) >= beforeLine &&
        Number(breakout.close) < breakoutLine;
    }
  }
  if (!recentBreakout) return false;

  if (side === "buy") {
    return line.direction === "descending" &&
      Number(previous.close) > previousLineAtClose &&
      low <= lineAtClose + tolerance &&
      close > lineAtClose &&
      close > open;
  }
  return line.direction === "ascending" &&
    Number(previous.close) < previousLineAtClose &&
    high >= lineAtClose - tolerance &&
    close < lineAtClose &&
    close < open;
}

export function evaluateTopDownTrendline(
  context: TopDownContext
): TopDownSignal | undefined {
  const options = { ...DEFAULT_OPTIONS, ...context.options };
  if (
    !Number.isInteger(options.minimumAlignedTimeframes) ||
    options.minimumAlignedTimeframes < 1 ||
    options.minimumAlignedTimeframes > TOP_DOWN_TIMEFRAMES.length
  ) {
    throw new Error("minimumAlignedTimeframes must be between 1 and 5");
  }
  if (options.touchTolerancePercent < 0 || options.stopBufferPercent < 0) {
    throw new Error("Strategy tolerances cannot be negative");
  }
  if (!Number.isInteger(options.retestLookbackCandles) || options.retestLookbackCandles < 1) {
    throw new Error("retestLookbackCandles must be a positive integer");
  }
  if (options.target1R <= 0 || options.target1R >= options.target2R || options.target2R < 2) {
    throw new Error("Targets must be positive and TP2 must be at least 2R");
  }

  const candles = context.executionCandles;
  const index = candles.length - 1;
  const signalCandle = candles[index];
  if (!signalCandle?.closed || index < 1) return undefined;

  const alignment = alignedBias(
    context.higherTimeframeBias,
    signalCandle.closeTime,
    options.minimumAlignedTimeframes
  );
  if (!alignment) return undefined;

  const candidates = context.fourHourTrendlines
    .filter((line) =>
      line.confirmedAtTime <= signalCandle.closeTime &&
      line.anchorB.openTime < signalCandle.openTime
    )
    .sort((a, b) => b.confirmedAtTime - a.confirmedAtTime);

  for (const line of candidates) {
    const lineAtClose = priceAtTime(line, signalCandle.closeTime);
    if (!matchesEntry(
      context.mode,
      alignment.side,
      line,
      candles,
      index,
      lineAtClose,
      options.touchTolerancePercent,
      options.retestLookbackCandles
    )) continue;

    const stopBuffer = Number(signalCandle.low) * options.stopBufferPercent / 100;
    const stopLoss = alignment.side === "buy"
      ? Number(signalCandle.low) - stopBuffer
      : Number(signalCandle.high) + Number(signalCandle.high) * options.stopBufferPercent / 100;
    return {
      strategy: "top_down_trendline",
      symbol: context.symbol.trim().toUpperCase(),
      side: alignment.side,
      mode: context.mode,
      executionTimeframe: "5m",
      higherTimeframeBias: alignment.snapshot,
      signalCandle,
      trendlineId: line.id,
      trendlinePrice: lineAtClose,
      minimumRiskReward: 2,
      entryCandleOpenTime: signalCandle.closeTime + 1,
      stopLoss
    };
  }
  return undefined;
}

export function activateAtNextOpen(
  signal: TopDownSignal,
  nextCandle: Candle,
  requestedOptions: Partial<TopDownOptions> = {}
): ActivatedTradePlan {
  const options = { ...DEFAULT_OPTIONS, ...requestedOptions };
  if (options.target1R <= 0 || options.target1R >= options.target2R || options.target2R < 2) {
    throw new Error("Targets must be positive and TP2 must be at least 2R");
  }
  if (nextCandle.openTime !== signal.entryCandleOpenTime) {
    throw new Error("Entry candle must be the immediate next 5-minute candle");
  }

  const entryPrice = Number(nextCandle.open);
  const riskPerUnit = signal.side === "buy"
    ? entryPrice - signal.stopLoss
    : signal.stopLoss - entryPrice;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || riskPerUnit <= 0) {
    throw new Error("Next-candle open does not produce positive trade risk");
  }

  const direction = signal.side === "buy" ? 1 : -1;
  const target1 = entryPrice + direction * riskPerUnit * options.target1R;
  const target2 = entryPrice + direction * riskPerUnit * options.target2R;
  const minimumRiskReward = Math.abs(target2 - entryPrice) / riskPerUnit;
  if (minimumRiskReward < 2) {
    throw new Error("Trade plan does not meet the minimum 1:2 risk/reward");
  }

  return {
    signal,
    entryPrice,
    entryTime: nextCandle.openTime,
    stopLoss: signal.stopLoss,
    riskPerUnit,
    target1,
    target2,
    target3: "trailing_runner",
    target1R: options.target1R,
    target2R: options.target2R,
    minimumRiskReward
  };
}
