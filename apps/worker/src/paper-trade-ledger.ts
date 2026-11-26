import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { findConfirmedSwings } from "@crypto-signal/indicators";
import type { Candle, StrategyId } from "@crypto-signal/shared";

const CANDLE_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TARGET1_ALLOCATION = 1 / 3;
const DEFAULT_TARGET2_ALLOCATION = 1 / 3;

export type PaperTradeEventType =
  | "signal_opened"
  | "tp1_reached"
  | "tp2_reached"
  | "tp3_reached"
  | "stop_loss_reached"
  | "trailing_stop_moved"
  | "trade_closed"
  | "setup_invalidated";

export type PaperTradeDeliveryStatus = "pending" | "claimed" | "delivered";
export type ManagedTradeStatus = "active" | "closed";

export interface OpenPaperTradeInput {
  readonly signalId: string;
  readonly chatId: number;
  readonly symbol: string;
  readonly strategy: StrategyId;
  readonly side: "buy" | "sell";
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly target1: number;
  readonly target2: number;
  readonly quantity: number;
  readonly entryCandleOpenTime: number;
  readonly target1Allocation?: number;
  readonly target2Allocation?: number;
  readonly trailingSwingLeftBars?: number;
  readonly trailingSwingRightBars?: number;
  readonly trailingStopBufferPercent?: number;
}

export interface ManagedPaperTrade {
  readonly signalId: string;
  readonly chatId: number;
  readonly symbol: string;
  readonly strategy: StrategyId;
  readonly side: "buy" | "sell";
  readonly entryPrice: number;
  readonly initialStopLoss: number;
  readonly stopPrice: number;
  readonly target1: number;
  readonly target2: number;
  readonly quantity: number;
  readonly remainingQuantity: number;
  readonly entryCandleOpenTime: number;
  readonly target1Allocation: number;
  readonly target2Allocation: number;
  readonly target1Reached: boolean;
  readonly target2Reached: boolean;
  readonly breakEvenMoved: boolean;
  readonly trailingSwingLeftBars: number;
  readonly trailingSwingRightBars: number;
  readonly trailingStopBufferPercent: number;
  readonly status: ManagedTradeStatus;
  readonly closedAt?: number;
  readonly closeReason?: string;
}

export interface PaperTradeEvent {
  readonly eventId: string;
  readonly signalId: string;
  readonly chatId: number;
  readonly symbol: string;
  readonly type: PaperTradeEventType;
  readonly occurredAt: number;
  readonly snapshotId: string;
  readonly price?: number;
  readonly details: string;
  readonly deliveryStatus: PaperTradeDeliveryStatus;
}

export interface InvalidatePaperSetupInput {
  readonly signalId: string;
  readonly chatId: number;
  readonly symbol: string;
  readonly occurredAt: number;
  readonly snapshotId: string;
  readonly details: string;
}

interface PersistedTradeLedger {
  readonly version: 1;
  readonly trades: readonly ManagedPaperTrade[];
  readonly events: readonly PaperTradeEvent[];
  readonly lastProcessedOpenTimeBySymbol: Readonly<Record<string, number>>;
  readonly invalidatedSignalIds: readonly string[];
}

export interface PaperTradeLedgerOptions {
  readonly filePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function isStrategy(value: unknown): value is StrategyId {
  return value === "top_down_trendline" ||
    value === "break_and_retest" ||
    value === "liquidity_sweep_reversal" ||
    value === "order_block_retest";
}

function isManagedTrade(value: unknown): value is ManagedPaperTrade {
  return isRecord(value) &&
    typeof value.signalId === "string" &&
    Number.isSafeInteger(value.chatId) &&
    typeof value.symbol === "string" &&
    isStrategy(value.strategy) &&
    (value.side === "buy" || value.side === "sell") &&
    positive(value.entryPrice) &&
    positive(value.initialStopLoss) &&
    positive(value.stopPrice) &&
    positive(value.target1) &&
    positive(value.target2) &&
    positive(value.quantity) &&
    finite(value.remainingQuantity) &&
    value.remainingQuantity >= 0 &&
    finite(value.entryCandleOpenTime) &&
    finite(value.target1Allocation) &&
    finite(value.target2Allocation) &&
    typeof value.target1Reached === "boolean" &&
    typeof value.target2Reached === "boolean" &&
    typeof value.breakEvenMoved === "boolean" &&
    Number.isInteger(value.trailingSwingLeftBars) &&
    Number.isInteger(value.trailingSwingRightBars) &&
    finite(value.trailingStopBufferPercent) &&
    (value.status === "active" || value.status === "closed");
}

function isPaperTradeEvent(value: unknown): value is PaperTradeEvent {
  return isRecord(value) &&
    typeof value.eventId === "string" &&
    typeof value.signalId === "string" &&
    Number.isSafeInteger(value.chatId) &&
    typeof value.symbol === "string" &&
    [
      "signal_opened",
      "tp1_reached",
      "tp2_reached",
      "tp3_reached",
      "stop_loss_reached",
      "trailing_stop_moved",
      "trade_closed",
      "setup_invalidated"
    ].includes(String(value.type)) &&
    finite(value.occurredAt) &&
    typeof value.snapshotId === "string" &&
    (value.price === undefined || positive(value.price)) &&
    typeof value.details === "string" &&
    ["pending", "claimed", "delivered"].includes(String(value.deliveryStatus));
}

function validateSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(normalized)) {
    throw new Error(`Invalid paper-trade symbol: ${symbol}`);
  }
  return normalized;
}

function validateClosedCandle(candle: Candle): void {
  const values = [candle.open, candle.high, candle.low, candle.close].map(Number);
  if (
    !candle.closed ||
    !Number.isFinite(candle.openTime) ||
    !Number.isFinite(candle.closeTime) ||
    candle.closeTime <= candle.openTime ||
    !values.every((value) => Number.isFinite(value) && value > 0) ||
    values[2]! > values[0]! ||
    values[2]! > values[3]! ||
    values[1]! < values[0]! ||
    values[1]! < values[3]! ||
    values[1]! < values[2]!
  ) {
    throw new Error("Paper-trade monitor received an invalid closed candle");
  }
}

export class PaperTradeLedger {
  private readonly trades = new Map<string, ManagedPaperTrade>();
  private readonly events = new Map<string, PaperTradeEvent>();
  private readonly lastProcessedOpenTimeBySymbol = new Map<string, number>();
  private readonly invalidatedSignalIds = new Set<string>();

  constructor(private readonly options: PaperTradeLedgerOptions) {
    if (!options.filePath.trim()) throw new Error("Paper-trade ledger file path is required");
    this.load();
  }

  openTrade(input: OpenPaperTradeInput): ManagedPaperTrade {
    const symbol = validateSymbol(input.symbol);
    if (!input.signalId.trim() || !Number.isSafeInteger(input.chatId)) {
      throw new Error("Paper trade requires a signal ID and valid Telegram chat ID");
    }
    if (
      ![input.entryPrice, input.stopLoss, input.target1, input.target2, input.quantity]
        .every((value) => Number.isFinite(value) && value > 0) ||
      !Number.isFinite(input.entryCandleOpenTime)
    ) {
      throw new Error("Paper-trade prices, quantity, and entry time must be valid");
    }
    const risk = input.side === "buy"
      ? input.entryPrice - input.stopLoss
      : input.stopLoss - input.entryPrice;
    const reward1 = input.side === "buy"
      ? input.target1 - input.entryPrice
      : input.entryPrice - input.target1;
    const reward2 = input.side === "buy"
      ? input.target2 - input.entryPrice
      : input.entryPrice - input.target2;
    if (
      risk <= 0 ||
      reward1 <= 0 ||
      reward1 >= reward2 ||
      reward2 / risk < 2
    ) {
      throw new Error("Paper-trade stop and targets must be correctly ordered with TP2 at least 2R");
    }

    const target1Allocation = input.target1Allocation ?? DEFAULT_TARGET1_ALLOCATION;
    const target2Allocation = input.target2Allocation ?? DEFAULT_TARGET2_ALLOCATION;
    const trailingSwingLeftBars = input.trailingSwingLeftBars ?? 2;
    const trailingSwingRightBars = input.trailingSwingRightBars ?? 2;
    const trailingStopBufferPercent = input.trailingStopBufferPercent ?? 0;
    if (
      !Number.isFinite(target1Allocation) ||
      target1Allocation < 0 ||
      !Number.isFinite(target2Allocation) ||
      target2Allocation < 0 ||
      target1Allocation + target2Allocation > 1 ||
      !Number.isInteger(trailingSwingLeftBars) ||
      trailingSwingLeftBars < 1 ||
      !Number.isInteger(trailingSwingRightBars) ||
      trailingSwingRightBars < 1 ||
      !Number.isFinite(trailingStopBufferPercent) ||
      trailingStopBufferPercent < 0
    ) {
      throw new Error("Paper-trade management options are invalid");
    }

    const tradeKey = this.tradeKey(input.chatId, input.signalId);
    if (this.trades.has(tradeKey) || this.invalidatedSignalIds.has(tradeKey)) {
      throw new Error("Signal has already been opened or invalidated");
    }
    const lastProcessed = this.lastProcessedOpenTimeBySymbol.get(symbol);
    if (lastProcessed !== undefined && input.entryCandleOpenTime <= lastProcessed) {
      throw new Error("Paper trade entry candle has already been processed");
    }
    if ([...this.trades.values()].some((trade) =>
      trade.chatId === input.chatId &&
      trade.symbol === symbol &&
      trade.status === "active"
    )) {
      throw new Error("Only one active paper trade per chat and symbol is allowed");
    }

    const trade: ManagedPaperTrade = {
      signalId: input.signalId,
      chatId: input.chatId,
      symbol,
      strategy: input.strategy,
      side: input.side,
      entryPrice: input.entryPrice,
      initialStopLoss: input.stopLoss,
      stopPrice: input.stopLoss,
      target1: input.target1,
      target2: input.target2,
      quantity: input.quantity,
      remainingQuantity: input.quantity,
      entryCandleOpenTime: input.entryCandleOpenTime,
      target1Allocation,
      target2Allocation,
      target1Reached: false,
      target2Reached: false,
      breakEvenMoved: false,
      trailingSwingLeftBars,
      trailingSwingRightBars,
      trailingStopBufferPercent,
      status: "active"
    };

    return this.transaction(() => {
      this.trades.set(tradeKey, trade);
      this.addEvent({
        eventId: `${tradeKey}:signal_opened`,
        signalId: input.signalId,
        chatId: input.chatId,
        symbol,
        type: "signal_opened",
        occurredAt: input.entryCandleOpenTime,
        snapshotId: `${symbol}:5m:${input.entryCandleOpenTime}`,
        price: input.entryPrice,
        details: `${symbol} ${input.side.toUpperCase()} paper trade opened.`,
        deliveryStatus: "pending"
      });
      return trade;
    });
  }

  invalidateSetup(input: InvalidatePaperSetupInput): boolean {
    const symbol = validateSymbol(input.symbol);
    if (
      !input.signalId.trim() ||
      !Number.isSafeInteger(input.chatId) ||
      !Number.isFinite(input.occurredAt) ||
      !input.snapshotId.trim() ||
      !input.details.trim()
    ) {
      throw new Error("Setup invalidation event is incomplete");
    }
    const key = this.tradeKey(input.chatId, input.signalId);
    if (this.trades.has(key)) {
      throw new Error("An opened paper trade cannot be marked as a pre-entry invalidation");
    }
    if (this.invalidatedSignalIds.has(key)) return false;
    return this.transaction(() => {
      this.invalidatedSignalIds.add(key);
      this.addEvent({
        eventId: `${key}:setup_invalidated`,
        signalId: input.signalId,
        chatId: input.chatId,
        symbol,
        type: "setup_invalidated",
        occurredAt: input.occurredAt,
        snapshotId: input.snapshotId,
        details: input.details.trim(),
        deliveryStatus: "pending"
      });
      return true;
    });
  }

  processClosedCandles(symbolInput: string, candles: readonly Candle[]): PaperTradeEvent[] {
    const symbol = validateSymbol(symbolInput);
    const closedCandles = candles.filter((candle) => candle.closed).slice().sort(
      (a, b) => a.openTime - b.openTime
    );
    for (let index = 0; index < closedCandles.length; index += 1) {
      validateClosedCandle(closedCandles[index]!);
      if (index > 0 && closedCandles[index]!.openTime === closedCandles[index - 1]!.openTime) {
        throw new Error("Paper-trade monitor received duplicate candle open times");
      }
    }

    const initialEventIds = new Set(this.events.keys());
    const lastProcessed = this.lastProcessedOpenTimeBySymbol.get(symbol);
    if (!closedCandles.some((candle) =>
      lastProcessed === undefined || candle.openTime > lastProcessed
    )) return [];

    this.transaction(() => {
      for (const candle of closedCandles) {
        const checkpoint = this.lastProcessedOpenTimeBySymbol.get(symbol);
        if (checkpoint !== undefined && candle.openTime <= checkpoint) continue;
        if (checkpoint !== undefined && candle.openTime !== checkpoint + CANDLE_INTERVAL_MS) {
          throw new Error(`Missing 5-minute candles after ${checkpoint} for ${symbol}`);
        }
        const history = closedCandles.filter((item) => item.closeTime <= candle.closeTime);
        for (const [key, trade] of this.trades) {
          if (
            trade.symbol !== symbol ||
            trade.status !== "active" ||
            candle.openTime <= trade.entryCandleOpenTime
          ) continue;
          this.processTradeCandle(key, trade, candle, history);
        }
        this.lastProcessedOpenTimeBySymbol.set(symbol, candle.openTime);
      }
    });
    return [...this.events.values()]
      .filter((event) => !initialEventIds.has(event.eventId))
      .map((event) => Object.freeze({ ...event }));
  }

  getActiveTrades(chatId?: number): readonly ManagedPaperTrade[] {
    return [...this.trades.values()]
      .filter((trade) =>
        trade.status === "active" && (chatId === undefined || trade.chatId === chatId)
      )
      .map((trade) => Object.freeze({ ...trade }));
  }

  getEvents(options: {
    readonly chatId?: number;
    readonly deliveryStatus?: PaperTradeDeliveryStatus;
  } = {}): readonly PaperTradeEvent[] {
    return [...this.events.values()]
      .filter((event) =>
        (options.chatId === undefined || event.chatId === options.chatId) &&
        (options.deliveryStatus === undefined || event.deliveryStatus === options.deliveryStatus)
      )
      .map((event) => Object.freeze({ ...event }));
  }

  claimEventDelivery(eventId: string): boolean {
    const event = this.events.get(eventId);
    if (!event) throw new Error(`Unknown paper-trade event: ${eventId}`);
    if (event.deliveryStatus !== "pending") return false;
    return this.transaction(() => {
      this.events.set(eventId, { ...event, deliveryStatus: "claimed" });
      return true;
    });
  }

  markEventDelivered(eventId: string): void {
    const event = this.events.get(eventId);
    if (!event) throw new Error(`Unknown paper-trade event: ${eventId}`);
    if (event.deliveryStatus !== "claimed") {
      throw new Error("Paper-trade event must be claimed before it is marked delivered");
    }
    this.transaction(() => {
      this.events.set(eventId, { ...event, deliveryStatus: "delivered" });
    });
  }

  private processTradeCandle(
    tradeKey: string,
    trade: ManagedPaperTrade,
    candle: Candle,
    history: readonly Candle[]
  ): void {
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const stopHit = trade.side === "buy" ? low <= trade.stopPrice : high >= trade.stopPrice;
    if (stopHit) {
      const gapThroughStop = trade.side === "buy" ? open <= trade.stopPrice : open >= trade.stopPrice;
      const exitPrice = gapThroughStop ? open : trade.stopPrice;
      if (
        trade.target2Reached &&
        (trade.side === "buy" ? exitPrice > trade.entryPrice : exitPrice < trade.entryPrice)
      ) {
        this.addCandleEvent(trade, candle, "tp3_reached", exitPrice, "Trailing runner exited in profit.");
      }
      const stopDescription = trade.stopPrice === trade.initialStopLoss
        ? "initial stop"
        : trade.stopPrice === trade.entryPrice
          ? "break-even stop"
          : "trailing stop";
      this.addCandleEvent(
        trade,
        candle,
        "stop_loss_reached",
        exitPrice,
        `${stopDescription} reached at ${exitPrice}; ${trade.remainingQuantity} units exited.`
      );
      this.closeTrade(tradeKey, trade, candle, `stop at ${exitPrice}`, exitPrice);
      return;
    }

    const direction = trade.side === "buy" ? 1 : -1;
    const initialRisk = Math.abs(trade.entryPrice - trade.initialStopLoss);
    const favorablePrice = trade.side === "buy" ? high : low;
    const reachedOneR = (favorablePrice - trade.entryPrice) * direction >= initialRisk;
    let updated = trade;
    if (reachedOneR && !trade.breakEvenMoved) {
      const improves = trade.side === "buy"
        ? trade.stopPrice < trade.entryPrice
        : trade.stopPrice > trade.entryPrice;
      updated = {
        ...trade,
        stopPrice: improves ? trade.entryPrice : trade.stopPrice,
        breakEvenMoved: true
      };
      if (improves) {
        this.addCandleEvent(
          updated,
          candle,
          "trailing_stop_moved",
          updated.stopPrice,
          `Stop moved to break-even at ${updated.stopPrice} after +1R.`
        );
      }
    }

    const target1Hit = trade.side === "buy"
      ? high >= trade.target1
      : low <= trade.target1;
    if (target1Hit && !trade.target1Reached) {
      updated = { ...updated, target1Reached: true };
      this.addCandleEvent(
        updated,
        candle,
        "tp1_reached",
        trade.target1,
        `TP1 reached at ${trade.target1}.`
      );
    }

    const target2Hit = trade.side === "buy"
      ? high >= trade.target2
      : low <= trade.target2;
    if (target2Hit && !trade.target2Reached) {
      updated = { ...updated, target2Reached: true };
      this.addCandleEvent(
        updated,
        candle,
        "tp2_reached",
        trade.target2,
        `TP2 reached at ${trade.target2}; trailing runner remains active.`
      );
    }

    const closedAllocation = (updated.target1Reached ? updated.target1Allocation : 0) +
      (updated.target2Reached ? updated.target2Allocation : 0);
    const remainingQuantity = Math.max(0, updated.quantity * (1 - closedAllocation));
    updated = { ...updated, remainingQuantity };
    if (remainingQuantity <= updated.quantity * 1e-10) {
      const exitPrice = updated.target2Reached ? updated.target2 : updated.target1;
      this.closeTrade(tradeKey, updated, candle, "target allocations complete", exitPrice);
      return;
    }

    this.trades.set(tradeKey, updated);
    if (updated.target1Reached) {
      this.moveTrailingStop(tradeKey, updated, candle, history);
    }
  }

  private moveTrailingStop(
    tradeKey: string,
    trade: ManagedPaperTrade,
    candle: Candle,
    history: readonly Candle[]
  ): void {
    const swings = findConfirmedSwings(history, {
      leftBars: trade.trailingSwingLeftBars,
      rightBars: trade.trailingSwingRightBars
    });
    const direction = trade.side === "buy" ? "low" : "high";
    const swing = [...swings].reverse().find((point) =>
      point.direction === direction && point.confirmedAt <= candle.closeTime
    );
    if (!swing) return;
    const buffer = swing.price * trade.trailingStopBufferPercent / 100;
    const proposedStop = trade.side === "buy" ? swing.price - buffer : swing.price + buffer;
    const close = Number(candle.close);
    const improves = trade.side === "buy"
      ? proposedStop > trade.stopPrice && proposedStop < close
      : proposedStop < trade.stopPrice && proposedStop > close;
    if (!improves) return;

    this.trades.set(tradeKey, { ...trade, stopPrice: proposedStop });
    this.addCandleEvent(
      trade,
      candle,
      "trailing_stop_moved",
      proposedStop,
      `Stop advanced to confirmed swing at ${proposedStop}.`
    );
  }

  private closeTrade(
    tradeKey: string,
    trade: ManagedPaperTrade,
    candle: Candle,
    reason: string,
    exitPrice: number
  ): void {
    this.trades.set(tradeKey, {
      ...trade,
      remainingQuantity: 0,
      status: "closed",
      closedAt: candle.closeTime,
      closeReason: reason
    });
    this.addCandleEvent(
      trade,
      candle,
      "trade_closed",
      exitPrice,
      `Paper trade closed: ${reason}.`
    );
  }

  private addCandleEvent(
    trade: ManagedPaperTrade,
    candle: Candle,
    type: PaperTradeEventType,
    price: number,
    details: string
  ): void {
    const eventId = `${this.tradeKey(trade.chatId, trade.signalId)}:${type}:${candle.openTime}:${price}`;
    this.addEvent({
      eventId,
      signalId: trade.signalId,
      chatId: trade.chatId,
      symbol: trade.symbol,
      type,
      occurredAt: candle.closeTime,
      snapshotId: `${trade.symbol}:5m:${candle.openTime}`,
      price,
      details,
      deliveryStatus: "pending"
    });
  }

  private addEvent(event: PaperTradeEvent): void {
    if (this.events.has(event.eventId)) {
      throw new Error(`Duplicate paper-trade event ID: ${event.eventId}`);
    }
    this.events.set(event.eventId, event);
  }

  private tradeKey(chatId: number, signalId: string): string {
    return `${chatId}:${signalId}`;
  }

  private transaction<T>(operation: () => T): T {
    const previousTrades = new Map(
      [...this.trades].map(([key, trade]) => [key, { ...trade }])
    );
    const previousEvents = new Map(
      [...this.events].map(([key, event]) => [key, { ...event }])
    );
    const previousLastProcessed = new Map(this.lastProcessedOpenTimeBySymbol);
    const previousInvalidated = new Set(this.invalidatedSignalIds);
    try {
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      this.trades.clear();
      for (const [key, trade] of previousTrades) this.trades.set(key, trade);
      this.events.clear();
      for (const [key, event] of previousEvents) this.events.set(key, event);
      this.lastProcessedOpenTimeBySymbol.clear();
      for (const [symbol, time] of previousLastProcessed) {
        this.lastProcessedOpenTimeBySymbol.set(symbol, time);
      }
      this.invalidatedSignalIds.clear();
      for (const key of previousInvalidated) this.invalidatedSignalIds.add(key);
      throw error;
    }
  }

  private load(): void {
    let content: string;
    try {
      content = readFileSync(this.options.filePath, "utf8");
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`Paper-trade ledger contains invalid JSON: ${String(error)}`);
    }
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Array.isArray(value.trades) ||
      !value.trades.every(isManagedTrade) ||
      !Array.isArray(value.events) ||
      !value.events.every(isPaperTradeEvent) ||
      !isRecord(value.lastProcessedOpenTimeBySymbol) ||
      !Array.isArray(value.invalidatedSignalIds) ||
      !value.invalidatedSignalIds.every((item) => typeof item === "string")
    ) {
      throw new Error("Paper-trade ledger has an unsupported or malformed schema");
    }

    for (const trade of value.trades) {
      const key = this.tradeKey(trade.chatId, trade.signalId);
      if (this.trades.has(key)) throw new Error(`Duplicate trade record in ledger: ${key}`);
      this.trades.set(key, trade);
    }
    for (const event of value.events) {
      if (this.events.has(event.eventId)) {
        throw new Error(`Duplicate event record in ledger: ${event.eventId}`);
      }
      this.events.set(event.eventId, event);
    }
    for (const [symbol, time] of Object.entries(value.lastProcessedOpenTimeBySymbol)) {
      if (!/^[A-Z0-9]{6,20}$/.test(symbol) || !finite(time)) {
        throw new Error("Paper-trade ledger contains invalid candle checkpoints");
      }
      this.lastProcessedOpenTimeBySymbol.set(symbol, time);
    }
    for (const key of value.invalidatedSignalIds) this.invalidatedSignalIds.add(key);
  }

  private persist(): void {
    const directory = dirname(this.options.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const snapshot: PersistedTradeLedger = {
      version: 1,
      trades: [...this.trades.values()],
      events: [...this.events.values()],
      lastProcessedOpenTimeBySymbol: Object.fromEntries(this.lastProcessedOpenTimeBySymbol),
      invalidatedSignalIds: [...this.invalidatedSignalIds]
    };
    const temporaryPath = `${this.options.filePath}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const descriptor = openSync(temporaryPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(snapshot), "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.options.filePath);
      renamed = true;
    } finally {
      if (!renamed && existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}
