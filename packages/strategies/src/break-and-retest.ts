import type { Candle } from "@crypto-signal/shared";
import { createSetup, validateTolerance, type PriceLevel, type StrategySetup } from "./additional-types.js";

export interface BreakAndRetestOptions {
  readonly lookbackCandles: number;
  readonly retestTolerancePercent: number;
  readonly stopBufferPercent: number;
}

export interface BreakAndRetestInput {
  readonly symbol: string;
  readonly candles: readonly Candle[];
  readonly levels: readonly PriceLevel[];
  readonly options?: Partial<BreakAndRetestOptions>;
}

export interface BreakAndRetestEvaluation {
  readonly state: "no_break" | "awaiting_retest" | "invalidated" | "retest_confirmed";
  readonly levelId?: string;
  readonly setup?: StrategySetup;
}

const DEFAULT_OPTIONS: BreakAndRetestOptions = {
  lookbackCandles: 12,
  retestTolerancePercent: 0.25,
  stopBufferPercent: 0.1
};

export function evaluateBreakAndRetestState(
  input: BreakAndRetestInput
): BreakAndRetestEvaluation {
  const options = { ...DEFAULT_OPTIONS, ...input.options };
  if (!Number.isInteger(options.lookbackCandles) || options.lookbackCandles < 1) {
    throw new Error("lookbackCandles must be a positive integer");
  }
  validateTolerance(options.retestTolerancePercent, "retestTolerancePercent");
  validateTolerance(options.stopBufferPercent, "stopBufferPercent");

  const candles = input.candles;
  const currentIndex = candles.length - 1;
  const current = candles[currentIndex];
  if (!current?.closed || currentIndex < 2) return { state: "no_break" };
  const firstBreakIndex = Math.max(1, currentIndex - options.lookbackCandles);
  let invalidatedLevel: string | undefined;
  let awaitingLevel: string | undefined;

  for (const level of input.levels) {
    if (!Number.isFinite(level.price) || level.price <= 0) continue;
    const side = level.kind === "swing_high" ? "buy" : "sell";
    let breakIndex = -1;
    for (let index = firstBreakIndex; index < currentIndex; index += 1) {
      const before = candles[index - 1];
      const breakout = candles[index];
      if (!before?.closed || !breakout?.closed || level.confirmedAt > before.closeTime) continue;
      const crossed = side === "buy"
        ? Number(before.close) <= level.price && Number(breakout.close) > level.price
        : Number(before.close) >= level.price && Number(breakout.close) < level.price;
      if (crossed) breakIndex = index;
    }
    if (breakIndex < 0) continue;

    let invalidated = false;
    for (let index = breakIndex + 1; index < currentIndex; index += 1) {
      const candle = candles[index];
      if (!candle?.closed) continue;
      if (side === "buy" ? Number(candle.close) <= level.price : Number(candle.close) >= level.price) {
        invalidated = true;
        break;
      }
    }
    if (
      !invalidated &&
      (side === "buy"
        ? Number(current.close) <= level.price
        : Number(current.close) >= level.price)
    ) {
      invalidated = true;
    }
    if (invalidated) {
      invalidatedLevel = level.id;
      continue;
    }

    const tolerance = level.price * options.retestTolerancePercent / 100;
    const touched = side === "buy"
      ? Number(current.low) <= level.price + tolerance &&
        Number(current.close) > level.price &&
        Number(current.close) > Number(current.open)
      : Number(current.high) >= level.price - tolerance &&
        Number(current.close) < level.price &&
        Number(current.close) < Number(current.open);
    if (!touched) {
      awaitingLevel = level.id;
      continue;
    }

    const buffer = (side === "buy" ? Number(current.low) : Number(current.high)) *
      options.stopBufferPercent / 100;
    return {
      state: "retest_confirmed",
      levelId: level.id,
      setup: createSetup({
        strategy: "break_and_retest",
        symbol: input.symbol.trim().toUpperCase(),
        side,
        signalCandle: current,
        stopLoss: side === "buy"
          ? Number(current.low) - buffer
          : Number(current.high) + buffer,
        reference: { kind: "level", price: level.price }
      })
    };
  }
  if (awaitingLevel) return { state: "awaiting_retest", levelId: awaitingLevel };
  if (invalidatedLevel) return { state: "invalidated", levelId: invalidatedLevel };
  return { state: "no_break" };
}

export function evaluateBreakAndRetest(
  input: BreakAndRetestInput
): StrategySetup | undefined {
  return evaluateBreakAndRetestState(input).setup;
}
