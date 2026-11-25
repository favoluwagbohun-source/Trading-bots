import type { Candle } from "@crypto-signal/shared";

function closes(candles: readonly Candle[]): number[] {
  return candles.map((candle) => Number(candle.close));
}

export function sma(candles: readonly Candle[], period: number): number[] {
  if (!Number.isInteger(period) || period < 1) throw new Error("SMA period must be positive");
  const values = closes(candles);
  return values.map((_, index) => {
    if (index + 1 < period) return Number.NaN;
    const window = values.slice(index + 1 - period, index + 1);
    return window.reduce((sum, value) => sum + value, 0) / period;
  });
}

export function ema(candles: readonly Candle[], period: number): number[] {
  if (!Number.isInteger(period) || period < 1) throw new Error("EMA period must be positive");
  const values = closes(candles);
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const result = Array<number>(values.length).fill(Number.NaN);
  result[period - 1] = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < values.length; index += 1) {
    const previous = result[index - 1];
    if (previous === undefined || Number.isNaN(previous)) return result;
    result[index] = (values[index]! - previous) * multiplier + previous;
  }
  return result;
}

export function atr(candles: readonly Candle[], period = 14): number[] {
  if (!Number.isInteger(period) || period < 1) throw new Error("ATR period must be positive");
  if (candles.length === 0) return [];
  const trueRanges = candles.map((candle, index) => {
    const high = Number(candle.high);
    const low = Number(candle.low);
    if (index === 0) return high - low;
    const previousClose = Number(candles[index - 1]!.close);
    return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  });
  const result = Array<number>(candles.length).fill(Number.NaN);
  if (candles.length < period) return result;
  result[period - 1] = trueRanges
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < candles.length; index += 1) {
    result[index] = (
      result[index - 1]! * (period - 1) + trueRanges[index]!
    ) / period;
  }
  return result;
}

export function rsi(candles: readonly Candle[], period = 14): number[] {
  if (!Number.isInteger(period) || period < 1) throw new Error("RSI period must be positive");
  const values = closes(candles);
  const result = Array<number>(values.length).fill(Number.NaN);
  if (values.length <= period) return result;

  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  result[period] = averageLoss === 0
    ? 100
    : 100 - 100 / (1 + averageGain / averageLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = averageLoss === 0
      ? 100
      : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}
