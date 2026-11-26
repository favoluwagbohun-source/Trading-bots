import type { Candle, StrategyId } from "@crypto-signal/shared";
import { findConfirmedSwings } from "@crypto-signal/indicators";
import {
  calculatePositionSize,
  PositionSizingError,
  type PositionSizingRequest
} from "@crypto-signal/risk-engine";
import type {
  BacktestMetrics,
  BacktestConfig,
  BacktestOptions,
  BacktestResult,
  BacktestSetup,
  BacktestTrade,
  EquityPoint,
  ExitReason,
  SignalEvaluator,
  TradeExit
} from "./types.js";

interface ActiveTrade {
  readonly strategy: StrategyId;
  readonly side: "buy" | "sell";
  readonly signalTime: number;
  readonly entryTime: number;
  readonly entryIndex: number;
  readonly entryPrice: number;
  readonly initialStop: number;
  readonly initialRiskAmount: number;
  readonly initialQuantity: number;
  readonly target1Price: number;
  readonly target2Price: number;
  readonly target1Quantity: number;
  readonly target2Quantity: number;
  readonly exits: TradeExit[];
  remainingQuantity: number;
  stopPrice: number;
  stopReason: ExitReason;
  target1Done: boolean;
  target2Done: boolean;
  pnl: number;
  grossPnl: number;
  fees: number;
}

const DEFAULT_OPTIONS: Pick<
  BacktestOptions,
  | "target1R"
  | "target2R"
  | "partialExits"
  | "breakEvenAtR"
  | "trailingSwingLeftBars"
  | "trailingSwingRightBars"
  | "trailingStopBufferPercent"
> = {
  target1R: 1.5,
  target2R: 3,
  partialExits: { target1Allocation: 1 / 3, target2Allocation: 1 / 3 },
  breakEvenAtR: 1,
  trailingSwingLeftBars: 2,
  trailingSwingRightBars: 2,
  trailingStopBufferPercent: 0
};

function assertCandle(candle: Candle, previous?: Candle): void {
  const prices = [candle.open, candle.high, candle.low, candle.close].map(Number);
  const [open, high, low, close] = prices;
  if (
    !Number.isSafeInteger(candle.openTime) ||
    !Number.isSafeInteger(candle.closeTime) ||
    candle.closeTime <= candle.openTime ||
    prices.some((price) => !Number.isFinite(price) || price <= 0) ||
    high! < Math.max(open!, close!) ||
    low! > Math.min(open!, close!) ||
    high! < low! ||
    !Number.isFinite(Number(candle.volume)) ||
    Number(candle.volume) < 0
  ) {
    throw new Error(`Invalid historical candle at ${candle.openTime}`);
  }
  if (previous && candle.openTime <= previous.openTime) {
    throw new Error("Historical candles must be in strictly ascending time order");
  }
  if (previous && candle.openTime <= previous.closeTime) {
    throw new Error("Historical candles must not overlap");
  }
}

function roundDown(quantity: number, step: number): number {
  const decimals = step.toString().toLowerCase().split("e-")[1];
  const places = decimals
    ? Number(decimals)
    : step.toString().split(".")[1]?.length ?? 0;
  return Number((Math.floor(quantity / step + 1e-10) * step).toFixed(places));
}

function adverseFill(price: number, side: "buy" | "sell", slippage: number): number {
  return price * (side === "buy" ? 1 + slippage : 1 - slippage);
}

function setupRiskPrice(setup: BacktestSetup, entryPrice: number): number {
  const risk = setup.side === "buy"
    ? entryPrice - setup.stopPrice
    : setup.stopPrice - entryPrice;
  if (!Number.isFinite(risk) || risk <= 0) {
    throw new Error("Backtest signal stop is invalid for its trade direction");
  }
  return risk;
}

function positionRequest(
  options: BacktestOptions,
  setup: BacktestSetup,
  equity: number,
  entryPrice: number,
  riskPrice: number
): PositionSizingRequest {
  const direction = setup.side === "buy" ? 1 : -1;
  return {
    equity,
    side: setup.side,
    entryPrice,
    stopPrice: setup.stopPrice,
    target2Price: entryPrice + direction * riskPrice * options.target2R,
    instrument: options.instrument,
    costs: options.costs
  };
}

function closeQuantity(
  trade: ActiveTrade,
  quantity: number,
  triggerPrice: number,
  reason: ExitReason,
  candle: Candle,
  candleIndex: number,
  options: BacktestOptions,
  equity: { value: number }
): void {
  const closeQty = Math.min(quantity, trade.remainingQuantity);
  if (closeQty <= 0) return;
  const fillPrice = adverseFill(
    triggerPrice,
    trade.side === "buy" ? "sell" : "buy",
    options.costs.slippageRatePerSide
  );
  const direction = trade.side === "buy" ? 1 : -1;
  const grossPnl = (fillPrice - trade.entryPrice) *
    direction *
    closeQty *
    options.instrument.contractMultiplier;
  const exitFee = fillPrice *
    closeQty *
    options.instrument.contractMultiplier *
    options.costs.feeRatePerSide;
  const netPnl = grossPnl - exitFee;
  trade.pnl += netPnl;
  trade.grossPnl += grossPnl;
  trade.fees += exitFee;
  equity.value += netPnl;
  trade.remainingQuantity = Number(
    (trade.remainingQuantity - closeQty).toFixed(12)
  );
  trade.exits.push({
    time: candle.closeTime,
    candleIndex,
    reason,
    price: fillPrice,
    quantity: closeQty,
    grossPnl,
    fee: exitFee,
    netPnl
  });
}

function finishTrade(trade: ActiveTrade, finalIndex: number): BacktestTrade {
  return {
    strategy: trade.strategy,
    side: trade.side,
    signalTime: trade.signalTime,
    entryTime: trade.entryTime,
    entryIndex: trade.entryIndex,
    entryPrice: trade.entryPrice,
    initialStop: trade.initialStop,
    initialRiskAmount: trade.initialRiskAmount,
    initialQuantity: trade.initialQuantity,
    finalPnl: trade.pnl,
    grossPnl: trade.grossPnl,
    fees: trade.fees,
    rMultiple: trade.pnl / trade.initialRiskAmount,
    durationCandles: finalIndex - trade.entryIndex + 1,
    exits: [...trade.exits]
  };
}

function updateProtectiveStop(
  trade: ActiveTrade,
  candles: readonly Candle[],
  index: number,
  options: BacktestOptions
): void {
  const current = candles[index]!;
  const initialRiskPrice = Math.abs(trade.entryPrice - trade.initialStop);
  const favorablePrice = trade.side === "buy"
    ? Number(current.high)
    : Number(current.low);
  const reachedBreakEven = trade.side === "buy"
    ? favorablePrice >= trade.entryPrice + initialRiskPrice * options.breakEvenAtR
    : favorablePrice <= trade.entryPrice - initialRiskPrice * options.breakEvenAtR;
  if (reachedBreakEven) {
    const improves = trade.side === "buy"
      ? trade.stopPrice < trade.entryPrice
      : trade.stopPrice > trade.entryPrice;
    if (improves) {
      trade.stopPrice = trade.entryPrice;
      trade.stopReason = "break_even_stop";
    }
  }

  const swings = findConfirmedSwings(candles.slice(0, index + 1), {
    leftBars: options.trailingSwingLeftBars,
    rightBars: options.trailingSwingRightBars
  });
  const direction = trade.side === "buy" ? "low" : "high";
  const swing = [...swings].reverse().find((candidate) => candidate.direction === direction);
  if (!swing) return;
  const buffer = swing.price * options.trailingStopBufferPercent / 100;
  const candidateStop = trade.side === "buy"
    ? swing.price - buffer
    : swing.price + buffer;
  const improves = trade.side === "buy"
    ? candidateStop > trade.stopPrice && candidateStop < Number(current.close)
    : candidateStop < trade.stopPrice && candidateStop > Number(current.close);
  if (improves) {
    trade.stopPrice = candidateStop;
    trade.stopReason = "trailing_stop";
  }
}

function processCandle(
  trade: ActiveTrade,
  candle: Candle,
  index: number,
  candles: readonly Candle[],
  options: BacktestOptions,
  equity: { value: number }
): boolean {
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const stopTouched = trade.side === "buy"
    ? low <= trade.stopPrice
    : high >= trade.stopPrice;
  if (stopTouched) {
    const gapThroughStop = trade.side === "buy"
      ? open <= trade.stopPrice
      : open >= trade.stopPrice;
    const stopFill = gapThroughStop ? open : trade.stopPrice;
    closeQuantity(
      trade,
      trade.remainingQuantity,
      stopFill,
      trade.stopReason,
      candle,
      index,
      options,
      equity
    );
    return true;
  }

  const initialRiskPrice = Math.abs(trade.entryPrice - trade.initialStop);
  const reachedBreakEvenTrigger = trade.side === "buy"
    ? high >= trade.entryPrice + initialRiskPrice * options.breakEvenAtR
    : low <= trade.entryPrice - initialRiskPrice * options.breakEvenAtR;
  const breakEvenTouched = trade.side === "buy"
    ? low <= trade.entryPrice
    : high >= trade.entryPrice;
  if (reachedBreakEvenTrigger && breakEvenTouched) {
    closeQuantity(
      trade,
      trade.remainingQuantity,
      trade.entryPrice,
      "break_even_stop",
      candle,
      index,
      options,
      equity
    );
    return true;
  }

  const target1Touched = trade.side === "buy"
    ? high >= trade.target1Price
    : low <= trade.target1Price;
  if (!trade.target1Done && target1Touched) {
    const quantity = trade.target1Quantity;
    if (quantity > 0) {
      closeQuantity(
        trade,
        quantity,
        trade.target1Price,
        "take_profit_1",
        candle,
        index,
        options,
        equity
      );
      trade.target1Done = true;
    }
  }

  const target2Touched = trade.side === "buy"
    ? high >= trade.target2Price
    : low <= trade.target2Price;
  if (!trade.target2Done && target2Touched && trade.remainingQuantity > 0) {
    const quantity = trade.target2Quantity;
    if (quantity > 0) {
      closeQuantity(
        trade,
        quantity,
        trade.target2Price,
        "take_profit_2",
        candle,
        index,
        options,
        equity
      );
      trade.target2Done = true;
    }
  }

  if (trade.remainingQuantity <= 0) return true;
  updateProtectiveStop(trade, candles, index, options);
  return false;
}

function markToMarket(
  equity: number,
  trade: ActiveTrade | undefined,
  candle: Candle,
  options: BacktestOptions
): number {
  if (!trade || trade.remainingQuantity <= 0) return equity;
  const exitPrice = adverseFill(
    Number(candle.close),
    trade.side === "buy" ? "sell" : "buy",
    options.costs.slippageRatePerSide
  );
  const direction = trade.side === "buy" ? 1 : -1;
  const gross = (exitPrice - trade.entryPrice) *
    direction *
    trade.remainingQuantity *
    options.instrument.contractMultiplier;
  const fee = exitPrice *
    trade.remainingQuantity *
    options.instrument.contractMultiplier *
    options.costs.feeRatePerSide;
  return equity + gross - fee;
}

function validateOptions(options: BacktestOptions): void {
  if (!Number.isFinite(options.initialEquity) || options.initialEquity <= 0) {
    throw new Error("initialEquity must be positive");
  }
  if (
    !Number.isFinite(options.target1R) ||
    !Number.isFinite(options.target2R) ||
    options.target1R <= 0 ||
    options.target1R >= options.target2R ||
    options.target2R < 2
  ) {
    throw new Error("Targets must be positive, ordered, and TP2 at least 2R");
  }
  const { target1Allocation, target2Allocation } = options.partialExits;
  if (
    !Number.isFinite(target1Allocation) ||
    !Number.isFinite(target2Allocation) ||
    target1Allocation < 0 ||
    target2Allocation < 0 ||
    target1Allocation + target2Allocation > 1
  ) {
    throw new Error("Partial exit allocations must be non-negative and sum to at most 1");
  }
  if (!Number.isFinite(options.breakEvenAtR) || options.breakEvenAtR <= 0) {
    throw new Error("breakEvenAtR must be positive");
  }
  if (
    !Number.isInteger(options.trailingSwingLeftBars) ||
    options.trailingSwingLeftBars < 1 ||
    !Number.isInteger(options.trailingSwingRightBars) ||
    options.trailingSwingRightBars < 1
  ) {
    throw new Error("Trailing swing confirmation bars must be positive integers");
  }
  if (
    !Number.isFinite(options.trailingStopBufferPercent) ||
    options.trailingStopBufferPercent < 0
  ) {
    throw new Error("trailingStopBufferPercent must be non-negative");
  }
  const instrument = options.instrument;
  if (
    !Number.isFinite(instrument.quantityStep) ||
    instrument.quantityStep <= 0 ||
    !Number.isFinite(instrument.minimumQuantity) ||
    instrument.minimumQuantity <= 0 ||
    !Number.isFinite(instrument.maximumQuantity) ||
    instrument.maximumQuantity < instrument.minimumQuantity ||
    !Number.isFinite(instrument.minimumNotional) ||
    instrument.minimumNotional < 0 ||
    !Number.isFinite(instrument.contractMultiplier) ||
    instrument.contractMultiplier <= 0
  ) {
    throw new Error("Instrument quantity and contract rules are invalid");
  }
  const costs = options.costs;
  if (
    !Number.isFinite(costs.feeRatePerSide) ||
    costs.feeRatePerSide < 0 ||
    !Number.isFinite(costs.slippageRatePerSide) ||
    costs.slippageRatePerSide < 0 ||
    costs.slippageRatePerSide >= 1
  ) {
    throw new Error("Trading costs must be non-negative and slippage below 100%");
  }
}

function calculateMetrics(
  trades: readonly BacktestTrade[],
  equityCurve: readonly EquityPoint[],
  startingEquity: number
): BacktestMetrics {
  const winners = trades.filter((trade) => trade.finalPnl > 0);
  const losers = trades.filter((trade) => trade.finalPnl < 0);
  const exits = trades.flatMap((trade) => trade.exits);
  const grossProfit = exits.reduce(
    (sum, exit) => sum + Math.max(exit.grossPnl, 0),
    0
  );
  const grossLoss = exits.reduce(
    (sum, exit) => sum + Math.min(exit.grossPnl, 0),
    0
  ) * -1;
  let peak = startingEquity;
  let maximumDrawdown = 0;
  let maximumDrawdownPercent = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    const drawdown = peak - point.equity;
    maximumDrawdown = Math.max(maximumDrawdown, drawdown);
    if (peak > 0) maximumDrawdownPercent = Math.max(maximumDrawdownPercent, drawdown / peak * 100);
  }
  let currentLosingStreak = 0;
  let maximumConsecutiveLosses = 0;
  for (const trade of trades) {
    currentLosingStreak = trade.finalPnl < 0 ? currentLosingStreak + 1 : 0;
    maximumConsecutiveLosses = Math.max(maximumConsecutiveLosses, currentLosingStreak);
  }

  return {
    totalTrades: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winRate: trades.length === 0 ? 0 : winners.length / trades.length * 100,
    grossProfit,
    grossLoss,
    netProfit: trades.reduce((sum, trade) => sum + trade.finalPnl, 0),
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    expectancy: trades.length === 0
      ? 0
      : trades.reduce((sum, trade) => sum + trade.finalPnl, 0) / trades.length,
    averageR: trades.length === 0
      ? 0
      : trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length,
    totalFees: trades.reduce((sum, trade) => sum + trade.fees, 0),
    maximumDrawdown,
    maximumDrawdownPercent,
    maximumConsecutiveLosses,
    averageTradeDurationCandles: trades.length === 0
      ? 0
      : trades.reduce((sum, trade) => sum + trade.durationCandles, 0) / trades.length
  };
}

export interface RunBacktestRequest {
  readonly candles: readonly Candle[];
  readonly options: BacktestConfig;
  readonly evaluateSignal: SignalEvaluator;
  readonly evaluationWindow?: {
    readonly signalStartIndex: number;
    readonly endIndex: number;
  };
}

export function runBacktest(request: RunBacktestRequest): BacktestResult {
  const options: BacktestOptions = {
    ...DEFAULT_OPTIONS,
    ...request.options,
    partialExits: {
      ...DEFAULT_OPTIONS.partialExits,
      ...request.options.partialExits
    }
  };
  validateOptions(options);
  const candles = request.candles.filter((candle) => candle.closed);
  for (let index = 0; index < candles.length; index += 1) {
    assertCandle(candles[index]!, candles[index - 1]);
  }
  const signalStartIndex = request.evaluationWindow?.signalStartIndex ?? 0;
  const endIndex = request.evaluationWindow?.endIndex ?? candles.length - 1;
  if (
    (candles.length > 0 || request.evaluationWindow !== undefined) &&
      (!Number.isInteger(signalStartIndex) ||
        !Number.isInteger(endIndex) ||
        signalStartIndex < 0 ||
        endIndex < signalStartIndex ||
        endIndex >= candles.length)
  ) {
    throw new Error("Backtest evaluation window must be within the closed-candle data");
  }

  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const equity = { value: options.initialEquity };
  let active: ActiveTrade | undefined;
  let pending: BacktestSetup | undefined;
  let rejectedSignals = 0;
  let unfilledSignals = 0;

  for (let index = 0; index <= endIndex; index += 1) {
    const candle = candles[index]!;
    if (pending) {
      if (candle.openTime <= pending.signalTime) {
        throw new Error("Backtest entry candle must follow the signal candle");
      }
      const riskPrice = pending.side === "buy"
        ? Number(candle.open) - pending.stopPrice
        : pending.stopPrice - Number(candle.open);
      if (!Number.isFinite(riskPrice) || riskPrice <= 0) {
        rejectedSignals += 1;
      } else {
        const requestForSize = positionRequest(
          options,
          pending,
          equity.value,
          Number(candle.open),
          riskPrice
        );
        try {
          const sizing = calculatePositionSize(requestForSize);
          const direction = pending.side === "buy" ? 1 : -1;
          const entryFee = sizing.entryExecutionPrice *
            sizing.quantity *
            options.instrument.contractMultiplier *
            options.costs.feeRatePerSide;
          equity.value -= entryFee;
          const target1Quantity = roundDown(
            sizing.quantity * options.partialExits.target1Allocation,
            options.instrument.quantityStep
          );
          const target2Quantity = roundDown(
            sizing.quantity * options.partialExits.target2Allocation,
            options.instrument.quantityStep
          );
          const trade: ActiveTrade = {
            strategy: pending.strategy,
            side: pending.side,
            signalTime: pending.signalTime,
            entryTime: candle.openTime,
            entryIndex: index,
            entryPrice: sizing.entryExecutionPrice,
            initialStop: pending.stopPrice,
            initialRiskAmount: sizing.estimatedMaximumLoss,
            initialQuantity: sizing.quantity,
            target1Price: Number(candle.open) + direction * riskPrice * options.target1R,
            target2Price: Number(candle.open) + direction * riskPrice * options.target2R,
            target1Quantity,
            target2Quantity,
            exits: [],
            remainingQuantity: sizing.quantity,
            stopPrice: pending.stopPrice,
            stopReason: "stop_loss",
            target1Done: target1Quantity <= 0,
            target2Done: target2Quantity <= 0,
            pnl: -entryFee,
            grossPnl: 0,
            fees: entryFee
          };
          active = trade;
        } catch (error) {
          if (!(error instanceof PositionSizingError)) throw error;
          rejectedSignals += 1;
        }
      }
      pending = undefined;
    }

    if (active && processCandle(active, candle, index, candles, options, equity)) {
      trades.push(finishTrade(active, index));
      active = undefined;
    }

    if (!active && index >= signalStartIndex) {
      const visibleCandles = request.evaluateSignal.historyMode === "indexed-full"
        ? candles
        : candles.slice(0, index + 1);
      const setup = request.evaluateSignal(visibleCandles, index);
      if (setup) {
        if (setup.strategy !== options.strategy) {
          throw new Error("Signal evaluator returned a different strategy than the requested backtest");
        }
        if (setup.signalTime !== candle.closeTime) {
          throw new Error("Signal time must match the latest closed candle");
        }
        setupRiskPrice(setup, Number(candle.close));
        pending = setup;
      }
    }

    equityCurve.push({
      time: candle.closeTime,
      equity: markToMarket(equity.value, active, candle, options)
    });
  }

  if (pending) unfilledSignals += 1;
  if (active) {
    const lastIndex = endIndex;
    const last = candles[lastIndex]!;
    closeQuantity(
      active,
      active.remainingQuantity,
      Number(last.close),
      "end_of_data",
      last,
      lastIndex,
      options,
      equity
    );
    trades.push(finishTrade(active, lastIndex));
    active = undefined;
    equityCurve[equityCurve.length - 1] = {
      time: last.closeTime,
      equity: equity.value
    };
  }

  return {
    strategy: options.strategy,
    startingEquity: options.initialEquity,
    endingEquity: equity.value,
    rejectedSignals,
    unfilledSignals,
    trades,
    equityCurve,
    metrics: calculateMetrics(trades, equityCurve, options.initialEquity)
  };
}
