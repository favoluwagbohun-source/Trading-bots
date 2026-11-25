import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { ReplayAnnotations } from "./annotations.js";
import { CandleReplaySession } from "./replay-session.js";

const candle: Candle = {
  openTime: 5_000_000,
  closeTime: 5_299_999,
  open: "100",
  high: "102",
  low: "98",
  close: "101",
  volume: "10",
  closed: true
};

describe("replay annotations", () => {
  it("stores manual trendlines, levels, and zones within visible history", () => {
    const replay = new CandleReplaySession({
      symbol: "BTCUSDT",
      timeframe: "5m",
      candles: [candle]
    });
    const annotations = new ReplayAnnotations(replay);

    annotations.addTrendline({
      id: "line-1",
      startTime: 5_000_000,
      startPrice: 99,
      endTime: 5_100_000,
      endPrice: 100
    });
    annotations.addHorizontalLevel({
      id: "level-1",
      price: 105,
      createdAt: 5_299_999,
      label: "resistance"
    });
    annotations.addZone({
      id: "demand-1",
      direction: "demand",
      low: 95,
      high: 98,
      startTime: 5_000_000
    });

    expect(annotations.snapshot().map((item) => item.kind)).toEqual([
      "trendline",
      "horizontal_level",
      "zone"
    ]);
  });

  it("rejects future references and duplicate annotation IDs", () => {
    const replay = new CandleReplaySession({
      symbol: "BTCUSDT",
      timeframe: "5m",
      candles: [candle]
    });
    const annotations = new ReplayAnnotations(replay);
    annotations.addHorizontalLevel({
      id: "level-1",
      price: 105,
      createdAt: candle.closeTime
    });
    expect(() => annotations.addHorizontalLevel({
      id: "level-1",
      price: 106,
      createdAt: candle.closeTime
    })).toThrow("Duplicate");
    expect(() => annotations.addTrendline({
      id: "future-line",
      startTime: candle.openTime,
      startPrice: 99,
      endTime: candle.closeTime + 1,
      endPrice: 100
    })).toThrow("future replay timestamp");
    expect(() => annotations.addZone({
      id: "future-zone",
      direction: "supply",
      low: 105,
      high: 110,
      startTime: candle.openTime,
      endTime: candle.closeTime + 1
    })).toThrow("future replay timestamp");
  });
});
