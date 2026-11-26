import type { Candle } from "@crypto-signal/shared";
import {
  createSetup,
  validateTolerance,
  type StrategySetup
} from "./additional-types.js";

export interface OrderBlockOptions {
  readonly displacementAtrMultiple: number;
  readonly maximumZoneAgeCandles: number;
  readonly stopBufferPercent: number;
  readonly invalidationMode: "close" | "wick";
}

export interface OrderBlockInput {
  readonly symbol: string;
  readonly candles: readonly Candle[];
  readonly atrValues: readonly number[];
  readonly options?: Partial<OrderBlockOptions>;
}

const DEFAULT_OPTIONS: OrderBlockOptions = {
  displacementAtrMultiple: 2,
  maximumZoneAgeCandles: 100,
  stopBufferPercent: 0.1,
  invalidationMode: "close"
};

export function evaluateOrderBlockRetest(
  input: OrderBlockInput
): StrategySetup | undefined {
  const options = { ...DEFAULT_OPTIONS, ...input.options };
  if (!Number.isFinite(options.displacementAtrMultiple) || options.displacementAtrMultiple <= 0) {
    throw new Error("displacementAtrMultiple must be positive");
  }
  if (!Number.isInteger(options.maximumZoneAgeCandles) || options.maximumZoneAgeCandles < 1) {
    throw new Error("maximumZoneAgeCandles must be a positive integer");
  }
  if (options.invalidationMode !== "close" && options.invalidationMode !== "wick") {
    throw new Error("invalidationMode must be close or wick");
  }
  validateTolerance(options.stopBufferPercent, "stopBufferPercent");
  if (input.atrValues.length !== input.candles.length) {
    throw new Error("ATR values must align with candle indexes");
  }

  const candles = input.candles;
  const currentIndex = candles.length - 1;
  const current = candles[currentIndex];
  if (!current?.closed || currentIndex < 2) return undefined;

  for (
    let displacementIndex = currentIndex - 1;
    displacementIndex >= Math.max(1, currentIndex - options.maximumZoneAgeCandles);
    displacementIndex -= 1
  ) {
    const block = candles[displacementIndex - 1]!;
    const displacement = candles[displacementIndex]!;
    if (!block.closed || !displacement.closed) continue;
    const atr = input.atrValues[displacementIndex]!;
    if (!Number.isFinite(atr) || atr <= 0) continue;

    const displacementDirection = Number(displacement.close) > Number(displacement.open)
      ? "buy"
      : Number(displacement.close) < Number(displacement.open)
        ? "sell"
        : undefined;
    if (!displacementDirection) continue;
    const blockOpposes = displacementDirection === "buy"
      ? Number(block.close) < Number(block.open)
      : Number(block.close) > Number(block.open);
    const body = Math.abs(Number(displacement.close) - Number(displacement.open));
    if (!blockOpposes || body < atr * options.displacementAtrMultiple) continue;

    const zoneLow = Number(block.low);
    const zoneHigh = Number(block.high);
    let invalidated = false;
    for (let index = displacementIndex + 1; index < currentIndex; index += 1) {
      const between = candles[index]!;
      if (!between.closed) continue;
      if (
        displacementDirection === "buy"
          ? options.invalidationMode === "close"
            ? Number(between.close) < zoneLow
            : Number(between.low) < zoneLow
          : options.invalidationMode === "close"
            ? Number(between.close) > zoneHigh
            : Number(between.high) > zoneHigh
      ) {
        invalidated = true;
        break;
      }
    }
    if (invalidated) continue;

    const overlapsZone =
      Number(current.low) <= zoneHigh &&
      Number(current.high) >= zoneLow;
    const confirms = displacementDirection === "buy"
      ? Number(current.close) > zoneHigh && Number(current.close) > Number(current.open)
      : Number(current.close) < zoneLow && Number(current.close) < Number(current.open);
    if (!overlapsZone || !confirms) continue;

    const side = displacementDirection;
    const buffer = (side === "buy" ? Number(current.low) : Number(current.high)) *
      options.stopBufferPercent / 100;
    return createSetup({
      strategy: "order_block_retest",
      symbol: input.symbol.trim().toUpperCase(),
      side,
      signalCandle: current,
      stopLoss: side === "buy"
        ? Number(current.low) - buffer
        : Number(current.high) + buffer,
      reference: { kind: "zone", low: zoneLow, high: zoneHigh }
    });
  }
  return undefined;
}
