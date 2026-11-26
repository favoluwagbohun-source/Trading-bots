import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { MarketAnalysisOrchestrator } from "./market-analysis.js";

function candle(
  openTime: number,
  closeTime: number,
  values: { open?: number; high?: number; low?: number; close?: number } = {},
  closed = true
): Candle {
  return {
    openTime,
    closeTime,
    open: String(values.open ?? 100),
    high: String(values.high ?? 102),
    low: String(values.low ?? 99),
    close: String(values.close ?? 101),
    volume: "10",
    closed
  };
}

describe("MarketAnalysisOrchestrator", () => {
  it("synchronizes each timeframe independently to the latest closed 5-minute analysis time", () => {
    const execution = [
      candle(300_000, 599_999),
      candle(600_000, 899_999),
      candle(900_000, 1_199_999, {}, false)
    ];
    const fourHour = [
      candle(0, 899_999),
      candle(900_000, 1_799_999, {}, false),
      candle(1_800_000, 2_699_999, {}, true)
    ];
    const source = new Map([
      ["5m", execution],
      ["4h", fourHour]
    ]);

    const result = new MarketAnalysisOrchestrator().analyze("btcusdt", source);

    expect(result?.snapshot.snapshotId).toBe("BTCUSDT:5m:600000");
    expect(result?.snapshot.analysisTime).toBe(899_999);
    expect(result?.snapshot.timeframes["5m"].candles.map(({ openTime }) => openTime))
      .toEqual([300_000, 600_000]);
    expect(result?.snapshot.timeframes["4h"].candles.map(({ openTime }) => openTime))
      .toEqual([0]);
    expect(result?.snapshot.timeframes["4h"].availableAt).toBe(899_999);
    expect(result?.snapshot.timeframes["1h"].availableAt).toBeNull();
    expect(result?.snapshot.nextExecutionCandle?.openTime).toBe(900_000);
    expect(result?.snapshot.nextExecutionCandle?.closed).toBe(false);
    expect(result?.evaluations).toHaveLength(6);
    expect(result?.evaluations.every(({ status }) => status === "rejected")).toBe(true);
  });

  it("preserves an immutable candle snapshot and does not include future closed candles", () => {
    const execution = [
      candle(0, 299_999),
      candle(300_000, 599_999),
      candle(600_000, 899_999),
      candle(900_000, 1_199_999, {}, false)
    ];
    const source = new Map([
      ["5m", execution],
      ["1d", [candle(0, 500_000), candle(500_001, 999_999)]]
    ]);

    const result = new MarketAnalysisOrchestrator().analyze("BTCUSDT", source);

    expect(result?.snapshot.timeframes["5m"].candles).toHaveLength(3);
    expect(result?.snapshot.timeframes["1d"].candles).toHaveLength(1);
    expect(Object.isFrozen(result?.snapshot)).toBe(true);
    expect(Object.isFrozen(result?.snapshot.timeframes["5m"].candles)).toBe(true);
    expect(Object.isFrozen(result?.snapshot.signalCandle)).toBe(true);
    expect(() => {
      result!.snapshot.timeframes["5m"].candles[0]!.close = "999";
    }).toThrow();
    expect(execution[2]!.close).toBe("101");
  });

  it("rejects malformed or unordered timeframe candles", () => {
    const orchestrator = new MarketAnalysisOrchestrator();
    expect(() => orchestrator.analyze("BTCUSDT", new Map([
      ["5m", [candle(300_000, 599_999), candle(0, 299_999)]]
    ]))).toThrow("strictly ascending");

    expect(() => orchestrator.analyze("BTCUSDT", new Map([
      ["5m", [candle(0, 299_999, { high: 98 })]]
    ]))).toThrow("Invalid 5m market candle");

    expect(() => orchestrator.analyze("BTCUSDT", new Map([
      ["5m", [candle(0, 299_999, {}, true)]],
      ["1h", [{ ...candle(0, 3_599_999), volume: "not-a-number" }]]
    ]))).toThrow("Invalid 1h market candle");
  });
});
