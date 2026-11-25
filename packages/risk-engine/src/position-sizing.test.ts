import { describe, expect, it } from "vitest";
import {
  ACCOUNT_RISK_FRACTION,
  calculatePositionSize,
  PositionSizingError,
  type PositionSizingRequest
} from "./position-sizing.js";

const request: PositionSizingRequest = {
  equity: 1000,
  side: "buy",
  entryPrice: 100,
  stopPrice: 95,
  target2Price: 115,
  instrument: {
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    maximumQuantity: 1000,
    minimumNotional: 5,
    contractMultiplier: 1
  },
  costs: {
    feeRatePerSide: 0.001,
    slippageRatePerSide: 0.0005
  }
};

describe("position sizing", () => {
  it("uses fixed 1% risk and rounds quantity down within costs", () => {
    const result = calculatePositionSize(request);

    expect(ACCOUNT_RISK_FRACTION).toBe(0.01);
    expect(result.riskBudget).toBe(10);
    expect(result.quantity).toBe(1.889);
    expect(result.estimatedMaximumLoss).toBeLessThanOrEqual(result.riskBudget);
    expect(result.netRiskReward).toBeGreaterThanOrEqual(2);
    expect(result.estimatedNetProfitAtTarget2).toBeGreaterThan(0);
  });

  it("supports a small account if quantity rules permit it", () => {
    const result = calculatePositionSize({
      ...request,
      equity: 10,
      entryPrice: 100,
      stopPrice: 90,
      target2Price: 120,
      instrument: {
        ...request.instrument,
        quantityStep: 0.001,
        minimumQuantity: 0.001,
        minimumNotional: 0.5
      },
      costs: { feeRatePerSide: 0, slippageRatePerSide: 0 }
    });

    expect(result.riskBudget).toBe(0.1);
    expect(result.quantity).toBe(0.01);
    expect(result.estimatedMaximumLoss).toBe(0.1);
  });

  it("rejects a size that cannot meet exchange minimum quantity", () => {
    expect(() => calculatePositionSize({
      ...request,
      equity: 10,
      entryPrice: 100,
      stopPrice: 90,
      target2Price: 120,
      instrument: { ...request.instrument, minimumQuantity: 0.02 },
      costs: { feeRatePerSide: 0, slippageRatePerSide: 0 }
    })).toThrow("minimum quantity");
  });

  it("rejects net R:R below 1:2 after fees and slippage", () => {
    expect(() => calculatePositionSize({
      ...request,
      target2Price: 110,
      costs: { feeRatePerSide: 0.01, slippageRatePerSide: 0.001 }
    })).toThrow(PositionSizingError);
  });
});
