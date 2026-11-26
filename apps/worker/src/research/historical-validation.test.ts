import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { prepareHistoricalTimeframe } from "./historical-validation.js";

function candle(index: number, high: number, low: number, closed = true): Candle {
  const openTime = index * 300_000;
  return {
    openTime,
    closeTime: openTime + 299_999,
    open: String((high + low) / 2),
    high: String(high),
    low: String(low),
    close: String((high + low) / 2),
    volume: "1",
    closed
  };
}

describe("prepareHistoricalTimeframe", () => {
  it("uses only confirmed swings and excludes unfinished candles", () => {
    const history = prepareHistoricalTimeframe([
      candle(0, 11, 9),
      candle(1, 12, 8),
      candle(2, 20, 7),
      candle(3, 13, 6),
      candle(4, 12, 1),
      candle(5, 11, 5),
      candle(6, 10, 6),
      candle(7, 100, 0, false)
    ], "5m");

    expect(history.candles).toHaveLength(7);
    expect(history.structureRegimes.slice(0, 6)).toEqual([
      "neutral",
      "neutral",
      "neutral",
      "neutral",
      "neutral",
      "neutral"
    ]);
    expect(history.structureRegimes[6]).toBe("bearish");
  });
});
