import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { runOutOfSampleValidation } from "./validation.js";
import type { BacktestConfig } from "./types.js";

function candle(index: number, closed = true): Candle {
  const openTime = 5_000_000 + index * 300_000;
  const isTargetBar = index === 4 || index === 8;
  return {
    openTime,
    closeTime: openTime + 299_999,
    open: isTargetBar ? "108" : "100",
    high: isTargetBar ? "115" : "101",
    low: isTargetBar ? "105" : "99",
    close: isTargetBar ? "112" : "100",
    volume: "10",
    closed
  };
}

const options: BacktestConfig = {
  strategy: "break_and_retest",
  initialEquity: 10_000,
  instrument: {
    quantityStep: 0.1,
    minimumQuantity: 0.1,
    maximumQuantity: 10_000,
    minimumNotional: 1,
    contractMultiplier: 1
  },
  costs: { feeRatePerSide: 0.001, slippageRatePerSide: 0.001 }
};

describe("out-of-sample validation", () => {
  it("uses disjoint test folds with prior candles available only as warm-up", () => {
    const candles = Array.from({ length: 10 }, (_, index) => candle(index));
    const signalIndexes = new Set([2, 6]);
    const evaluatedIndexes: number[] = [];
    const report = runOutOfSampleValidation({
      candles,
      options,
      validation: { warmupBars: 2, evaluationBars: 4 },
      evaluateSignal: (prefix, index) => {
        evaluatedIndexes.push(index);
        expect(prefix).toHaveLength(index + 1);
        if (!signalIndexes.has(index)) return undefined;
        const signalCandle = prefix.at(-1)!;
        return {
          strategy: "break_and_retest",
          side: "buy",
          signalTime: signalCandle.closeTime,
          stopPrice: 95
        };
      }
    });

    expect(report.folds.map(({ startIndex, endIndex }) => [startIndex, endIndex]))
      .toEqual([[2, 5], [6, 9]]);
    expect(evaluatedIndexes.every((index) => index >= 2)).toBe(true);
    expect(report.folds.flatMap(({ result }) =>
      result.trades.map((trade) => trade.entryIndex)
    )).toEqual([3, 7]);
    expect(report.summary).toMatchObject({
      foldCount: 2,
      evaluationBars: 8,
      totalTrades: 2,
      profitableFolds: 2,
      winRatePercent: 100
    });
    expect(report.summary.winRate95Percent?.[0]).toBeLessThan(100);
    expect(report.summary.winRate95Percent?.[1]).toBe(100);
  });

  it("ignores an incomplete trailing window and reports no-trade uncertainty", () => {
    const report = runOutOfSampleValidation({
      candles: Array.from({ length: 9 }, (_, index) => candle(index)),
      options,
      validation: { warmupBars: 2, evaluationBars: 4 },
      evaluateSignal: () => undefined
    });

    expect(report.folds).toHaveLength(1);
    expect(report.folds[0]).toMatchObject({ startIndex: 2, endIndex: 5 });
    expect(report.summary.totalTrades).toBe(0);
    expect(report.summary.winRate95Percent).toBeNull();
    expect(report.summary.profitFactor).toBeNull();
  });

  it("requires complete, non-overlapping test folds", () => {
    const candles = Array.from({ length: 8 }, (_, index) => candle(index));
    expect(() => runOutOfSampleValidation({
      candles,
      options,
      validation: { warmupBars: 2, evaluationBars: 4, stepBars: 3 },
      evaluateSignal: () => undefined
    })).toThrow("prevent overlapping");

    expect(() => runOutOfSampleValidation({
      candles: candles.slice(0, 5),
      options,
      validation: { warmupBars: 2, evaluationBars: 4 },
      evaluateSignal: () => undefined
    })).toThrow("at least one complete");
  });
});
