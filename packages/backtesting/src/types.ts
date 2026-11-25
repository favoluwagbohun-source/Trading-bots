import type { Candle, StrategyId } from "@crypto-signal/shared";
import type { InstrumentRules, TradingCosts } from "@crypto-signal/risk-engine";

export interface BacktestSetup {
  readonly strategy: StrategyId;
  readonly side: "buy" | "sell";
  readonly signalTime: number;
  readonly stopPrice: number;
}

export type SignalEvaluator = (
  closedCandles: readonly Candle[],
  index: number
) => BacktestSetup | undefined;

export interface PartialExitOptions {
  readonly target1Allocation: number;
  readonly target2Allocation: number;
}

export interface BacktestOptions {
  readonly strategy: StrategyId;
  readonly initialEquity: number;
  readonly instrument: InstrumentRules;
  readonly costs: TradingCosts;
  readonly target1R: number;
  readonly target2R: number;
  readonly partialExits: PartialExitOptions;
  readonly breakEvenAtR: number;
  readonly trailingSwingLeftBars: number;
  readonly trailingSwingRightBars: number;
  readonly trailingStopBufferPercent: number;
}

export type BacktestConfig =
  Pick<BacktestOptions, "strategy" | "initialEquity" | "instrument" | "costs"> &
  Partial<Omit<BacktestOptions, "strategy" | "initialEquity" | "instrument" | "costs">>;

export type ExitReason =
  | "stop_loss"
  | "break_even_stop"
  | "trailing_stop"
  | "take_profit_1"
  | "take_profit_2"
  | "end_of_data";

export interface TradeExit {
  readonly time: number;
  readonly candleIndex: number;
  readonly reason: ExitReason;
  readonly price: number;
  readonly quantity: number;
  readonly grossPnl: number;
  readonly fee: number;
  readonly netPnl: number;
}

export interface BacktestTrade {
  readonly strategy: StrategyId;
  readonly side: "buy" | "sell";
  readonly signalTime: number;
  readonly entryTime: number;
  readonly entryIndex: number;
  readonly entryPrice: number;
  readonly initialStop: number;
  readonly initialRiskAmount: number;
  readonly initialQuantity: number;
  readonly finalPnl: number;
  readonly grossPnl: number;
  readonly fees: number;
  readonly rMultiple: number;
  readonly durationCandles: number;
  readonly exits: readonly TradeExit[];
}

export interface EquityPoint {
  readonly time: number;
  readonly equity: number;
}

export interface BacktestMetrics {
  readonly totalTrades: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly winRate: number;
  readonly grossProfit: number;
  readonly grossLoss: number;
  readonly netProfit: number;
  readonly profitFactor: number | null;
  readonly expectancy: number;
  readonly averageR: number;
  readonly totalFees: number;
  readonly maximumDrawdown: number;
  readonly maximumDrawdownPercent: number;
  readonly maximumConsecutiveLosses: number;
  readonly averageTradeDurationCandles: number;
}

export interface BacktestResult {
  readonly strategy: StrategyId;
  readonly startingEquity: number;
  readonly endingEquity: number;
  readonly rejectedSignals: number;
  readonly unfilledSignals: number;
  readonly trades: readonly BacktestTrade[];
  readonly equityCurve: readonly EquityPoint[];
  readonly metrics: BacktestMetrics;
}
