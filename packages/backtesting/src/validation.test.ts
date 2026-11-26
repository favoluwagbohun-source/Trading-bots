import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import {
  compareResearchToPaper,
  runCostStressTest,
  runOutOfSampleValidation,
  runParameterSensitivity,
  runRegimeBreakdown,
  runWalkForwardValidation
} from "./index.js";
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

  it("selects walk-forward configurations using only prior training candles", () => {
    const candles = Array.from({ length: 10 }, (_, index) => candle(index));
    const selections: Array<{ fold: number; trainingEnd: number }> = [];
    const report = runWalkForwardValidation({
      candles,
      trainingBars: 2,
      evaluationBars: 4,
      select: (trainingCandles, fold) => {
        selections.push({ fold, trainingEnd: trainingCandles.at(-1)!.closeTime });
        return {
          options,
          evaluateSignal: (prefix, index) => {
            if (index !== 2 && index !== 6) return undefined;
            return {
              strategy: "break_and_retest",
              side: "buy",
              signalTime: prefix.at(-1)!.closeTime,
              stopPrice: 95
            };
          }
        };
      }
    });

    expect(report.folds.map(({ startIndex, endIndex }) => [startIndex, endIndex]))
      .toEqual([[2, 5], [6, 9]]);
    expect(selections).toHaveLength(2);
    expect(selections[0]!.trainingEnd).toBeLessThan(candles[2]!.openTime);
    expect(selections[1]!.trainingEnd).toBeLessThan(candles[6]!.openTime);
  });

  it("reports parameter sensitivity, fee/slippage stress, and regime breakdown", () => {
    const candles = Array.from({ length: 10 }, (_, index) => candle(index));
    const evaluateSignal = (prefix: readonly Candle[], index: number) => {
      if (index !== 2 && index !== 6) return undefined;
      return {
        strategy: "break_and_retest" as const,
        side: "buy" as const,
        signalTime: prefix.at(-1)!.closeTime,
        stopPrice: 95
      };
    };
    const validation = { warmupBars: 2, evaluationBars: 4 };

    const sensitivity = runParameterSensitivity({
      candles,
      validation,
      variants: [
        { id: "baseline", options, evaluateSignal },
        { id: "higher-cost", options, evaluateSignal }
      ]
    });
    expect(sensitivity.map(({ id }) => id)).toEqual(["baseline", "higher-cost"]);

    const costs = runCostStressTest({
      candles,
      options,
      evaluateSignal,
      validation,
      scenarios: [
        { id: "zero-cost", costs: { feeRatePerSide: 0, slippageRatePerSide: 0 } },
        { id: "stressed", costs: { feeRatePerSide: 0.01, slippageRatePerSide: 0.01 } }
      ]
    });
    expect(costs[1]!.result.summary.totalNetPnl)
      .toBeLessThan(costs[0]!.result.summary.totalNetPnl);

    const regimes = runRegimeBreakdown({
      candles,
      options,
      evaluateSignal,
      validation,
      regimeForCandle: (_candle, index) => index < 6 ? "quiet" : "volatile"
    });
    expect(regimes.regimes.map(({ regime, totalTrades }) => [regime, totalTrades]))
      .toEqual([["quiet", 1], ["volatile", 1]]);
  });

  it("compares research and closed paper-trade results without treating open trades as closed", () => {
    expect(compareResearchToPaper({
      researchNetPnl: [10, -5],
      closedPaperNetPnl: [7]
    })).toEqual({
      researchTrades: 2,
      paperTrades: 1,
      researchNetPnl: 5,
      paperNetPnl: 7,
      netPnlDifference: 2,
      researchMeanTradePnl: 2.5,
      paperMeanTradePnl: 7
    });
  });
});
