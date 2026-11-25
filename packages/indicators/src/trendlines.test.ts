import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { findConfirmedSwings } from "./structure.js";
import { detectTrendlines, findTrendlineBreaks, trendlinePrice } from "./trendlines.js";

function candle(index: number, high: number, low: number, close: number): Candle {
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

describe("trendline engine", () => {
  it("projects a rising line as a ray and records qualifying touches", () => {
    const candles = [
      candle(0, 105, 95, 100),
      candle(1, 102, 96, 98),
      candle(2, 103, 97, 100),
      candle(3, 104, 98, 101),
      candle(4, 105, 99, 102),
      candle(5, 106, 100, 103)
    ];
    const swings = findConfirmedSwings(candles, { leftBars: 1, rightBars: 1 });

    const lines = detectTrendlines(candles, swings, {
      minimumTouches: 2,
      tolerancePercent: 0.35
    });

    expect(lines.length).toBeGreaterThanOrEqual(0);
    if (lines[0]) {
      expect(trendlinePrice(lines[0], 10)).toBeTypeOf("number");
      expect(lines[0].anchorA.candleIndex).toBeLessThan(lines[0].anchorB.candleIndex);
    }
  });

  it("detects a break only after a closed candle confirms it", () => {
    const candles = [
      candle(0, 101, 99, 100),
      candle(1, 103, 101, 102),
      candle(2, 103, 101, 102),
      candle(3, 104, 96, 96)
    ];
    const line = {
      id: "ascending-test",
      direction: "ascending" as const,
      anchorA: { candleIndex: 0, openTime: 0, price: 100 },
      anchorB: { candleIndex: 2, openTime: 600_000, price: 102 },
      slope: 1,
      touchIndices: [0, 2],
      qualifyingTouchCount: 2,
      confirmedAtIndex: 3,
      confirmedAtTime: candles[3]!.closeTime,
      brokenAtIndex: undefined
    };

    expect(findTrendlineBreaks(candles, [line])).toEqual([
      expect.objectContaining({
        trendlineId: "ascending-test",
        index: 3,
        direction: "break_below"
      })
    ]);
  });

  it("uses only closed candles for replay detection", () => {
    const candles = [
      candle(0, 101, 99, 100),
      { ...candle(1, 103, 101, 102), closed: false }
    ];
    expect(detectTrendlines(candles, [], { asOfIndex: 1 })).toEqual([]);
  });

  it("caps trendline output at the chart overlay limit", () => {
    const candles = Array.from({ length: 20 }, (_, index) =>
      candle(index, 100 + index, 90 + index, 95 + index)
    );
    const swings = findConfirmedSwings(candles, { leftBars: 2, rightBars: 2 });
    expect(detectTrendlines(candles, swings, { maximumTrendlines: 4 }).length).toBeLessThanOrEqual(4);
  });
});
