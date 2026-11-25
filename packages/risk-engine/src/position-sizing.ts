export const ACCOUNT_RISK_FRACTION = 0.01;
export const MINIMUM_RISK_REWARD = 2;

export interface InstrumentRules {
  readonly quantityStep: number;
  readonly minimumQuantity: number;
  readonly maximumQuantity: number;
  readonly minimumNotional: number;
  readonly contractMultiplier: number;
}

export interface TradingCosts {
  readonly feeRatePerSide: number;
  readonly slippageRatePerSide: number;
}

export interface PositionSizingRequest {
  readonly equity: number;
  readonly side: "buy" | "sell";
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly target2Price: number;
  readonly instrument: InstrumentRules;
  readonly costs: TradingCosts;
}

export interface PositionSizingResult {
  readonly quantity: number;
  readonly riskBudget: number;
  readonly estimatedMaximumLoss: number;
  readonly estimatedNetProfitAtTarget2: number;
  readonly netRiskReward: number;
  readonly notional: number;
  readonly entryExecutionPrice: number;
  readonly stopExecutionPrice: number;
  readonly targetExecutionPrice: number;
}

export class PositionSizingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PositionSizingError";
  }
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PositionSizingError(`${name} must be a positive finite number`);
  }
}

function decimalsForStep(step: number): number {
  const text = step.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.split(".")[1]?.length ?? 0;
}

function roundDownToStep(quantity: number, step: number): number {
  const units = Math.floor(quantity / step + 1e-10);
  return Number((units * step).toFixed(decimalsForStep(step)));
}

export function calculatePositionSize(
  request: PositionSizingRequest
): PositionSizingResult {
  assertPositive(request.equity, "equity");
  assertPositive(request.entryPrice, "entryPrice");
  assertPositive(request.stopPrice, "stopPrice");
  assertPositive(request.target2Price, "target2Price");
  assertPositive(request.instrument.quantityStep, "quantityStep");
  assertPositive(request.instrument.minimumQuantity, "minimumQuantity");
  assertPositive(request.instrument.maximumQuantity, "maximumQuantity");
  assertPositive(request.instrument.contractMultiplier, "contractMultiplier");
  if (!Number.isFinite(request.instrument.minimumNotional) || request.instrument.minimumNotional < 0) {
    throw new PositionSizingError("minimumNotional must be a non-negative finite number");
  }
  if (
    !Number.isFinite(request.costs.feeRatePerSide) ||
    request.costs.feeRatePerSide < 0 ||
    !Number.isFinite(request.costs.slippageRatePerSide) ||
    request.costs.slippageRatePerSide < 0 ||
    request.costs.slippageRatePerSide >= 1
  ) {
    throw new PositionSizingError("Trading costs must be non-negative and slippage below 100%");
  }
  if (request.instrument.minimumQuantity > request.instrument.maximumQuantity) {
    throw new PositionSizingError("minimumQuantity exceeds maximumQuantity");
  }

  const isLong = request.side === "buy";
  const rawRisk = isLong
    ? request.entryPrice - request.stopPrice
    : request.stopPrice - request.entryPrice;
  const rawReward = isLong
    ? request.target2Price - request.entryPrice
    : request.entryPrice - request.target2Price;
  if (rawRisk <= 0 || rawReward <= 0) {
    throw new PositionSizingError("Entry, stop, and target are inconsistent with trade direction");
  }

  const slippage = request.costs.slippageRatePerSide;
  const fee = request.costs.feeRatePerSide;
  const entryExecutionPrice = request.entryPrice * (isLong ? 1 + slippage : 1 - slippage);
  const stopExecutionPrice = request.stopPrice * (isLong ? 1 - slippage : 1 + slippage);
  const targetExecutionPrice = request.target2Price * (isLong ? 1 - slippage : 1 + slippage);
  const multiplier = request.instrument.contractMultiplier;
  const estimatedLossPerUnit =
    Math.abs(entryExecutionPrice - stopExecutionPrice) * multiplier +
    (entryExecutionPrice + stopExecutionPrice) * multiplier * fee;
  const netRewardPerUnit =
    Math.abs(targetExecutionPrice - entryExecutionPrice) * multiplier -
    (entryExecutionPrice + targetExecutionPrice) * multiplier * fee;
  const netRiskReward = netRewardPerUnit / estimatedLossPerUnit;
  if (!Number.isFinite(netRiskReward) || netRiskReward < MINIMUM_RISK_REWARD) {
    throw new PositionSizingError("Net TP2 risk/reward is below the minimum 1:2");
  }

  const riskBudget = request.equity * ACCOUNT_RISK_FRACTION;
  let quantity = roundDownToStep(
    riskBudget / estimatedLossPerUnit,
    request.instrument.quantityStep
  );
  if (quantity > request.instrument.maximumQuantity) {
    quantity = roundDownToStep(
      request.instrument.maximumQuantity,
      request.instrument.quantityStep
    );
  }

  let estimatedMaximumLoss = quantity * estimatedLossPerUnit;
  if (estimatedMaximumLoss > riskBudget) {
    quantity = roundDownToStep(
      quantity - request.instrument.quantityStep,
      request.instrument.quantityStep
    );
    estimatedMaximumLoss = quantity * estimatedLossPerUnit;
  }

  const notional = quantity * entryExecutionPrice * multiplier;
  if (quantity < request.instrument.minimumQuantity) {
    throw new PositionSizingError("Risk budget cannot satisfy the instrument minimum quantity");
  }
  if (notional < request.instrument.minimumNotional) {
    throw new PositionSizingError("Risk-sized position is below the instrument minimum notional");
  }
  if (estimatedMaximumLoss > riskBudget) {
    throw new PositionSizingError("Rounded position exceeds the account risk budget");
  }

  return {
    quantity,
    riskBudget,
    estimatedMaximumLoss,
    estimatedNetProfitAtTarget2: quantity * netRewardPerUnit,
    netRiskReward,
    notional,
    entryExecutionPrice,
    stopExecutionPrice,
    targetExecutionPrice
  };
}
