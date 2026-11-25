import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { runBacktest } from "./backtest.js";
import type { BacktestOptions } from "./types.js";

function candle(index: number, values: {
  open: number;
  high: number;
  low: number;
  close: number;
  closed?: boolean;
}): Candle {
  const openTime = 3_000_000 + index * 300_000;
  return {
    openTime,
    closeTime: openTime + 299_999,
    open: String(values.open),
    high: String(values.high),
    low: String(values.low),
    close: String(values.close),
    volume: "10",
    closed: values.closed ?? true
  };
}

const options: BacktestOptions = {
  strategy: "break_and_retest",
  initialEquity: 10_000,
  instrument: {
    quantityStep: 0.1,
    minimumQuantity: 0.1,
    maximumQuantity: 10_000,
    minimumNotional: 1,
    contractMultiplier: 1
  },
  costs: { feeRatePerSide: 0, slippageRatePerSide: 0 },
  target1R: 1.5,
  target2R: 3,
  partialExits: { target1Allocation: 0.5, target2Allocation: 0.25 },
  breakEvenAtR: 1,
  trailingSwingLeftBars: 1,
  trailingSwingRightBars: 1,
  trailingStopBufferPercent: 0
};

function buySetup(prefix: readonly Candle[]) {
  const signalCandle = prefix.at(-1)!;
  return {
    strategy: "break_and_retest" as const,
    side: "buy" as const,
    signalTime: signalCandle.closeTime,
    stopPrice: 95
  };
}

describe("event-driven backtester", () => {
  it("only exposes a closed-candle prefix and enters at the next open", () => {
    const candles = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 100, high: 102, low: 99, close: 101 }),
      candle(2, { open: 100, high: 104, low: 99, close: 102 }),
      candle(3, { open: 102, high: 108, low: 101, close: 107 }),
      candle(4, { open: 104, high: 106, low: 99, close: 101 })
    ];
    const visibleLengths: number[] = [];
    const result = runBacktest({
      candles,
      options,
      evaluateSignal: (prefix, index) => {
        expect(prefix).toHaveLength(index + 1);
        expect(prefix.at(-1)).toBe(candles[index]);
        visibleLengths.push(prefix.length);
        return prefix.length === 2 ? buySetup(prefix) : undefined;
      }
    });

    expect(visibleLengths).toEqual([1, 2, 5]);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      strategy: "break_and_retest",
      entryTime: candles[2]!.openTime,
      entryPrice: 100,
      initialStop: 95
    });
    expect(result.trades[0]!.exits.map((exit) => exit.reason)).toEqual([
      "take_profit_1",
      "break_even_stop"
    ]);
    expect(result.endingEquity - result.startingEquity).toBeCloseTo(
      result.metrics.netProfit
    );
    expect(result.metrics.totalFees).toBe(0);
  });

  it("tracks TP1, TP2, and the trailing runner as separate partial exits", () => {
    const candles = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 100, high: 101, low: 99, close: 100 }),
      candle(2, { open: 101, high: 116, low: 101, close: 114 }),
      candle(3, { open: 114, high: 115, low: 99, close: 100 })
    ];
    const result = runBacktest({
      candles,
      options,
      evaluateSignal: (prefix) => prefix.length === 1 ? buySetup(prefix) : undefined
    });

    expect(result.trades[0]!.exits.map((exit) => exit.reason)).toEqual([
      "take_profit_1",
      "take_profit_2",
      "break_even_stop"
    ]);
    expect(result.metrics.grossProfit).toBeGreaterThan(0);
    expect(result.metrics.averageR).toBeGreaterThan(0);
  });

  it("charges fees and adverse slippage in final net results", () => {
    const candles = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 100, high: 101, low: 99, close: 100 }),
      candle(2, { open: 102, high: 109, low: 101, close: 108 }),
      candle(3, { open: 105, high: 106, low: 99, close: 100 })
    ];
    const result = runBacktest({
      candles,
      options: {
        ...options,
        costs: { feeRatePerSide: 0.001, slippageRatePerSide: 0.001 }
      },
      evaluateSignal: (prefix) => prefix.length === 1 ? buySetup(prefix) : undefined
    });

    expect(result.metrics.totalFees).toBeGreaterThan(0);
    expect(result.trades[0]!.finalPnl).toBeLessThan(result.trades[0]!.grossPnl);
    expect(result.endingEquity - result.startingEquity).toBeCloseTo(result.metrics.netProfit);
  });

  it("assumes the stop is hit first when a candle touches stop and target", () => {
    const candles = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 100, high: 120, low: 94, close: 110 }),
      candle(2, { open: 110, high: 111, low: 109, close: 110 })
    ];
    const result = runBacktest({
      candles,
      options,
      evaluateSignal: (prefix) => prefix.length === 1 ? buySetup(prefix) : undefined
    });

    expect(result.trades[0]!.exits).toHaveLength(1);
    expect(result.trades[0]!.exits[0]).toMatchObject({ reason: "stop_loss", price: 95 });
    expect(result.trades[0]!.finalPnl).toBeLessThan(0);
  });

  it("updates a stop from a swing confirmed by visible candles only", () => {
    const candles = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 100, high: 101, low: 99, close: 100 }),
      candle(2, { open: 102, high: 106, low: 102, close: 104 }),
      candle(3, { open: 104, high: 105, low: 101, close: 104 }),
      candle(4, { open: 104, high: 105, low: 102, close: 104 }),
      candle(5, { open: 102, high: 103, low: 100.9, close: 101 })
    ];
    const result = runBacktest({
      candles,
      options,
      evaluateSignal: (prefix) => prefix.length === 1 ? buySetup(prefix) : undefined
    });

    expect(result.trades[0]!.exits.at(-1)).toMatchObject({
      reason: "trailing_stop",
      price: 101
    });
  });

  it("rejects malformed or unordered historical candles", () => {
    const valid = candle(0, { open: 100, high: 101, low: 99, close: 100 });
    expect(() => runBacktest({
      candles: [valid, { ...candle(1, { open: 100, high: 101, low: 99, close: 100 }), openTime: valid.openTime }],
      options,
      evaluateSignal: () => undefined
    })).toThrow("ascending time order");

    expect(() => runBacktest({
      candles: [{ ...valid, high: "98" }],
      options,
      evaluateSignal: () => undefined
    })).toThrow("Invalid historical candle");
  });

  it("ignores unfinished candles and keeps results scoped to one strategy", () => {
    const candles = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 100, high: 102, low: 99, close: 101, closed: false })
    ];
    const result = runBacktest({
      candles,
      options,
      evaluateSignal: () => undefined
    });
    expect(result.strategy).toBe("break_and_retest");
    expect(result.equityCurve).toHaveLength(1);
  });

  it("counts a final-bar signal as unfilled because no next open exists", () => {
    const candles = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 100, high: 102, low: 99, close: 101 })
    ];
    const result = runBacktest({
      candles,
      options,
      evaluateSignal: (prefix) => prefix.length === 2 ? buySetup(prefix) : undefined
    });

    expect(result.trades).toHaveLength(0);
    expect(result.unfilledSignals).toBe(1);
  });
});
