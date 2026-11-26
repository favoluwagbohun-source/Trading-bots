export interface PortfolioLimits {
  readonly maximumOpenTrades: number;
  readonly maximumDailyLossPercent: number;
  readonly maximumWeeklyLossPercent: number;
  readonly maximumGrossExposurePercent: number;
  readonly maximumOpenTradesPerCorrelationGroup: number;
}

export interface OpenPaperTrade {
  readonly signalId: string;
  readonly symbol: string;
  readonly correlationGroup: string;
  readonly notional: number;
  readonly plannedRisk: number;
  readonly openedAt: number;
  readonly realizedPnl?: number;
}

export interface PortfolioSnapshot {
  readonly equity: number;
  readonly openTrades: readonly OpenPaperTrade[];
  readonly openExposure: number;
  readonly openPlannedRisk: number;
  readonly dailyRealizedLoss: number;
  readonly weeklyRealizedLoss: number;
}

export class PortfolioRiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioRiskError";
  }
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function utcWeek(timestamp: number): string {
  const date = new Date(timestamp);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export class PortfolioRiskManager {
  private readonly openTrades = new Map<string, OpenPaperTrade>();
  private readonly processedSignalIds = new Set<string>();
  private readonly realizedLossByDay = new Map<string, number>();
  private readonly realizedLossByWeek = new Map<string, number>();
  private equity: number;

  constructor(
    initialEquity: number,
    private readonly limits: PortfolioLimits
  ) {
    if (!Number.isFinite(initialEquity) || initialEquity <= 0) {
      throw new PortfolioRiskError("Initial equity must be positive");
    }
    this.validateLimits();
    this.equity = initialEquity;
  }

  getSnapshot(atTime: number): PortfolioSnapshot {
    if (!Number.isFinite(new Date(atTime).getTime())) {
      throw new PortfolioRiskError("Snapshot time must be a valid timestamp");
    }
    const openTrades = [...this.openTrades.values()];
    return {
      equity: this.equity,
      openTrades,
      openExposure: openTrades.reduce((total, trade) => total + trade.notional, 0),
      openPlannedRisk: openTrades.reduce((total, trade) => total + trade.plannedRisk, 0),
      dailyRealizedLoss: this.realizedLossByDay.get(utcDay(atTime)) ?? 0,
      weeklyRealizedLoss: this.realizedLossByWeek.get(utcWeek(atTime)) ?? 0
    };
  }

  openTrade(trade: OpenPaperTrade): void {
    this.assertCanOpenTrade(trade);
    const normalized = {
      ...trade,
      symbol: trade.symbol.trim().toUpperCase(),
      realizedPnl: trade.realizedPnl ?? 0
    };
    this.openTrades.set(trade.signalId, normalized);
    this.processedSignalIds.add(trade.signalId);
  }

  restoreOpenTrade(trade: OpenPaperTrade, realizedAt = trade.openedAt): void {
    this.validateTrade(trade);
    if (this.processedSignalIds.has(trade.signalId) || this.openTrades.has(trade.signalId)) {
      throw new PortfolioRiskError("Restored trade has already been processed");
    }
    if (!Number.isFinite(new Date(realizedAt).getTime())) {
      throw new PortfolioRiskError("Restored realization time must be valid");
    }
    const realizedPnl = trade.realizedPnl ?? 0;
    const updatedEquity = this.equity + realizedPnl;
    if (updatedEquity <= 0) {
      throw new PortfolioRiskError("Restored losses exhausted account equity");
    }
    this.equity = updatedEquity;
    this.recordRealizedLoss(realizedPnl, realizedAt);
    this.openTrades.set(trade.signalId, {
      ...trade,
      symbol: trade.symbol.trim().toUpperCase(),
      realizedPnl
    });
    this.processedSignalIds.add(trade.signalId);
  }

  updateOpenTradeRealizedPnl(
    signalId: string,
    cumulativeRealizedPnl: number,
    realizedAt: number
  ): void {
    if (!Number.isFinite(cumulativeRealizedPnl) ||
      !Number.isFinite(new Date(realizedAt).getTime())) {
      throw new PortfolioRiskError("Paper-trade realization is invalid");
    }
    const trade = this.openTrades.get(signalId);
    if (!trade) throw new PortfolioRiskError("Cannot update a paper trade that is not open");
    const previousRealizedPnl = trade.realizedPnl ?? 0;
    const realizedPnlDelta = cumulativeRealizedPnl - previousRealizedPnl;
    const updatedEquity = this.equity + realizedPnlDelta;
    if (updatedEquity <= 0) {
      throw new PortfolioRiskError("Realized loss exhausted account equity");
    }
    this.equity = updatedEquity;
    this.recordRealizedLoss(realizedPnlDelta, realizedAt);
    this.openTrades.set(signalId, { ...trade, realizedPnl: cumulativeRealizedPnl });
  }

  assertCanOpenTrade(trade: OpenPaperTrade): void {
    this.validateTrade(trade);
    const symbol = trade.symbol.trim().toUpperCase();
    if (this.processedSignalIds.has(trade.signalId)) {
      throw new PortfolioRiskError("Duplicate signal has already been processed");
    }
    if ([...this.openTrades.values()].some((open) => open.symbol === symbol)) {
      throw new PortfolioRiskError("Only one open trade per symbol is allowed");
    }
    if (this.openTrades.size >= this.limits.maximumOpenTrades) {
      throw new PortfolioRiskError("Maximum open-trade limit reached");
    }

    const sameGroup = [...this.openTrades.values()].filter(
      (open) => open.correlationGroup === trade.correlationGroup
    ).length;
    if (sameGroup >= this.limits.maximumOpenTradesPerCorrelationGroup) {
      throw new PortfolioRiskError("Correlation-group exposure limit reached");
    }

    const snapshot = this.getSnapshot(trade.openedAt);
    const proposedExposure = snapshot.openExposure + trade.notional;
    if (proposedExposure > this.equity * this.limits.maximumGrossExposurePercent / 100) {
      throw new PortfolioRiskError("Maximum gross exposure limit would be exceeded");
    }
    const dailyCap = this.equity * this.limits.maximumDailyLossPercent / 100;
    if (
      snapshot.dailyRealizedLoss + snapshot.openPlannedRisk + trade.plannedRisk > dailyCap
    ) {
      throw new PortfolioRiskError("Maximum daily loss limit would be exceeded");
    }
    const weeklyCap = this.equity * this.limits.maximumWeeklyLossPercent / 100;
    if (
      snapshot.weeklyRealizedLoss + snapshot.openPlannedRisk + trade.plannedRisk > weeklyCap
    ) {
      throw new PortfolioRiskError("Maximum weekly loss limit would be exceeded");
    }
  }

  closeTrade(signalId: string, realizedPnl: number, closedAt: number): void {
    if (!Number.isFinite(realizedPnl) || !Number.isFinite(new Date(closedAt).getTime())) {
      throw new PortfolioRiskError("Realized PnL and close time must be valid");
    }
    if (!this.openTrades.has(signalId)) {
      throw new PortfolioRiskError("Cannot close a paper trade that is not open");
    }
    const updatedEquity = this.equity + realizedPnl;
    if (updatedEquity <= 0) {
      throw new PortfolioRiskError("Realized loss exhausted account equity");
    }
    this.openTrades.delete(signalId);
    this.equity = updatedEquity;
    this.recordRealizedLoss(realizedPnl, closedAt);
  }

  restoreClosedTrade(signalId: string, realizedPnl: number, closedAt: number): void {
    if (!signalId.trim() || !Number.isFinite(realizedPnl) ||
      !Number.isFinite(new Date(closedAt).getTime())) {
      throw new PortfolioRiskError("Restored trade result is invalid");
    }
    if (this.processedSignalIds.has(signalId) || this.openTrades.has(signalId)) {
      throw new PortfolioRiskError("Restored trade has already been processed");
    }
    const updatedEquity = this.equity + realizedPnl;
    if (updatedEquity <= 0) {
      throw new PortfolioRiskError("Restored losses exhausted account equity");
    }
    this.processedSignalIds.add(signalId);
    this.equity = updatedEquity;
    this.recordRealizedLoss(realizedPnl, closedAt);
  }

  private validateLimits(): void {
    if (!Number.isInteger(this.limits.maximumOpenTrades) || this.limits.maximumOpenTrades < 1) {
      throw new PortfolioRiskError("maximumOpenTrades must be a positive integer");
    }
    if (
      !Number.isInteger(this.limits.maximumOpenTradesPerCorrelationGroup) ||
      this.limits.maximumOpenTradesPerCorrelationGroup < 1
    ) {
      throw new PortfolioRiskError("maximumOpenTradesPerCorrelationGroup must be a positive integer");
    }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new PortfolioRiskError(`${name} must be positive and finite`);
      }
    }
  }

  private validateTrade(trade: OpenPaperTrade): void {
    if (!trade.signalId.trim() || !trade.symbol.trim() || !trade.correlationGroup.trim()) {
      throw new PortfolioRiskError("Signal, symbol, and correlation group are required");
    }
    if (
      !Number.isFinite(trade.notional) ||
      trade.notional <= 0 ||
      !Number.isFinite(trade.plannedRisk) ||
      trade.plannedRisk <= 0 ||
      (trade.realizedPnl !== undefined && !Number.isFinite(trade.realizedPnl)) ||
      !Number.isFinite(new Date(trade.openedAt).getTime())
    ) {
      throw new PortfolioRiskError("Trade notional, risk, and open time must be valid");
    }
  }

  private recordRealizedLoss(realizedPnl: number, timestamp: number): void {
    if (realizedPnl >= 0) return;
    const day = utcDay(timestamp);
    const week = utcWeek(timestamp);
    this.realizedLossByDay.set(
      day,
      (this.realizedLossByDay.get(day) ?? 0) + Math.abs(realizedPnl)
    );
    this.realizedLossByWeek.set(
      week,
      (this.realizedLossByWeek.get(week) ?? 0) + Math.abs(realizedPnl)
    );
  }
}
