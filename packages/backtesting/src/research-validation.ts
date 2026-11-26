import type { Candle } from "@crypto-signal/shared";
import type { TradingCosts } from "@crypto-signal/risk-engine";
import { runBacktest } from "./backtest.js";
import {
  runOutOfSampleValidation,
  type OutOfSampleSummary,
  type OutOfSampleValidationOptions,
  type OutOfSampleValidationResult
} from "./validation.js";
import type {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  SignalEvaluator
} from "./types.js";

export interface WalkForwardFold {
  readonly fold: number;
  readonly trainingStartIndex: number;
  readonly trainingEndIndex: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly selectedStrategy: BacktestConfig["strategy"];
  readonly result: BacktestResult;
}

export interface WalkForwardValidationResult {
  readonly trainingBars: number;
  readonly evaluationBars: number;
  readonly stepBars: number;
  readonly folds: readonly WalkForwardFold[];
  readonly summary: OutOfSampleSummary;
}

const WILSON_Z_95 = 1.959963984540054;

function winRateInterval(wins: number, total: number): readonly [number, number] | null {
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

function summarizeTrades(
  folds: readonly { readonly result: BacktestResult }[],
  evaluationBars: number
): OutOfSampleSummary {
  const trades = folds.flatMap(({ result }) => result.trades);
  const wins = trades.filter((trade) => trade.finalPnl > 0).length;
  const totalNetPnl = trades.reduce((total, trade) => total + trade.finalPnl, 0);
  const grossProfit = trades.reduce((total, trade) => total + trade.exits.reduce(
    (sum, exit) => sum + Math.max(0, exit.grossPnl),
    0
  ), 0);
  const grossLoss = trades.reduce((total, trade) => total + trade.exits.reduce(
    (sum, exit) => sum + Math.max(0, -exit.grossPnl),
    0
  ), 0);
  return {
    foldCount: folds.length,
    evaluationBars,
    totalTrades: trades.length,
    profitableFolds: folds.filter(({ result }) => result.metrics.netProfit > 0).length,
    totalNetPnl,
    meanTradePnl: trades.length === 0 ? 0 : totalNetPnl / trades.length,
    winRatePercent: trades.length === 0 ? 0 : wins / trades.length * 100,
    winRate95Percent: winRateInterval(wins, trades.length),
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    maximumFoldDrawdownPercent: Math.max(
      0,
      ...folds.map(({ result }) => result.metrics.maximumDrawdownPercent)
    )
  };
}

export function runWalkForwardValidation(request: {
  readonly candles: readonly Candle[];
  readonly trainingBars: number;
  readonly evaluationBars: number;
  readonly stepBars?: number;
  readonly select: (trainingCandles: readonly Candle[], fold: number) => {
    readonly options: BacktestConfig;
    readonly evaluateSignal: SignalEvaluator;
  };
}): WalkForwardValidationResult {
  const { trainingBars, evaluationBars } = request;
  const stepBars = request.stepBars ?? evaluationBars;
  for (const [name, value] of [
    ["trainingBars", trainingBars],
    ["evaluationBars", evaluationBars],
    ["stepBars", stepBars]
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  if (stepBars < evaluationBars) {
    throw new Error("stepBars must be at least evaluationBars to prevent overlapping test folds");
  }
  const candles = request.candles.filter((candle) => candle.closed);
  if (candles.length < trainingBars + evaluationBars) {
    throw new Error("Historical data must contain at least one complete walk-forward fold");
  }

  const folds: WalkForwardFold[] = [];
  for (
    let startIndex = trainingBars;
    startIndex + evaluationBars <= candles.length;
    startIndex += stepBars
  ) {
    const endIndex = startIndex + evaluationBars - 1;
    const trainingStartIndex = startIndex - trainingBars;
    const selected = request.select(
      candles.slice(trainingStartIndex, startIndex),
      folds.length + 1
    );
    const foldCandles = candles.slice(0, endIndex + 1);
    const result = runBacktest({
      candles: foldCandles,
      options: selected.options,
      evaluateSignal: selected.evaluateSignal,
      evaluationWindow: { signalStartIndex: startIndex, endIndex }
    });
    folds.push({
      fold: folds.length + 1,
      trainingStartIndex,
      trainingEndIndex: startIndex - 1,
      startIndex,
      endIndex,
      startTime: candles[startIndex]!.openTime,
      endTime: candles[endIndex]!.closeTime,
      selectedStrategy: selected.options.strategy,
      result
    });
  }
  return {
    trainingBars,
    evaluationBars,
    stepBars,
    folds,
    summary: summarizeTrades(folds, folds.length * evaluationBars)
  };
}

export interface ParameterSensitivityResult {
  readonly id: string;
  readonly result: OutOfSampleValidationResult;
}

export function runParameterSensitivity(request: {
  readonly candles: readonly Candle[];
  readonly validation: OutOfSampleValidationOptions;
  readonly variants: readonly {
    readonly id: string;
    readonly options: BacktestConfig;
    readonly evaluateSignal: SignalEvaluator;
  }[];
}): readonly ParameterSensitivityResult[] {
  const ids = new Set<string>();
  return request.variants.map((variant) => {
    if (!variant.id.trim() || ids.has(variant.id)) {
      throw new Error("Sensitivity variant IDs must be non-empty and unique");
    }
    ids.add(variant.id);
    return {
      id: variant.id,
      result: runOutOfSampleValidation({
        candles: request.candles,
        options: variant.options,
        evaluateSignal: variant.evaluateSignal,
        validation: request.validation
      })
    };
  });
}

export interface CostStressResult {
  readonly id: string;
  readonly costs: TradingCosts;
  readonly result: OutOfSampleValidationResult;
}

export function runCostStressTest(request: {
  readonly candles: readonly Candle[];
  readonly options: BacktestConfig;
  readonly evaluateSignal: SignalEvaluator;
  readonly validation: OutOfSampleValidationOptions;
  readonly scenarios: readonly { readonly id: string; readonly costs: TradingCosts }[];
}): readonly CostStressResult[] {
  const ids = new Set<string>();
  return request.scenarios.map((scenario) => {
    if (!scenario.id.trim() || ids.has(scenario.id)) {
      throw new Error("Cost-stress scenario IDs must be non-empty and unique");
    }
    ids.add(scenario.id);
    return {
      id: scenario.id,
      costs: scenario.costs,
      result: runOutOfSampleValidation({
        candles: request.candles,
        options: { ...request.options, costs: scenario.costs },
        evaluateSignal: request.evaluateSignal,
        validation: request.validation
      })
    };
  });
}

export interface RegimePerformance {
  readonly regime: string;
  readonly totalTrades: number;
  readonly wins: number;
  readonly winRatePercent: number;
  readonly netPnl: number;
  readonly meanTradePnl: number;
}

export interface RegimeBreakdownResult {
  readonly validation: OutOfSampleValidationResult;
  readonly regimes: readonly RegimePerformance[];
}

export function runRegimeBreakdown(request: {
  readonly candles: readonly Candle[];
  readonly options: BacktestConfig;
  readonly evaluateSignal: SignalEvaluator;
  readonly validation: OutOfSampleValidationOptions;
  readonly regimeForCandle: (candle: Candle, index: number) => string;
}): RegimeBreakdownResult {
  const candles = request.candles.filter((candle) => candle.closed);
  const validation = runOutOfSampleValidation(request);
  const groups = new Map<string, BacktestTrade[]>();
  for (const trade of validation.folds.flatMap(({ result }) => result.trades)) {
    const candle = candles[trade.entryIndex];
    if (!candle) throw new Error("Backtest entry index is outside the regime input candles");
    const regime = request.regimeForCandle(candle, trade.entryIndex);
    if (!regime.trim()) throw new Error("Market regime labels must be non-empty");
    const group = groups.get(regime) ?? [];
    group.push(trade);
    groups.set(regime, group);
  }
  return {
    validation,
    regimes: [...groups.entries()].map(([regime, trades]) => {
      const wins = trades.filter((trade) => trade.finalPnl > 0).length;
      const netPnl = trades.reduce((sum, trade) => sum + trade.finalPnl, 0);
      return {
        regime,
        totalTrades: trades.length,
        wins,
        winRatePercent: trades.length === 0 ? 0 : wins / trades.length * 100,
        netPnl,
        meanTradePnl: trades.length === 0 ? 0 : netPnl / trades.length
      };
    })
  };
}

export interface PaperComparison {
  readonly researchTrades: number;
  readonly paperTrades: number;
  readonly researchNetPnl: number;
  readonly paperNetPnl: number;
  readonly netPnlDifference: number;
  readonly researchMeanTradePnl: number;
  readonly paperMeanTradePnl: number;
}

export function compareResearchToPaper(request: {
  readonly researchNetPnl: readonly number[];
  readonly closedPaperNetPnl: readonly number[];
}): PaperComparison {
  for (const pnl of [...request.researchNetPnl, ...request.closedPaperNetPnl]) {
    if (!Number.isFinite(pnl)) throw new Error("Research and paper PnL values must be finite");
  }
  const researchNetPnl = request.researchNetPnl.reduce((sum, pnl) => sum + pnl, 0);
  const paperNetPnl = request.closedPaperNetPnl.reduce((sum, pnl) => sum + pnl, 0);
  return {
    researchTrades: request.researchNetPnl.length,
    paperTrades: request.closedPaperNetPnl.length,
    researchNetPnl,
    paperNetPnl,
    netPnlDifference: paperNetPnl - researchNetPnl,
    researchMeanTradePnl: request.researchNetPnl.length === 0
      ? 0
      : researchNetPnl / request.researchNetPnl.length,
    paperMeanTradePnl: request.closedPaperNetPnl.length === 0
      ? 0
      : paperNetPnl / request.closedPaperNetPnl.length
  };
}
