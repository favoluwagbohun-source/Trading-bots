import type { Candle } from "@crypto-signal/shared";
import { findConfirmedSwings } from "@crypto-signal/indicators";
import {
  calculatePositionSize,
  type InstrumentRules,
  type TradingCosts
} from "@crypto-signal/risk-engine";
import type { ReplaySnapshot } from "./replay-session.js";

export type PaperTradeStatus = "open" | "closed";
export type PaperTradeReason =
  | "entry"
  | "stop_loss"
  | "break_even_stop"
  | "trailing_stop"
  | "take_profit_1"
  | "take_profit_2"
  | "manual_close";

export interface PaperTradeEvent {
  readonly kind: "opened" | "partial_exit" | "closed" | "stop_moved";
  readonly reason: PaperTradeReason;
  readonly time: number;
  readonly price: number;
  readonly quantity: number;
  readonly fee: number;
  readonly netPnl: number;
}

export interface PaperTradeRecord {
  readonly signalId: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly status: PaperTradeStatus;
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly initialStop: number;
  readonly stopPrice: number;
  readonly target1Price: number;
  readonly target2Price: number;
  readonly initialQuantity: number;
  readonly remainingQuantity: number;
  readonly riskAmount: number;
  readonly finalPnl: number;
  readonly grossPnl: number;
  readonly fees: number;
  readonly events: readonly PaperTradeEvent[];
}

export interface ManualPaperTradeRequest {
  readonly signalId: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly stopPrice: number;
  readonly target2Price: number;
  readonly instrument: InstrumentRules;
  readonly costs: TradingCosts;
}

export interface PaperTradingOptions {
  readonly target1R: number;
  readonly target1Allocation: number;
  readonly target2Allocation: number;
  readonly breakEvenAtR: number;
  readonly trailingSwingLeftBars: number;
  readonly trailingSwingRightBars: number;
  readonly trailingStopBufferPercent: number;
}

interface MutablePaperTrade {
  signalId: string;
  symbol: string;
  side: "buy" | "sell";
  status: PaperTradeStatus;
  entryTime: number;
  entryCandleOpenTime: number;
  entryPrice: number;
  initialStop: number;
  stopPrice: number;
  stopReason: PaperTradeReason;
  target1Price: number;
  target2Price: number;
  target1Quantity: number;
  target2Quantity: number;
  target1Done: boolean;
  target2Done: boolean;
  initialQuantity: number;
  remainingQuantity: number;
  riskAmount: number;
  finalPnl: number;
  grossPnl: number;
  fees: number;
  instrument: InstrumentRules;
  costs: TradingCosts;
  events: PaperTradeEvent[];
}

const DEFAULT_OPTIONS: PaperTradingOptions = {
  target1R: 1.5,
  target1Allocation: 1 / 3,
  target2Allocation: 1 / 3,
  breakEvenAtR: 1,
  trailingSwingLeftBars: 2,
  trailingSwingRightBars: 2,
  trailingStopBufferPercent: 0
};

function roundDown(quantity: number, step: number): number {
  const text = step.toString().toLowerCase();
  const decimals = text.includes("e-")
    ? Number(text.split("e-")[1])
    : text.split(".")[1]?.length ?? 0;
  return Number((Math.floor(quantity / step + 1e-10) * step).toFixed(decimals));
}

function exitFill(
  price: number,
  side: "buy" | "sell",
  slippage: number
): number {
  return price * (side === "buy" ? 1 + slippage : 1 - slippage);
}

function validateOptions(options: PaperTradingOptions): void {
  if (
    !Number.isFinite(options.target1R) ||
    options.target1R <= 0 ||
    !Number.isFinite(options.target1Allocation) ||
    options.target1Allocation < 0 ||
    !Number.isFinite(options.target2Allocation) ||
    options.target2Allocation < 0 ||
    options.target1Allocation + options.target2Allocation > 1 ||
    !Number.isFinite(options.breakEvenAtR) ||
    options.breakEvenAtR <= 0 ||
    !Number.isInteger(options.trailingSwingLeftBars) ||
    options.trailingSwingLeftBars < 1 ||
    !Number.isInteger(options.trailingSwingRightBars) ||
    options.trailingSwingRightBars < 1 ||
    !Number.isFinite(options.trailingStopBufferPercent) ||
    options.trailingStopBufferPercent < 0
  ) {
    throw new Error("Paper-trading options are invalid");
  }
}

export class ManualPaperTradingLedger {
  readonly symbol: string;
  private equity: number;
  private lastProcessedOpenTime: number | undefined;
  private readonly trades = new Map<string, MutablePaperTrade>();
  private readonly options: PaperTradingOptions;

  constructor(
    symbol: string,
    initialEquity: number,
    requestedOptions: Partial<PaperTradingOptions> = {}
  ) {
    this.symbol = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9]{6,20}$/.test(this.symbol)) {
      throw new Error(`Invalid paper-trading symbol: ${symbol}`);
    }
    if (!Number.isFinite(initialEquity) || initialEquity <= 0) {
      throw new Error("Initial paper equity must be positive");
    }
    this.equity = initialEquity;
    this.options = { ...DEFAULT_OPTIONS, ...requestedOptions };
    validateOptions(this.options);
  }

  get balance(): number {
    return this.equity;
  }

  setBalance(balance: number): void {
    if (!Number.isFinite(balance) || balance <= 0) {
      throw new Error("Paper account balance must be positive");
    }
    if ([...this.trades.values()].some((trade) => trade.status === "open")) {
      throw new Error("Cannot change account balance while paper trades are open");
    }
    this.equity = balance;
  }

  openManualTrade(
    snapshot: ReplaySnapshot,
    request: ManualPaperTradeRequest
  ): PaperTradeRecord {
    const candle = this.requireCurrentSnapshot(snapshot);
    if (
      this.lastProcessedOpenTime !== undefined &&
      candle.openTime < this.lastProcessedOpenTime
    ) {
      throw new Error("Cannot open a paper trade from a stale replay snapshot");
    }
    if (request.symbol.trim().toUpperCase() !== this.symbol) {
      throw new Error("Manual trade symbol must match replay symbol");
    }
    const signalId = request.signalId.trim();
    if (!signalId) throw new Error("signalId is required");
    if (this.trades.has(signalId)) {
      throw new Error("Duplicate paper-trade signal id");
    }
    if ([...this.trades.values()].some(
      (trade) => trade.symbol === this.symbol && trade.status === "open"
    )) {
      throw new Error("Only one open paper trade per symbol is allowed");
    }

    const entryReference = Number(candle.close);
    const riskPrice = request.side === "buy"
      ? entryReference - request.stopPrice
      : request.stopPrice - entryReference;
    if (!Number.isFinite(riskPrice) || riskPrice <= 0) {
      throw new Error("Stop price is invalid for the manual trade direction");
    }
    const target2R = request.side === "buy"
      ? (request.target2Price - entryReference) / riskPrice
      : (entryReference - request.target2Price) / riskPrice;
    if (!Number.isFinite(target2R) || target2R <= this.options.target1R) {
      throw new Error("TP2 must be beyond TP1 in the trade direction");
    }
    const sizing = calculatePositionSize({
      equity: this.equity,
      side: request.side,
      entryPrice: entryReference,
      stopPrice: request.stopPrice,
      target2Price: request.target2Price,
      instrument: request.instrument,
      costs: request.costs
    });
    const direction = request.side === "buy" ? 1 : -1;
    const entryFee = sizing.entryExecutionPrice *
      sizing.quantity *
      request.instrument.contractMultiplier *
      request.costs.feeRatePerSide;
    this.equity -= entryFee;
    const target1Quantity = roundDown(
      sizing.quantity * this.options.target1Allocation,
      request.instrument.quantityStep
    );
    const target2Quantity = roundDown(
      sizing.quantity * this.options.target2Allocation,
      request.instrument.quantityStep
    );

    const trade: MutablePaperTrade = {
      signalId,
      symbol: this.symbol,
      side: request.side,
      status: "open",
      entryTime: candle.closeTime,
      entryCandleOpenTime: candle.openTime,
      entryPrice: sizing.entryExecutionPrice,
      initialStop: request.stopPrice,
      stopPrice: request.stopPrice,
      stopReason: "stop_loss",
      target1Price: entryReference + direction * riskPrice * this.options.target1R,
      target2Price: request.target2Price,
      target1Quantity,
      target2Quantity,
      target1Done: target1Quantity <= 0,
      target2Done: target2Quantity <= 0,
      initialQuantity: sizing.quantity,
      remainingQuantity: sizing.quantity,
      riskAmount: sizing.estimatedMaximumLoss,
      finalPnl: -entryFee,
      grossPnl: 0,
      fees: entryFee,
      instrument: request.instrument,
      costs: request.costs,
      events: [{
        kind: "opened",
        reason: "entry",
        time: candle.closeTime,
        price: sizing.entryExecutionPrice,
        quantity: sizing.quantity,
        fee: entryFee,
        netPnl: -entryFee
      }]
    };
    this.trades.set(trade.signalId, trade);
    this.lastProcessedOpenTime = candle.openTime;
    return this.toRecord(trade);
  }

  advance(snapshot: ReplaySnapshot): readonly PaperTradeRecord[] {
    this.requireCurrentSnapshot(snapshot);
    const currentTime = snapshot.currentCandle.openTime;
    if (this.lastProcessedOpenTime === currentTime) return this.listTrades();
    if (this.lastProcessedOpenTime === undefined) {
      this.lastProcessedOpenTime = currentTime;
      return this.listTrades();
    }

    const previousIndex = snapshot.visibleCandles.findIndex(
      (candle) => candle.openTime === this.lastProcessedOpenTime
    );
    if (previousIndex < 0) {
      throw new Error("Replay snapshot does not contain the last processed candle");
    }
    for (let index = previousIndex + 1; index < snapshot.visibleCandles.length; index += 1) {
      const candle = snapshot.visibleCandles[index]!;
      this.processCandle(snapshot.visibleCandles.slice(0, index + 1), candle);
      this.lastProcessedOpenTime = candle.openTime;
    }
    return this.listTrades();
  }

  closeManualTrade(signalId: string, snapshot: ReplaySnapshot): PaperTradeRecord {
    const candle = this.requireCurrentSnapshot(snapshot);
    const trade = this.trades.get(signalId);
    if (!trade) throw new Error("Unknown paper trade");
    this.advance(snapshot);
    if (trade.status !== "open") return this.toRecord(trade);
    if (candle.openTime <= trade.entryCandleOpenTime) {
      throw new Error("Manual trade cannot be closed on its entry candle");
    }
    this.closeQuantity(
      trade,
      trade.remainingQuantity,
      Number(candle.close),
      "manual_close",
      "closed",
      candle.closeTime
    );
    return this.toRecord(trade);
  }

  listTrades(): readonly PaperTradeRecord[] {
    return Object.freeze([...this.trades.values()].map((trade) => this.toRecord(trade)));
  }

  private processCandle(visibleCandles: readonly Candle[], candle: Candle): void {
    for (const trade of this.trades.values()) {
      if (trade.status !== "open" || candle.openTime <= trade.entryCandleOpenTime) continue;
      const high = Number(candle.high);
      const low = Number(candle.low);
      const open = Number(candle.open);
      const stopTouched = trade.side === "buy"
        ? low <= trade.stopPrice
        : high >= trade.stopPrice;
      if (stopTouched) {
        const gapThroughStop = trade.side === "buy"
          ? open <= trade.stopPrice
          : open >= trade.stopPrice;
        this.closeQuantity(
          trade,
          trade.remainingQuantity,
          gapThroughStop ? open : trade.stopPrice,
          trade.stopReason,
          "closed",
          candle.closeTime
        );
        continue;
      }

      const initialRiskPrice = Math.abs(trade.entryPrice - trade.initialStop);
      const reachedBreakEven = trade.side === "buy"
        ? high >= trade.entryPrice + initialRiskPrice * this.options.breakEvenAtR
        : low <= trade.entryPrice - initialRiskPrice * this.options.breakEvenAtR;
      const breakEvenTouched = trade.side === "buy"
        ? low <= trade.entryPrice
        : high >= trade.entryPrice;
      if (reachedBreakEven && breakEvenTouched) {
        this.closeQuantity(
          trade,
          trade.remainingQuantity,
          trade.entryPrice,
          "break_even_stop",
          "closed",
          candle.closeTime
        );
        continue;
      }

      const target1Touched = trade.side === "buy"
        ? high >= trade.target1Price
        : low <= trade.target1Price;
      if (!trade.target1Done && target1Touched && trade.target1Quantity > 0) {
        this.closeQuantity(
          trade,
          trade.target1Quantity,
          trade.target1Price,
          "take_profit_1",
          trade.target1Quantity >= trade.remainingQuantity ? "closed" : "partial_exit",
          candle.closeTime
        );
        trade.target1Done = true;
      }

      const target2Touched = trade.side === "buy"
        ? high >= trade.target2Price
        : low <= trade.target2Price;
      if (
        trade.status === "open" &&
        !trade.target2Done &&
        target2Touched &&
        trade.target2Quantity > 0
      ) {
        this.closeQuantity(
          trade,
          trade.target2Quantity,
          trade.target2Price,
          "take_profit_2",
          trade.target2Quantity >= trade.remainingQuantity ? "closed" : "partial_exit",
          candle.closeTime
        );
        trade.target2Done = true;
      }
      if (trade.status === "open") this.updateProtectiveStop(trade, visibleCandles, candle);
    }
  }

  private updateProtectiveStop(
    trade: MutablePaperTrade,
    visibleCandles: readonly Candle[],
    candle: Candle
  ): void {
    const initialRisk = Math.abs(trade.entryPrice - trade.initialStop);
    const favorable = trade.side === "buy" ? Number(candle.high) : Number(candle.low);
    const hitBreakEven = trade.side === "buy"
      ? favorable >= trade.entryPrice + initialRisk * this.options.breakEvenAtR
      : favorable <= trade.entryPrice - initialRisk * this.options.breakEvenAtR;
    if (hitBreakEven) {
      const improves = trade.side === "buy"
        ? trade.stopPrice < trade.entryPrice
        : trade.stopPrice > trade.entryPrice;
      if (improves) {
        trade.stopPrice = trade.entryPrice;
        trade.stopReason = "break_even_stop";
        trade.events.push({
          kind: "stop_moved",
          reason: "break_even_stop",
          time: candle.closeTime,
          price: trade.stopPrice,
          quantity: 0,
          fee: 0,
          netPnl: 0
        });
      }
    }

    const swings = findConfirmedSwings(visibleCandles, {
      leftBars: this.options.trailingSwingLeftBars,
      rightBars: this.options.trailingSwingRightBars
    });
    const direction = trade.side === "buy" ? "low" : "high";
    const swing = [...swings].reverse().find((item) => item.direction === direction);
    if (!swing) return;
    const buffer = swing.price * this.options.trailingStopBufferPercent / 100;
    const candidateStop = trade.side === "buy"
      ? swing.price - buffer
      : swing.price + buffer;
    const improves = trade.side === "buy"
      ? candidateStop > trade.stopPrice && candidateStop < Number(candle.close)
      : candidateStop < trade.stopPrice && candidateStop > Number(candle.close);
    if (improves) {
      trade.stopPrice = candidateStop;
      trade.stopReason = "trailing_stop";
      trade.events.push({
        kind: "stop_moved",
        reason: "trailing_stop",
        time: candle.closeTime,
        price: trade.stopPrice,
        quantity: 0,
        fee: 0,
        netPnl: 0
      });
    }
  }

  private closeQuantity(
    trade: MutablePaperTrade,
    quantity: number,
    triggerPrice: number,
    reason: PaperTradeReason,
    kind: "partial_exit" | "closed",
    time: number
  ): void {
    const amount = Math.min(quantity, trade.remainingQuantity);
    if (amount <= 0) return;
    const exitSide = trade.side === "buy" ? "sell" : "buy";
    const price = exitFill(triggerPrice, exitSide, trade.costs.slippageRatePerSide);
    const direction = trade.side === "buy" ? 1 : -1;
    const grossPnl = (price - trade.entryPrice) *
      direction *
      amount *
      trade.instrument.contractMultiplier;
    const fee = price *
      amount *
      trade.instrument.contractMultiplier *
      trade.costs.feeRatePerSide;
    const netPnl = grossPnl - fee;
    trade.finalPnl += netPnl;
    trade.grossPnl += grossPnl;
    trade.fees += fee;
    trade.remainingQuantity = Number((trade.remainingQuantity - amount).toFixed(12));
    const isClosed = trade.remainingQuantity <= 0;
    if (isClosed) trade.status = "closed";
    trade.events.push({
      kind: isClosed ? "closed" : kind,
      reason,
      time,
      price,
      quantity: amount,
      fee,
      netPnl
    });
    this.equity += netPnl;
  }

  private requireCurrentSnapshot(snapshot: ReplaySnapshot): Candle {
    if (snapshot.symbol !== this.symbol) {
      throw new Error("Replay snapshot symbol does not match paper account");
    }
    const current = snapshot.currentCandle;
    const lastVisible = snapshot.visibleCandles.at(-1);
    if (
      !current.closed ||
      !lastVisible ||
      snapshot.index < 0 ||
      snapshot.index >= snapshot.totalCandles ||
      snapshot.visibleCandles.length !== snapshot.index + 1 ||
      lastVisible.openTime !== current.openTime ||
      snapshot.visibleCandles.some((candle) => candle.openTime > current.openTime)
    ) {
      throw new Error("Replay snapshot is invalid or exposes future candles");
    }
    return current;
  }

  private toRecord(trade: MutablePaperTrade): PaperTradeRecord {
    return Object.freeze({
      signalId: trade.signalId,
      symbol: trade.symbol,
      side: trade.side,
      status: trade.status,
      entryTime: trade.entryTime,
      entryPrice: trade.entryPrice,
      initialStop: trade.initialStop,
      stopPrice: trade.stopPrice,
      target1Price: trade.target1Price,
      target2Price: trade.target2Price,
      initialQuantity: trade.initialQuantity,
      remainingQuantity: trade.remainingQuantity,
      riskAmount: trade.riskAmount,
      finalPnl: trade.finalPnl,
      grossPnl: trade.grossPnl,
      fees: trade.fees,
      events: Object.freeze(trade.events.map((event) => Object.freeze({ ...event })))
    });
  }
}
