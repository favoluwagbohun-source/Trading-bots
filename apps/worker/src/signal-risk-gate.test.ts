import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import {
  PortfolioRiskError,
  PortfolioRiskManager
} from "@crypto-signal/risk-engine";
import type { SignalCandidate } from "./signal-scanner.js";
import { SignalRiskGate } from "./signal-risk-gate.js";

const limits = {
  maximumOpenTrades: 3,
  maximumDailyLossPercent: 2,
  maximumWeeklyLossPercent: 6,
  maximumGrossExposurePercent: 200,
  maximumOpenTradesPerCorrelationGroup: 1
};
const instrument = {
  quantityStep: 0.001,
  minimumQuantity: 0.001,
  maximumQuantity: 1000,
  minimumNotional: 5,
  contractMultiplier: 1
};
const costs = { feeRatePerSide: 0.0001, slippageRatePerSide: 0.0001 };

function candidate(
  signalId: string,
  symbol = "BTCUSDT",
  entryPrice = 100
): SignalCandidate {
  const signalCandle: Candle = {
    openTime: 1_800_000,
    closeTime: 2_099_999,
    open: String(entryPrice),
    high: String(entryPrice + 1),
    low: String(entryPrice - 1),
    close: String(entryPrice),
    volume: "10",
    closed: true
  };
  return {
    signalId,
    snapshotId: `${symbol}:5m:${signalCandle.openTime}`,
    symbol,
    strategy: "break_and_retest",
    side: "buy",
    signalCandle,
    entryCandleOpenTime: signalCandle.closeTime + 1,
    entryPrice,
    stopLoss: entryPrice - 10,
    target1: entryPrice + 15,
    target2: entryPrice + 30,
    target3: "trailing_runner",
    minimumRiskReward: 3,
    higherTimeframeBias: "not applicable",
    chartCandles: [signalCandle],
    chartAnnotations: { levels: [], zones: [] }
  };
}

describe("SignalRiskGate", () => {
  it("calculates cost-aware 1% sizing and checks portfolio limits without opening early", () => {
    const portfolio = new PortfolioRiskManager(1000, limits);
    const gate = new SignalRiskGate({
      portfolio,
      costs,
      correlationGroupForSymbol: (symbol) => symbol.endsWith("USDT") ? "USDT" : symbol
    });

    const approval = gate.approve(candidate("signal-1"), instrument);
    expect(approval.sizing.estimatedMaximumLoss).toBeLessThanOrEqual(10);
    expect(approval.sizing.netRiskReward).toBeGreaterThanOrEqual(2);
    expect(portfolio.getSnapshot(2_099_999).openTrades).toEqual([]);

    gate.confirmOpened(approval);
    expect(portfolio.getSnapshot(2_099_999).openTrades).toHaveLength(1);
    expect(() => gate.approve(candidate("signal-2"), instrument))
      .toThrow(PortfolioRiskError);
  });

  it("applies configured correlation restrictions to another symbol", () => {
    const portfolio = new PortfolioRiskManager(1000, limits);
    const gate = new SignalRiskGate({
      portfolio,
      costs,
      correlationGroupForSymbol: () => "stablecoin-quoted"
    });
    const first = gate.approve(candidate("signal-1"), instrument);
    gate.confirmOpened(first);

    expect(() => gate.approve(
      candidate("signal-2", "ETHUSDT", 2000),
      instrument
    ))
      .toThrow("Correlation-group");
  });

  it("rejects a position when fees reduce TP2 below 2R", () => {
    const gate = new SignalRiskGate({
      portfolio: new PortfolioRiskManager(1000, limits),
      costs: { feeRatePerSide: 0.01, slippageRatePerSide: 0.001 },
      correlationGroupForSymbol: (symbol) => symbol
    });
    const weakReward = {
      ...candidate("signal-1"),
      target2: 110,
      minimumRiskReward: 1
    };

    expect(() => gate.approve(weakReward, instrument))
      .toThrow("Net TP2 risk/reward is below the minimum 1:2");
  });
});
