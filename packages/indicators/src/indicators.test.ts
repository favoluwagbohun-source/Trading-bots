import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { atr, ema, rsi, sma } from "./indicators.js";

function candle(index: number, close: number): Candle {
  const openTime = index * 60_000;
  return {
    openTime,
    closeTime: openTime + 59_999,
    open: String(close - 1),
    high: String(close + 2),
    low: String(close - 2),
    close: String(close),
    volume: "10",
    closed: true
  };
}

describe("confirmed-candle indicators", () => {
  it("calculates SMA without lookahead", () => {
    const candles = [1, 2, 3, 4].map((close, index) => candle(index, close));
    expect(sma(candles, 3)).toEqual([Number.NaN, Number.NaN, 2, 3]);
  });

  it("calculates EMA", () => {
    const candles = [1, 2, 3, 4].map((close, index) => candle(index, close));
    expect(ema(candles, 3)).toEqual([Number.NaN, Number.NaN, 2, 3]);
  });

  it("calculates ATR", () => {
    const candles = [100, 102, 101, 103, 105].map((close, index) => candle(index, close));
    const result = atr(candles, 3);
    expect(result).toHaveLength(5);
    expect(result[2]).toBeGreaterThan(0);
  });

  it("calculates bounded RSI", () => {
    const candles = [100, 102, 101, 103, 105, 106].map((close, index) => candle(index, close));
    const result = rsi(candles, 3);
    expect(result.every((value) => Number.isNaN(value) || (value >= 0 && value <= 100))).toBe(true);
  });
});
