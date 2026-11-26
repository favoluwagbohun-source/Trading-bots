import { describe, expect, it } from "vitest";
import { PortfolioRiskError, PortfolioRiskManager } from "./portfolio-risk-manager.js";

const limits = {
  maximumOpenTrades: 3,
  maximumDailyLossPercent: 2,
  maximumWeeklyLossPercent: 6,
  maximumGrossExposurePercent: 200,
  maximumOpenTradesPerCorrelationGroup: 1
};

function trade(signalId: string, symbol: string, correlationGroup = symbol): {
  signalId: string;
  symbol: string;
  correlationGroup: string;
  notional: number;
  plannedRisk: number;
  openedAt: number;
} {
  return {
    signalId,
    symbol,
    correlationGroup,
    notional: 100,
    plannedRisk: 10,
    openedAt: Date.UTC(2026, 0, 5, 12)
  };
}

describe("portfolio risk manager", () => {
  it("prevents duplicate signals, same-symbol positions, and excess correlated trades", () => {
    const manager = new PortfolioRiskManager(1000, limits);
    manager.openTrade(trade("signal-1", "BTCUSDT", "large-cap"));

    expect(() => manager.openTrade(trade("signal-1", "ETHUSDT", "other")))
      .toThrow("Duplicate signal");
    expect(() => manager.openTrade(trade("signal-2", "btcusdt", "other")))
      .toThrow("one open trade per symbol");
    expect(() => manager.openTrade(trade("signal-3", "ETHUSDT", "large-cap")))
      .toThrow("Correlation-group");
  });

  it("reserves planned losses against daily and weekly limits", () => {
    const manager = new PortfolioRiskManager(1000, limits);
    manager.openTrade(trade("signal-1", "BTCUSDT"));
    manager.openTrade(trade("signal-2", "ETHUSDT"));
    expect(() => manager.openTrade(trade("signal-3", "SOLUSDT")))
      .toThrow(PortfolioRiskError);
  });

  it("updates equity and loss limits when a paper trade closes", () => {
    const manager = new PortfolioRiskManager(1000, limits);
    const first = trade("signal-1", "BTCUSDT");
    manager.openTrade(first);
    manager.closeTrade("signal-1", -15, first.openedAt);

    expect(manager.getSnapshot(first.openedAt)).toMatchObject({
      equity: 985,
      dailyRealizedLoss: 15,
      weeklyRealizedLoss: 15,
      openTrades: []
    });
    expect(() => manager.openTrade(trade("signal-2", "ETHUSDT")))
      .toThrow("daily loss");
  });

  it("carries realized losses into the weekly limit after a UTC day changes", () => {
    const manager = new PortfolioRiskManager(1000, {
      ...limits,
      maximumWeeklyLossPercent: 2
    });
    const first = trade("signal-1", "BTCUSDT");
    manager.openTrade(first);
    manager.closeTrade("signal-1", -15, first.openedAt);

    const nextDay = first.openedAt + 24 * 60 * 60 * 1000;
    expect(manager.getSnapshot(nextDay).dailyRealizedLoss).toBe(0);
    expect(manager.getSnapshot(nextDay).weeklyRealizedLoss).toBe(15);
    expect(() => manager.openTrade({
      ...trade("signal-2", "ETHUSDT"),
      openedAt: nextDay
    })).toThrow("weekly loss");
  });

  it("restores closed trade PnL and daily/weekly loss limits after a restart", () => {
    const first = trade("signal-1", "BTCUSDT");
    const manager = new PortfolioRiskManager(1000, limits);
    manager.openTrade(first);
    manager.closeTrade("signal-1", -15, first.openedAt);

    const restarted = new PortfolioRiskManager(1000, limits);
    restarted.restoreClosedTrade("signal-1", -15, first.openedAt);

    expect(restarted.getSnapshot(first.openedAt)).toMatchObject({
      equity: 985,
      dailyRealizedLoss: 15,
      weeklyRealizedLoss: 15,
      openTrades: []
    });
    expect(() => restarted.openTrade(trade("signal-2", "ETHUSDT")))
      .toThrow("daily loss");
  });

  it("restores and updates PnL already realized on an active partial trade", () => {
    const first = trade("signal-1", "BTCUSDT");
    const manager = new PortfolioRiskManager(1000, limits);
    manager.restoreOpenTrade({ ...first, realizedPnl: 5 }, first.openedAt);
    expect(manager.getSnapshot(first.openedAt).equity).toBe(1005);

    manager.updateOpenTradeRealizedPnl("signal-1", 8, first.openedAt);
    manager.closeTrade("signal-1", 2, first.openedAt);

    expect(manager.getSnapshot(first.openedAt)).toMatchObject({
      equity: 1010,
      openTrades: []
    });
  });

  it("enforces the open-trade count limit", () => {
    const manager = new PortfolioRiskManager(1000, {
    ...limits,
    maximumOpenTrades: 2,
    maximumDailyLossPercent: 100,
    maximumWeeklyLossPercent: 100,
    maximumGrossExposurePercent: 200
    });
    manager.openTrade(trade("signal-1", "BTCUSDT", "group-a"));
    manager.openTrade(trade("signal-2", "ETHUSDT", "group-b"));
    expect(() => manager.openTrade(trade("signal-3", "SOLUSDT", "group-c")))
    .toThrow("Maximum open-trade");
    expect(manager.getSnapshot(trade("signal-1", "BTCUSDT").openedAt).openExposure).toBe(200);
  });

  it("enforces gross exposure limits", () => {
    const manager = new PortfolioRiskManager(1000, {
    ...limits,
    maximumOpenTrades: 4,
    maximumDailyLossPercent: 100,
    maximumWeeklyLossPercent: 100,
    maximumGrossExposurePercent: 20,
    maximumOpenTradesPerCorrelationGroup: 2
    });
    manager.openTrade(trade("signal-1", "BTCUSDT", "group-a"));
    manager.openTrade(trade("signal-2", "ETHUSDT", "group-b"));
    expect(() => manager.openTrade(trade("signal-3", "SOLUSDT", "group-c")))
    .toThrow("gross exposure");
  });

  it("supports preflight checks without reserving or consuming a signal", () => {
    const manager = new PortfolioRiskManager(1000, limits);
    const proposed = trade("signal-1", "BTCUSDT");

    expect(() => manager.assertCanOpenTrade(proposed)).not.toThrow();
    expect(manager.getSnapshot(proposed.openedAt).openTrades).toEqual([]);
    expect(() => manager.assertCanOpenTrade(proposed)).not.toThrow();

    manager.openTrade(proposed);
    expect(() => manager.assertCanOpenTrade(proposed)).toThrow("Duplicate signal");
  });

  it("validates limits at construction", () => {
    expect(() => new PortfolioRiskManager(1000, {
      ...limits,
      maximumOpenTrades: 0
    })).toThrow("maximumOpenTrades");
  });
});
