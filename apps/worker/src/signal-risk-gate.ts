import {
  calculatePositionSize,
  type InstrumentRules,
  type OpenPaperTrade,
  type PortfolioRiskManager,
  type PositionSizingResult,
  type TradingCosts
} from "@crypto-signal/risk-engine";
import type { SignalCandidate } from "./signal-scanner.js";

export interface RiskApprovedCandidate {
  readonly candidate: SignalCandidate;
  readonly equity: number;
  readonly sizing: PositionSizingResult;
  readonly portfolioTrade: OpenPaperTrade;
}

export interface SignalRiskGateOptions {
  readonly portfolio: PortfolioRiskManager;
  readonly costs: TradingCosts;
  readonly correlationGroupForSymbol: (symbol: string) => string;
}

export class SignalRiskGate {
  constructor(private readonly options: SignalRiskGateOptions) {}

  approve(
    candidate: SignalCandidate,
    instrument: InstrumentRules
  ): RiskApprovedCandidate {
    const snapshot = this.options.portfolio.getSnapshot(candidate.signalCandle.closeTime);
    const sizing = calculatePositionSize({
      equity: snapshot.equity,
      side: candidate.side,
      entryPrice: candidate.entryPrice,
      stopPrice: candidate.stopLoss,
      target2Price: candidate.target2,
      instrument,
      costs: this.options.costs
    });
    const portfolioTrade: OpenPaperTrade = {
      signalId: candidate.signalId,
      symbol: candidate.symbol,
      correlationGroup: this.options.correlationGroupForSymbol(candidate.symbol),
      notional: sizing.notional,
      plannedRisk: sizing.estimatedMaximumLoss,
      openedAt: candidate.entryCandleOpenTime
    };
    this.options.portfolio.assertCanOpenTrade(portfolioTrade);
    return { candidate, equity: snapshot.equity, sizing, portfolioTrade };
  }

  confirmOpened(approval: RiskApprovedCandidate): void {
    this.options.portfolio.openTrade(approval.portfolioTrade);
  }
}
