import { classifyMarketStructure, findConfirmedSwings } from "@crypto-signal/indicators";
import type { Candle } from "@crypto-signal/shared";
import type { SignalCandidate } from "./signal-scanner.js";

export type SignalGrade = "A" | "B" | "C" | "D";

export interface StrategyQualityEvidence {
  readonly maximumSupportedGrade: SignalGrade;
  readonly source: string;
}

export interface SignalQualityFactor {
  readonly id:
    | "higher_timeframe_alignment"
    | "trendline_validity"
    | "entry_confirmation"
    | "structural_confluence"
    | "volume"
    | "candle_quality"
    | "market_regime"
    | "risk_reward";
  readonly points: number;
  readonly maximumPoints: number;
  readonly rationale: string;
}

export interface SignalQualityResult {
  readonly score: number;
  readonly calculatedGrade: SignalGrade;
  readonly strategyGrade: SignalGrade;
  readonly evidenceAvailable: boolean;
  readonly evidenceSource: string | undefined;
  readonly publishEligible: boolean;
  readonly factors: readonly SignalQualityFactor[];
}

const GRADE_MAX: Readonly<Record<SignalGrade, number>> = {
  A: 4,
  B: 3,
  C: 2,
  D: 1
};

function gradeForScore(score: number): SignalGrade {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  return "D";
}

function factor(
  id: SignalQualityFactor["id"],
  points: number,
  maximumPoints: number,
  rationale: string
): SignalQualityFactor {
  return {
    id,
    points: Math.min(maximumPoints, Math.max(0, points)),
    maximumPoints,
    rationale
  };
}

function parseHigherTimeframeBias(candidate: SignalCandidate): string[] {
  if (candidate.higherTimeframeBias === "not applicable") return [];
  return candidate.higherTimeframeBias
    .split(",")
    .map((item) => item.trim().split(":")[1]?.toLowerCase())
    .filter((bias): bias is string =>
      bias === "bullish" || bias === "bearish" || bias === "neutral"
    );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function gradeCap(
  grade: SignalGrade,
  maximumSupportedGrade: SignalGrade
): SignalGrade {
  return GRADE_MAX[grade] <= GRADE_MAX[maximumSupportedGrade]
    ? grade
    : maximumSupportedGrade;
}

function validateCandidate(candidate: SignalCandidate): void {
  if (
    !candidate.chartCandles.length ||
    candidate.chartCandles.at(-1)?.openTime !== candidate.signalCandle.openTime ||
    !candidate.signalCandle.closed
  ) {
    throw new Error("Signal quality requires a matching closed-candle snapshot");
  }
}

export function scoreSignalQuality(
  candidate: SignalCandidate,
  evidence?: StrategyQualityEvidence
): SignalQualityResult {
  validateCandidate(candidate);
  if (evidence && !evidence.source.trim()) {
    throw new Error("Strategy evidence must identify its validation source");
  }

  const candles = candidate.chartCandles;
  const signalCandle = candidate.signalCandle;
  const factors: SignalQualityFactor[] = [];

  const biases = parseHigherTimeframeBias(candidate);
  if (biases.length > 0) {
    const alignedCount = biases.filter((bias) =>
      candidate.side === "buy" ? bias === "bullish" : bias === "bearish"
    ).length;
    factors.push(factor(
      "higher_timeframe_alignment",
      alignedCount / biases.length * 20,
      20,
      `${alignedCount} of ${biases.length} supplied higher timeframes align with trade direction.`
    ));
  }

  const trendline = candidate.chartAnnotations.trendline;
  if (trendline) {
    factors.push(factor(
      "trendline_validity",
      Math.min(trendline.qualifyingTouchCount, 4) / 4 * 15,
      15,
      `${trendline.qualifyingTouchCount} qualifying touches; points scale linearly to four touches.`
    ));
  }

  const open = Number(signalCandle.open);
  const high = Number(signalCandle.high);
  const low = Number(signalCandle.low);
  const close = Number(signalCandle.close);
  const range = high - low;
  if (
    ![open, high, low, close].every(Number.isFinite) ||
    range <= 0 ||
    open < low || open > high || close < low || close > high
  ) {
    throw new Error("Signal candle has invalid OHLC values");
  }
  const directionalClosePosition = candidate.side === "buy"
    ? (close - low) / range
    : (high - close) / range;
  factors.push(factor(
    "entry_confirmation",
    directionalClosePosition * 15,
    15,
    `Signal candle closed ${Math.round(directionalClosePosition * 100)}% toward the trade-direction extreme.`
  ));

  const hasStructuralReference =
    candidate.chartAnnotations.levels.length > 0 ||
    candidate.chartAnnotations.zones.length > 0;
  if (hasStructuralReference) {
    factors.push(factor(
      "structural_confluence",
      10,
      10,
      "The setup includes a confirmed horizontal level or supply/demand zone."
    ));
  }

  const priorVolumes = candles
    .slice(Math.max(0, candles.length - 21), -1)
    .map((candle) => Number(candle.volume))
    .filter((volume) => Number.isFinite(volume) && volume > 0);
  const signalVolume = Number(signalCandle.volume);
  if (priorVolumes.length >= 5 && Number.isFinite(signalVolume) && signalVolume > 0) {
    const referenceVolume = median(priorVolumes);
    const volumeRatio = referenceVolume > 0 ? signalVolume / referenceVolume : 0;
    factors.push(factor(
      "volume",
      Math.min(volumeRatio / 1.2, 1) * 10,
      10,
      `Signal volume is ${volumeRatio.toFixed(2)}× the prior-candle median; points reach the cap at 1.2×.`
    ));
  }

  const bodyToRange = Math.abs(close - open) / range;
  const directionalBody = (candidate.side === "buy" ? close >= open : close <= open)
    ? bodyToRange
    : bodyToRange * 0.35;
  const directionalWick = candidate.side === "buy"
    ? (Math.min(open, close) - low) / range
    : (high - Math.max(open, close)) / range;
  const candleQualityRatio = Math.min(1, directionalBody + directionalWick * 0.9);
  factors.push(factor(
    "candle_quality",
    candleQualityRatio * 10,
    10,
    `Candle directional body/rejection wick captures ${Math.round(candleQualityRatio * 100)}% of its high-low range.`
  ));

  const swings = findConfirmedSwings(candles, { leftBars: 2, rightBars: 2 });
  const regime = classifyMarketStructure(candles, swings).regime;
  const alignedRegime = (regime === "bullish") === (candidate.side === "buy");
  const regimePoints = regime === "neutral"
    ? 7
    : alignedRegime
      ? 10
      : candidate.strategy === "top_down_trendline"
        ? 3
        : 6;
  factors.push(factor(
    "market_regime",
    regimePoints,
    10,
    `Closed-candle market structure is ${regime} (${regimePoints}/10 for ${candidate.strategy}).`
  ));

  const risk = candidate.side === "buy"
    ? candidate.entryPrice - candidate.stopLoss
    : candidate.stopLoss - candidate.entryPrice;
  const reward = candidate.side === "buy"
    ? candidate.target2 - candidate.entryPrice
    : candidate.entryPrice - candidate.target2;
  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0 || reward <= 0) {
    throw new Error("Signal quality requires directionally valid entry, stop, and TP2 prices");
  }
  const rewardRisk = reward / risk;
  factors.push(factor(
    "risk_reward",
    Math.min(rewardRisk / 3, 1) * 10,
    10,
    `Geometric TP2 reward/risk is ${rewardRisk.toFixed(2)}R; points reach the cap at 3R.`
  ));

  const availablePoints = factors.reduce((sum, item) => sum + item.maximumPoints, 0);
  const earnedPoints = factors.reduce((sum, item) => sum + item.points, 0);
  const score = availablePoints === 0 ? 0 : earnedPoints / availablePoints * 100;
  const calculatedGrade = gradeForScore(score);
  const strategyGrade = gradeCap(calculatedGrade, evidence?.maximumSupportedGrade ?? "C");
  const evidenceAvailable = evidence !== undefined;

  return {
    score: Math.round(score * 100) / 100,
    calculatedGrade,
    strategyGrade,
    evidenceAvailable,
    evidenceSource: evidence?.source,
    publishEligible: evidenceAvailable &&
      GRADE_MAX[strategyGrade] >= GRADE_MAX.B,
    factors
  };
}
