import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { classifyMarketStructure, findConfirmedSwings } from "./structure.js";

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

describe("market structure", () => {
  it("requires right-hand candles before confirming a swing", () => {
    const candles = [
      candle(0, 102, 98, 100),
      candle(1, 110, 100, 108),
      candle(2, 104, 96, 102),
      candle(3, 103, 95, 99)
    ];

    expect(findConfirmedSwings(candles, { leftBars: 1, rightBars: 1 })).toEqual([
      expect.objectContaining({ direction: "high", index: 1, confirmedIndex: 2 })
    ]);
  });

  it("does not expose swings confirmed after the replay index", () => {
    const candles = [
      candle(0, 102, 98, 100),
      candle(1, 110, 100, 108),
      candle(2, 104, 96, 102),
      candle(3, 103, 95, 99)
    ];
    const swings = findConfirmedSwings(candles, { leftBars: 1, rightBars: 1 });
    const asOf = classifyMarketStructure(candles, swings, 1);

    expect(asOf.latestHigh).toBeUndefined();
  });

  it("ignores unfinished candles", () => {
    const closed = candle(0, 102, 98, 100);
    const unfinished = { ...candle(1, 110, 100, 108), closed: false };
    expect(findConfirmedSwings([closed, unfinished], { leftBars: 1, rightBars: 1 }))
      .toEqual([]);
  });
});
