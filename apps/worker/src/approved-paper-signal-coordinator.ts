import {
  PortfolioRiskError,
  PortfolioRiskManager,
  PositionSizingError,
  type PortfolioLimits,
  type TradingCosts
} from "@crypto-signal/risk-engine";
import type { Candle } from "@crypto-signal/shared";
import type { BinanceRestClient } from "@crypto-signal/market-data";
import {
  TelegramSignalPublisher,
  type PreparedPaperSignal,
  type PaperTradeUpdate,
  type TelegramUserStateStore
} from "@crypto-signal/telegram";
import type { TelegramApiClient } from "@crypto-signal/telegram";
import { PaperTradeLedger, type ManagedPaperTrade } from "./paper-trade-ledger.js";
import { renderSignalChart } from "./chart-image.js";
import type { SignalChart } from "./market-analysis.js";
import { scoreSignalQuality, type StrategyQualityEvidence } from "./signal-quality.js";
import { SignalRiskGate } from "./signal-risk-gate.js";
import type { SignalCandidate } from "./signal-scanner.js";

export interface ApprovedPaperSignalCoordinatorOptions {
  readonly api: Pick<TelegramApiClient, "sendPhoto">;
  readonly users: TelegramUserStateStore;
  readonly ledger: PaperTradeLedger;
  readonly marketData: Pick<BinanceRestClient, "getInstrumentRules">;
  readonly costs: TradingCosts;
  readonly limits: PortfolioLimits;
  readonly evidence: Partial<Record<SignalCandidate["strategy"], StrategyQualityEvidence>>;
  readonly correlationGroupForSymbol: (symbol: string) => string;
  readonly onRejected: (
    chatId: number | undefined,
    candidate: SignalCandidate,
    reason: string
  ) => void;
  readonly onDeliverySuccess?: (eventId: string) => void;
  readonly onDeliveryError?: (eventId: string, error: unknown) => void;
}

interface UserApproval {
  readonly chatId: number;
  readonly gate: SignalRiskGate;
  readonly approval: ReturnType<SignalRiskGate["approve"]>;
  readonly instrument: Awaited<ReturnType<BinanceRestClient["getInstrumentRules"]>>;
}

function isRiskRejection(error: unknown): error is PortfolioRiskError | PositionSizingError {
  return error instanceof PortfolioRiskError || error instanceof PositionSizingError;
}

function tradeRiskRecord(trade: ManagedPaperTrade) {
  return {
    signalId: trade.signalId,
    symbol: trade.symbol,
    correlationGroup: trade.correlationGroup,
    notional: trade.notional,
    plannedRisk: trade.plannedRisk,
    openedAt: trade.entryCandleOpenTime,
    realizedPnl: trade.realizedPnl
  };
}

function candidateForTradeEvent(
  trade: ManagedPaperTrade,
  eventSnapshotId: string,
  candles: readonly Candle[]
): SignalChart {
  const snapshotOpenTime = Number(eventSnapshotId.split(":").at(-1));
  if (!Number.isFinite(snapshotOpenTime)) {
    throw new Error(`Invalid paper-trade event snapshot: ${eventSnapshotId}`);
  }
  const chartCandles = candles.filter((candle) =>
    candle.closed && candle.openTime <= snapshotOpenTime
  ).slice(-120);
  const signalCandle = chartCandles.at(-1);
  if (!signalCandle || signalCandle.openTime !== snapshotOpenTime) {
    throw new Error(`Missing closed chart candle for paper-trade snapshot ${eventSnapshotId}`);
  }
  return {
    snapshotId: eventSnapshotId,
    symbol: trade.symbol,
    strategy: trade.strategy,
    side: trade.side,
    signalCandle,
    entryPrice: trade.entryPrice,
    stopLoss: trade.stopPrice,
    target1: trade.target1,
    target2: trade.target2,
    chartCandles,
    chartAnnotations: { levels: [], zones: [] }
  };
}

function paperTradeUpdate(
  trade: ManagedPaperTrade,
  event: ReturnType<PaperTradeLedger["getEvents"]>[number]
): PaperTradeUpdate {
  return {
    eventId: event.eventId,
    snapshotId: event.snapshotId,
    symbol: event.symbol,
    event: event.type.replaceAll("_", " ").toUpperCase(),
    details: `${event.details}\nEntry: ${trade.entryPrice}. Current stop: ${trade.stopPrice}. TP1: ${trade.target1}. TP2: ${trade.target2}. Remaining size: ${trade.remainingQuantity}.`
  };
}

export class ApprovedPaperSignalCoordinator {
  private readonly publisher: TelegramSignalPublisher;
  private readonly portfolios = new Map<number, PortfolioRiskManager>();

  constructor(private readonly options: ApprovedPaperSignalCoordinatorOptions) {
    this.publisher = new TelegramSignalPublisher(options.api, options.users);
  }

  async processCandidate(candidate: SignalCandidate): Promise<void> {
    const eligibleUsers = this.options.users.listUsers().filter(({ state }) =>
      state.paperTradingEnabled &&
      !state.paused &&
      state.accountEquity !== undefined &&
      state.enabledStrategies.includes(candidate.strategy)
    );
    if (eligibleUsers.length === 0) return;

    const quality = scoreSignalQuality(candidate, this.options.evidence[candidate.strategy]);
    if (!quality.publishEligible) {
      this.options.onRejected(
        undefined,
        candidate,
        `quality gate rejected for opted-in users: Grade ${quality.strategyGrade}, evidence ${
          quality.evidenceAvailable ? "available" : "missing"
        }`
      );
      return;
    }

    const instrument = await this.options.marketData.getInstrumentRules(candidate.symbol);
    const existingApprovals: UserApproval[] = [];
    for (const { chatId } of eligibleUsers) {
      if (this.options.ledger.getTrade(chatId, candidate.signalId)) continue;
      const state = this.options.users.get(chatId);
      if (state.accountEquity === undefined) continue;
      const gate = this.gateFor(chatId);
      try {
        existingApprovals.push({
          chatId,
          gate,
          approval: gate.approve(candidate, instrument),
          instrument
        });
      } catch (error) {
        if (!isRiskRejection(error)) throw error;
        this.options.onRejected(chatId, candidate, error.message);
      }
    }
    if (existingApprovals.length === 0) return;

    const chart = renderSignalChart(candidate);
    for (const { chatId, gate, approval, instrument: rules } of existingApprovals) {
      const { sizing, portfolioTrade } = approval;
      this.options.ledger.openTrade({
        signalId: candidate.signalId,
        snapshotId: candidate.snapshotId,
        chatId,
        symbol: candidate.symbol,
        strategy: candidate.strategy,
        side: candidate.side,
        entryPrice: candidate.entryPrice,
        stopLoss: candidate.stopLoss,
        target1: candidate.target1,
        target2: candidate.target2,
        quantity: sizing.quantity,
        notional: sizing.notional,
        plannedRisk: portfolioTrade.plannedRisk,
        correlationGroup: portfolioTrade.correlationGroup,
        contractMultiplier: rules.contractMultiplier,
        feeRatePerSide: this.options.costs.feeRatePerSide,
        slippageRatePerSide: this.options.costs.slippageRatePerSide,
        entryCandleOpenTime: candidate.entryCandleOpenTime
      });
      gate.confirmOpened(approval);
      const event = this.options.ledger.getEvents({ chatId }).find((item) =>
        item.signalId === candidate.signalId && item.type === "signal_opened"
      );
      if (!event) throw new Error(`Missing durable open event for ${candidate.signalId}`);
      if (!this.options.ledger.claimEventDelivery(event.eventId)) continue;
      const prepared: PreparedPaperSignal = {
        signalId: candidate.signalId,
        snapshotId: candidate.snapshotId,
        symbol: candidate.symbol,
        side: candidate.side,
        strategy: candidate.strategy,
        higherTimeframeBias: candidate.higherTimeframeBias,
        entryPrice: candidate.entryPrice,
        stopLoss: candidate.stopLoss,
        target1: candidate.target1,
        target2: candidate.target2,
        target3: "trailing_runner",
        quantity: sizing.quantity,
        accountEquity: approval.equity,
        estimatedMaximumLoss: sizing.estimatedMaximumLoss,
        minimumRiskReward: sizing.netRiskReward,
        qualityScore: quality.score,
        strategyGrade: quality.strategyGrade
      };
      try {
        const published = await this.publisher.publishSignal(chatId, prepared, chart);
        this.options.ledger.markEventDelivered(event.eventId);
        if (published) this.options.onDeliverySuccess?.(event.eventId);
      } catch (error) {
        this.options.ledger.releaseEventClaim(event.eventId);
        this.options.onDeliveryError?.(event.eventId, error);
      }
    }
  }

  async processClosedCandles(symbol: string, candles: readonly Candle[]): Promise<void> {
    const managedChats = new Map<number, PortfolioRiskManager>();
    for (const trade of this.options.ledger.getActiveTrades()) {
      if (trade.symbol === symbol.toUpperCase()) {
        managedChats.set(trade.chatId, this.portfolioFor(trade.chatId));
      }
    }
    const created = this.options.ledger.processClosedCandles(symbol, candles);
    for (const event of created) {
      if (event.type !== "trade_closed" &&
        event.type !== "tp1_reached" &&
        event.type !== "tp2_reached") continue;
      const trade = this.options.ledger.getTrade(event.chatId, event.signalId);
      if (!trade) throw new Error(`Paper-trade record is missing for ${event.signalId}`);
      const portfolio = managedChats.get(event.chatId) ?? this.portfolioFor(event.chatId);
      if (event.type === "tp1_reached" || event.type === "tp2_reached") {
        portfolio.updateOpenTradeRealizedPnl(
          trade.signalId,
          trade.realizedPnl,
          event.occurredAt
        );
        continue;
      }
      if (trade.closedAt === undefined) {
        throw new Error(`Closed paper-trade record is missing for ${event.signalId}`);
      }
      const trackedTrade = portfolio.getSnapshot(event.occurredAt).openTrades.find(
        (openTrade) => openTrade.signalId === trade.signalId
      );
      const remainingRealizedPnl = trade.realizedPnl - (trackedTrade?.realizedPnl ?? 0);
      portfolio.closeTrade(trade.signalId, remainingRealizedPnl, trade.closedAt);
    }
    await this.deliverPendingEvents(symbol, candles);
  }

  getActiveTrades(chatId: number): readonly ManagedPaperTrade[] {
    return this.options.ledger.getActiveTrades(chatId);
  }

  getEquity(chatId: number, startingEquity: number): number {
    return this.portfolioFor(chatId, startingEquity).getSnapshot(Date.now()).equity;
  }

  getPerformance(chatId: number, startingEquity: number) {
    const trades = this.options.ledger.getTrades(chatId);
    const completed = trades.filter((trade) => trade.status === "closed");
    const realizedPnl = trades.reduce((total, trade) => total + trade.realizedPnl, 0);
    const winningTrades = completed.filter((trade) => trade.realizedPnl > 0).length;
    return {
      currentEquity: this.getEquity(chatId, startingEquity),
      completedTrades: completed.length,
      activeTrades: trades.length - completed.length,
      realizedPnl,
      winRatePercent: completed.length === 0 ? 0 : winningTrades / completed.length * 100
    };
  }

  hasTradeHistory(chatId: number): boolean {
    return this.options.ledger.getTrades(chatId).length > 0;
  }

  private gateFor(chatId: number): SignalRiskGate {
    return new SignalRiskGate({
      portfolio: this.portfolioFor(chatId),
      costs: this.options.costs,
      correlationGroupForSymbol: this.options.correlationGroupForSymbol
    });
  }

  private portfolioFor(chatId: number, startingEquity?: number): PortfolioRiskManager {
    const cached = this.portfolios.get(chatId);
    const equity = startingEquity ?? this.options.users.get(chatId).accountEquity;
    if (equity === undefined) throw new Error(`No simulated account balance is set for chat ${chatId}`);
    if (cached) {
      if (
        this.options.ledger.getTrades(chatId).length === 0 &&
        cached.getSnapshot(Date.now()).equity !== equity
      ) {
        this.portfolios.delete(chatId);
      } else {
        return cached;
      }
    }
    const portfolio = new PortfolioRiskManager(equity, this.options.limits);
    const trades = this.options.ledger.getTrades(chatId);
    for (const trade of trades
      .filter((item) => item.status === "closed")
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))) {
      if (trade.closedAt === undefined) {
        throw new Error(`Closed paper trade ${trade.signalId} has no close time`);
      }
      portfolio.restoreClosedTrade(trade.signalId, trade.realizedPnl, trade.closedAt);
    }
    const userEvents = this.options.ledger.getEvents({ chatId });
    for (const trade of trades.filter((item) => item.status === "active")) {
      const realizedAt = userEvents
        .filter((event) =>
          event.signalId === trade.signalId &&
          (event.type === "tp1_reached" || event.type === "tp2_reached")
        )
        .reduce((latest, event) => Math.max(latest, event.occurredAt), trade.entryCandleOpenTime);
      portfolio.restoreOpenTrade(tradeRiskRecord(trade), realizedAt);
    }
    this.portfolios.set(chatId, portfolio);
    return portfolio;
  }

  private async deliverPendingEvents(symbol: string, candles: readonly Candle[]): Promise<void> {
    const events = this.options.ledger.getEvents({ deliveryStatus: "pending" })
      .filter((event) => event.symbol === symbol.toUpperCase());
    for (const event of events) {
      const trade = this.options.ledger.getTrade(event.chatId, event.signalId);
      if (!trade) continue;
      let claimed = false;
      try {
        const candidate = candidateForTradeEvent(trade, event.snapshotId, candles);
        const chart = renderSignalChart(candidate);
        if (!this.options.ledger.claimEventDelivery(event.eventId)) continue;
        claimed = true;
        const published = await this.publisher.publishTradeUpdate(
          event.chatId,
          paperTradeUpdate(trade, event),
          chart
        );
        this.options.ledger.markEventDelivered(event.eventId);
        if (published) this.options.onDeliverySuccess?.(event.eventId);
      } catch (error) {
        if (claimed) this.options.ledger.releaseEventClaim(event.eventId);
        this.options.onDeliveryError?.(event.eventId, error);
      }
    }
  }
}
