import type { Candle } from "@crypto-signal/shared";

export type AdditionalStrategyId =
  | "break_and_retest"
  | "liquidity_sweep_reversal"
  | "order_block_retest";

export interface PriceLevel {
  readonly id: string;
  readonly kind: "swing_high" | "swing_low";
  readonly price: number;
  readonly confirmedAt: number;
}

export type StrategyReference =
  | { readonly kind: "level"; readonly price: number }
  | { readonly kind: "zone"; readonly low: number; readonly high: number };

export interface StrategySetup {
  readonly strategy: AdditionalStrategyId;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly signalCandle: Candle;
  readonly entryCandleOpenTime: number;
  readonly stopLoss: number;
  readonly reference: StrategyReference;
}

export interface TargetOptions {
  readonly target1R: number;
  readonly target2R: number;
}

export interface ActivatedStrategyPlan {
  readonly setup: StrategySetup;
  readonly entryPrice: number;
  readonly entryTime: number;
  readonly stopLoss: number;
  readonly riskPerUnit: number;
  readonly target1: number;
  readonly target2: number;
  readonly target3: "trailing_runner";
  readonly target1R: number;
  readonly target2R: number;
  readonly minimumRiskReward: 2;
}

export function createSetup(
  setup: Omit<StrategySetup, "entryCandleOpenTime">
): StrategySetup {
  return {
    ...setup,
    entryCandleOpenTime: setup.signalCandle.closeTime + 1
  };
}

export function activateSetupAtNextOpen(
  setup: StrategySetup,
  nextCandle: Candle,
  targets: TargetOptions = { target1R: 1.5, target2R: 3 }
): ActivatedStrategyPlan {
  if (nextCandle.openTime !== setup.entryCandleOpenTime) {
    throw new Error("Entry candle must be the immediate next candle");
  }
  if (targets.target1R <= 0 || targets.target1R >= targets.target2R || targets.target2R < 2) {
    throw new Error("Targets must be positive, ordered, and TP2 must be at least 2R");
  }

  const entryPrice = Number(nextCandle.open);
  const riskPerUnit = setup.side === "buy"
    ? entryPrice - setup.stopLoss
    : setup.stopLoss - entryPrice;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || riskPerUnit <= 0) {
    throw new Error("Next-candle open does not produce positive trade risk");
  }
  const direction = setup.side === "buy" ? 1 : -1;
  return {
    setup,
    entryPrice,
    entryTime: nextCandle.openTime,
    stopLoss: setup.stopLoss,
    riskPerUnit,
    target1: entryPrice + direction * riskPerUnit * targets.target1R,
    target2: entryPrice + direction * riskPerUnit * targets.target2R,
    target3: "trailing_runner",
    target1R: targets.target1R,
    target2R: targets.target2R,
    minimumRiskReward: 2
  };
}

export function validateTolerance(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}
