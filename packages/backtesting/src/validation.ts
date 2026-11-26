import type { Candle } from "@crypto-signal/shared";
import { runBacktest } from "./backtest.js";
import type { BacktestConfig, BacktestResult, SignalEvaluator } from "./types.js";

const WILSON_Z_95 = 1.959963984540054;

export interface OutOfSampleValidationOptions {
  readonly warmupBars: number;
  readonly evaluationBars: number;
  readonly stepBars?: number;
}

export interface OutOfSampleFold {
  readonly fold: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly result: BacktestResult;
}

export interface OutOfSampleSummary {
  readonly foldCount: number;
  readonly evaluationBars: number;
  readonly totalTrades: number;
  readonly profitableFolds: number;
  readonly totalNetPnl: number;
  readonly meanTradePnl: number;
  readonly winRatePercent: number;
  readonly winRate95Percent: readonly [number, number] | null;
  readonly profitFactor: number | null;
  readonly maximumFoldDrawdownPercent: number;
}

export interface OutOfSampleValidationResult {
  readonly strategy: BacktestConfig["strategy"];
  readonly warmupBars: number;
  readonly evaluationBars: number;
  readonly stepBars: number;
  readonly folds: readonly OutOfSampleFold[];
  readonly summary: OutOfSampleSummary;
}

function validateWindowSize(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function wilsonInterval(wins: number, total: number): readonly [number, number] | null {
  if (total === 0) return null;
  const zSquared = WILSON_Z_95 ** 2;
  const proportion = wins / total;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const margin = WILSON_Z_95 *
    Math.sqrt(proportion * (1 - proportion) / total + zSquared / (4 * total ** 2)) /
    denominator;
  return [
    Math.max(0, (center - margin) * 100),
    Math.min(100, (center + margin) * 100)
  ];
}

export function runOutOfSampleValidation(request: {
  readonly candles: readonly Candle[];
  readonly options: BacktestConfig;
  readonly evaluateSignal: SignalEvaluator;
  readonly validation: OutOfSampleValidationOptions;
}): OutOfSampleValidationResult {
  const { warmupBars, evaluationBars } = request.validation;
  const stepBars = request.validation.stepBars ?? evaluationBars;
  validateWindowSize(warmupBars, "warmupBars");
  validateWindowSize(evaluationBars, "evaluationBars");
  validateWindowSize(stepBars, "stepBars");
  if (stepBars < evaluationBars) {
    throw new Error("stepBars must be at least evaluationBars to prevent overlapping test folds");
  }

  const candles = request.candles.filter((candle) => candle.closed);
  if (candles.length < warmupBars + evaluationBars) {
    throw new Error("Historical data must contain at least one complete out-of-sample fold");
  }

  const folds: OutOfSampleFold[] = [];
  for (
    let startIndex = warmupBars;
    startIndex + evaluationBars <= candles.length;
    startIndex += stepBars
  ) {
    const endIndex = startIndex + evaluationBars - 1;
    const result = runBacktest({
      candles,
      options: request.options,
      evaluateSignal: request.evaluateSignal,
      evaluationWindow: { signalStartIndex: startIndex, endIndex }
    });
    folds.push({
      fold: folds.length + 1,
      startIndex,
      endIndex,
      startTime: candles[startIndex]!.openTime,
      endTime: candles[endIndex]!.closeTime,
      result
    });
  }

  const trades = folds.flatMap((fold) => fold.result.trades);
  const wins = trades.filter((trade) => trade.finalPnl > 0).length;
  const totalNetPnl = trades.reduce((total, trade) => total + trade.finalPnl, 0);
  const grossProfit = trades.reduce(
    (total, trade) => total + trade.exits.reduce(
      (tradeTotal, exit) => tradeTotal + Math.max(0, exit.grossPnl),
      0
    ),
    0
  );
  const grossLoss = trades.reduce(
    (total, trade) => total + trade.exits.reduce(
      (tradeTotal, exit) => tradeTotal + Math.max(0, -exit.grossPnl),
      0
    ),
    0
  );
  const summary: OutOfSampleSummary = {
    foldCount: folds.length,
    evaluationBars: folds.length * evaluationBars,
    totalTrades: trades.length,
    profitableFolds: folds.filter((fold) => fold.result.metrics.netProfit > 0).length,
    totalNetPnl,
    meanTradePnl: trades.length === 0 ? 0 : totalNetPnl / trades.length,
    winRatePercent: trades.length === 0 ? 0 : wins / trades.length * 100,
    winRate95Percent: wilsonInterval(wins, trades.length),
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    maximumFoldDrawdownPercent: Math.max(
      0,
      ...folds.map((fold) => fold.result.metrics.maximumDrawdownPercent)
    )
  };

  return {
    strategy: request.options.strategy,
    warmupBars,
    evaluationBars,
    stepBars,
    folds,
    summary
  };
}
