import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import {
  endOfUtcDay,
  formatHealthLabel,
  formatPrice,
  formatTimeframeLabel,
  formatVolume,
  isMarketTimeframe,
  mergeCandles,
  normalizeChartSymbol,
  startOfUtcDay,
  summarizeTopDownAlignment
} from "./chart-state.js";

function candle(openTime: number, close: string): Candle {
  return {
    openTime,
    closeTime: openTime + 299_999,
    open: "100",
    high: "105",
    low: "95",
    close,
    volume: "10",
    closed: true
  };
}

describe("chart-state helpers", () => {
  it("merges and sorts candles by openTime without duplicates", () => {
    const merged = mergeCandles(
      [candle(600_000, "102"), candle(300_000, "101")],
      [candle(600_000, "103"), candle(900_000, "104")]
    );
    expect(merged.map((item) => [item.openTime, item.close])).toEqual([
      [300_000, "101"],
      [600_000, "103"],
      [900_000, "104"]
    ]);
  });

  it("validates market symbols, timeframes, and UTC day boundaries", () => {
    expect(normalizeChartSymbol(" btcusdt ")).toBe("BTCUSDT");
    expect(normalizeChartSymbol("BTC")).toBeNull();
    expect(isMarketTimeframe("5m")).toBe(true);
    expect(isMarketTimeframe("1M")).toBe(true);
    expect(isMarketTimeframe("2h")).toBe(false);
    expect(formatTimeframeLabel("1m")).toBe("1m");
    expect(formatTimeframeLabel("5m")).toBe("5m");
    expect(formatTimeframeLabel("1d")).toBe("1D");
    expect(formatTimeframeLabel("1M")).toBe("1M");
    expect(formatPrice("96420.5")).toBe("96,420.50");
    expect(formatVolume(1_520_000)).toBe("1.52M");
    expect(startOfUtcDay("2026-01-15")).toBe(Date.parse("2026-01-15T00:00:00.000Z"));
    expect(endOfUtcDay("2026-01-15")).toBe(Date.parse("2026-01-15T23:59:59.999Z"));
  });

  it("summarizes multi-timeframe alignment and health labels", () => {
    const summary = summarizeTopDownAlignment([
      {
        timeframe: "1M",
        availableAt: 1000,
        regime: "bullish",
        volatilityRegime: "normal",
        trendStrength: 0.7,
        latestHigh: 100,
        latestLow: 80,
        candleCount: 50
      },
      {
        timeframe: "1w",
        availableAt: 1000,
        regime: "bullish",
        volatilityRegime: "normal",
        trendStrength: 0.6,
        latestHigh: 100,
        latestLow: 90,
        candleCount: 50
      },
      {
        timeframe: "5m",
        availableAt: 1000,
        regime: "bearish",
        volatilityRegime: "high",
        trendStrength: 0.4,
        latestHigh: 98,
        latestLow: 95,
        candleCount: 50
      }
    ]);
    expect(summary).toEqual({
      bullishCount: 2,
      bearishCount: 1,
      neutralCount: 0,
      dominantRegime: "bullish",
      alignedCount: 2,
      totalAvailable: 3
    });
    expect(summarizeTopDownAlignment([
      {
        timeframe: "1M",
        availableAt: 1000,
        regime: "bearish",
        volatilityRegime: "high",
        trendStrength: 0.7,
        latestHigh: 100,
        latestLow: 80,
        candleCount: 50
      },
      {
        timeframe: "1w",
        availableAt: 1000,
        regime: "bullish",
        volatilityRegime: "normal",
        trendStrength: 0.6,
        latestHigh: 100,
        latestLow: 90,
        candleCount: 50
      }
    ]).dominantRegime).toBe("mixed");
    expect(formatHealthLabel("HEALTHY")).toBe("Healthy");
    expect(formatHealthLabel("SLEEPING")).toBe("Idle / No Heartbeat");
  });
});
