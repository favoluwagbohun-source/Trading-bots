import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { buildTrendlineLifecycles } from "./trendline-lifecycle.js";
import type { SwingPoint } from "./types.js";

function candle(index: number, low: number, high: number, close: number): Candle {
  const openTime = index * 300_000;
  return {
    openTime,
    closeTime: openTime + 299_999,
    open: String(close),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: "10",
    closed: true
  };
}

function swing(index: number, price: number, confirmedIndex: number): SwingPoint {
  return {
    direction: "low",
    index,
    openTime: index * 300_000,
    price,
    confirmedIndex,
    confirmedAt: confirmedIndex * 300_000 + 299_999
  };
}

describe("progressive trendline lifecycle", () => {
  it("uses each preceding Point B as the next Point A and records later touchpoints", () => {
    const candles = [
      candle(0, 10, 10.1, 10),
      candle(1, 11, 11.2, 11.1),
      candle(2, 12, 12.1, 12),
      candle(3, 13, 13.2, 13.1),
      candle(4, 14, 14.1, 14),
      candle(5, 15, 15.2, 15.1),
      candle(6, 16, 16.1, 16)
    ];
    const swings = [swing(0, 10, 0), swing(2, 12, 2), swing(4, 14, 4), swing(6, 16, 6)];
    const lines = buildTrendlineLifecycles(candles, swings, {
      timeframe: "4h",
      minimumTouches: 3
    });

    expect(lines.map(({ pointA, pointB }) => [pointA.candleIndex, pointB.candleIndex]))
      .toEqual([[0, 2], [2, 4]]);
    expect(lines[0]).toMatchObject({
      timeframe: "4h",
      direction: "ascending",
      qualifyingTouchCount: 4,
      isValid: true,
      breakStatus: "unbroken"
    });
    expect(lines[0]!.touchpoints.map(({ candleIndex }) => candleIndex))
      .toEqual([0, 2, 4, 6]);
    expect(lines[0]!.createdAt).toBe(candles[2]!.closeTime);
  });

  it("records a confirmed structural break and invalidates the line", () => {
    const candles = [
      candle(0, 10, 10.1, 10),
      candle(1, 11, 11.2, 11.1),
      candle(2, 12, 12.1, 12),
      candle(3, 13, 13.2, 13.1),
      candle(4, 14, 14.1, 14),
      candle(5, 15, 15.2, 15.1),
      candle(6, 12, 13, 12.5)
    ];
    const lines = buildTrendlineLifecycles(
      candles,
      [swing(0, 10, 0), swing(2, 12, 2), swing(4, 14, 4)],
      { timeframe: "4h", minimumTouches: 3 }
    );

    expect(lines[0]).toMatchObject({
      isValid: false,
      breakStatus: "broken_below",
      brokenAt: candles[6]!.closeTime
    });
    expect(lines[0]!.structuralViolationIndices).toContain(6);
  });

  it("requires validated point progression and enough distinct touches", () => {
    const candles = [
      candle(0, 9.9, 10.1, 10),
      candle(1, 10.2, 11.1, 10.8),
      candle(2, 9.9, 10.1, 10)
    ];
    expect(buildTrendlineLifecycles(
      candles,
      [swing(0, 10, 0), swing(2, 9, 2)],
      { timeframe: "1d" }
    )).toEqual([]);
    expect(buildTrendlineLifecycles(
      candles,
      [swing(0, 10, 0), swing(2, 12, 2)],
      { timeframe: "1d" }
    )).toEqual([]);
  });

  it("invalidates structure breached before Point B confirmation", () => {
    const candles = [
      candle(0, 10, 10.1, 10),
      candle(1, 10.5, 11, 10.7),
      candle(2, 12, 12.1, 12)
    ];
    const lines = buildTrendlineLifecycles(
      candles,
      [swing(0, 10, 0), swing(2, 12, 2)],
      { timeframe: "4h", minimumTouches: 2 }
    );

    expect(lines[0]!.isValid).toBe(false);
    expect(lines[0]!.structuralViolationIndices).toContain(1);
  });
});
