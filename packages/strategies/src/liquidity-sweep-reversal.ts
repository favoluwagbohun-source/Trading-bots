import type { Candle } from "@crypto-signal/shared";
import { createSetup, validateTolerance, type PriceLevel, type StrategySetup } from "./additional-types.js";

export interface LiquiditySweepOptions {
  readonly minimumSweepPercent: number;
  readonly stopBufferPercent: number;
}

export interface LiquiditySweepInput {
  readonly symbol: string;
  readonly candles: readonly Candle[];
  readonly levels: readonly PriceLevel[];
  readonly options?: Partial<LiquiditySweepOptions>;
}

const DEFAULT_OPTIONS: LiquiditySweepOptions = {
  minimumSweepPercent: 0,
  stopBufferPercent: 0.1
};

export function evaluateLiquiditySweep(
  input: LiquiditySweepInput
): StrategySetup | undefined {
  const options = { ...DEFAULT_OPTIONS, ...input.options };
  validateTolerance(options.minimumSweepPercent, "minimumSweepPercent");
  validateTolerance(options.stopBufferPercent, "stopBufferPercent");
  const candle = input.candles.at(-1);
  if (!candle?.closed) return undefined;

  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  for (const level of input.levels) {
    if (!Number.isFinite(level.price) || level.price <= 0 || level.confirmedAt > candle.openTime) {
      continue;
    }
    if (
      level.kind === "swing_low" &&
      low < level.price * (1 - options.minimumSweepPercent / 100) &&
      close > level.price &&
      close > open
    ) {
      return createSetup({
        strategy: "liquidity_sweep_reversal",
        symbol: input.symbol.trim().toUpperCase(),
        side: "buy",
        signalCandle: candle,
        stopLoss: low - low * options.stopBufferPercent / 100,
        reference: { kind: "level", price: level.price }
      });
    }
    if (
      level.kind === "swing_high" &&
      high > level.price * (1 + options.minimumSweepPercent / 100) &&
      close < level.price &&
      close < open
    ) {
      return createSetup({
        strategy: "liquidity_sweep_reversal",
        symbol: input.symbol.trim().toUpperCase(),
        side: "sell",
        signalCandle: candle,
        stopLoss: high + high * options.stopBufferPercent / 100,
        reference: { kind: "level", price: level.price }
      });
    }
  }
  return undefined;
}
