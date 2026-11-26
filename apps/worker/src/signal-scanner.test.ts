import { describe, expect, it, vi } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { SignalScanner } from "./signal-scanner.js";

const TIMEFRAMES = ["1M", "1w", "1d", "4h", "1h", "5m"] as const;

function candle(
  index: number,
  values: { open: number; high: number; low: number; close: number },
  closed = true
): Candle {
  const openTime = 2_000_000 + index * 300_000;
  return {
    openTime,
    closeTime: openTime + 299_999,
    open: String(values.open),
    high: String(values.high),
    low: String(values.low),
    close: String(values.close),
    volume: "10",
    closed
  };
}

describe("SignalScanner", () => {
  it("requests every strategy timeframe and does not scan an unfinished execution candle", async () => {
    const requested: string[] = [];
    const getHistoricalKlines = vi.fn(async ({ timeframe }: { timeframe: string }) => {
      requested.push(timeframe);
      if (timeframe === "5m") {
        return [
          candle(0, { open: 100, high: 101, low: 99, close: 100 }),
          candle(1, { open: 100, high: 101, low: 99, close: 100 }),
          candle(2, { open: 100, high: 101, low: 99, close: 100 }, false)
        ];
      }
      return [];
    });
    const onCandidate = vi.fn();
    const onError = vi.fn();
    const onCandles = vi.fn();
    const scanner = new SignalScanner({
      symbols: ["btcusdt", "BTCUSDT"],
      client: { getHistoricalKlines },
      scanIntervalMs: 30_000,
      onCandidate,
      onError,
      onCandles
    });

    await expect(scanner.scanOnce()).resolves.toEqual([]);
    expect(requested).toEqual(TIMEFRAMES);
    expect(onCandidate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onCandles).toHaveBeenCalledWith("BTCUSDT", [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 100, high: 101, low: 99, close: 100 }),
      candle(2, { open: 100, high: 101, low: 99, close: 100 }, false)
    ]);
  });

  it("emits independently evaluated candidates once and keeps future entry candles out of the chart snapshot", async () => {
    const executionCandles = [
      candle(0, { open: 9, high: 9.8, low: 8, close: 9 }),
      candle(1, { open: 9, high: 9.7, low: 8.5, close: 9.2 }),
      candle(2, { open: 9.1, high: 10, low: 8.4, close: 9 }),
      candle(3, { open: 9, high: 9.5, low: 8.6, close: 9 }),
      candle(4, { open: 9, high: 9.6, low: 8.7, close: 9 }),
      candle(5, { open: 9, high: 11.2, low: 8.9, close: 11 }),
      candle(6, { open: 11, high: 11.5, low: 10.8, close: 11.2 }),
      candle(7, { open: 11.2, high: 11.5, low: 10.9, close: 11.1 }),
      candle(8, { open: 10.1, high: 11, low: 9.9, close: 10.5 }),
      candle(9, { open: 10.5, high: 10.8, low: 10.4, close: 10.6 }, false)
    ];
    const getHistoricalKlines = vi.fn(async ({ timeframe }: { timeframe: string }) => {
      if (timeframe === "1h") throw new Error("Higher timeframe unavailable");
      return timeframe === "5m" ? executionCandles : [];
    });
    const onCandidate = vi.fn();
    const onError = vi.fn();
    const scanner = new SignalScanner({
      symbols: ["BTCUSDT"],
      client: { getHistoricalKlines },
      scanIntervalMs: 30_000,
      onCandidate,
      onError
    });

    const firstScan = await scanner.scanOnce();
    expect(onError).toHaveBeenCalledWith(
      "BTCUSDT",
      expect.objectContaining({ message: expect.stringContaining("1h") })
    );
    expect(firstScan).toHaveLength(1);
    expect(firstScan[0]).toMatchObject({
      strategy: "break_and_retest",
      symbol: "BTCUSDT",
      entryCandleOpenTime: executionCandles[9]!.openTime,
      entryPrice: 10.5
    });
    expect(firstScan[0]!.chartCandles.at(-1)).toEqual(executionCandles[8]);
    expect(firstScan[0]!.chartCandles).toBe(
      firstScan[0]!.analysisSnapshot.timeframes["5m"].candles
    );
    expect(firstScan[0]!.signalCandle).toBe(
      firstScan[0]!.analysisSnapshot.signalCandle
    );
    expect(Object.isFrozen(firstScan[0]!.analysisSnapshot)).toBe(true);
    expect(await scanner.scanOnce()).toEqual([]);
    expect(onCandidate).toHaveBeenCalledTimes(1);
  });

  it("reports scan failures rather than hiding them", async () => {
    const failure = new Error("Binance unavailable");
    const onError = vi.fn();
    const scanner = new SignalScanner({
      symbols: ["BTCUSDT"],
      client: {
        getHistoricalKlines: vi.fn().mockRejectedValue(failure)
      },
      scanIntervalMs: 30_000,
      onCandidate: vi.fn(),
      onError
    });

    await expect(scanner.scanOnce()).resolves.toEqual([]);
    expect(onError).toHaveBeenCalledTimes(TIMEFRAMES.length);
    expect(onError).toHaveBeenCalledWith(
      "BTCUSDT",
      expect.objectContaining({ message: expect.stringContaining(failure.message) })
    );
  });
});
