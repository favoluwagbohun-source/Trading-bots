import type { Candle } from "@crypto-signal/shared";
import { atr } from "./indicators.js";
import { classifyMarketStructure } from "./structure.js";
import type { MarketStructure, SwingPoint } from "./types.js";

export type MarketRegime =
  | "bullish_trend"
  | "bearish_trend"
  | "range"
  | "high_volatility"
  | "low_volatility"
  | "transition_uncertain";

export interface MarketRegimeOptions {
  readonly atrPeriod: number;
  readonly highVolatilityAtrPercent: number;
  readonly lowVolatilityAtrPercent: number;
  readonly rangeDriftPercent: number;
}

export interface MarketRegimeResult {
  readonly regime: MarketRegime;
  readonly asOfTime: number | null;
  readonly atrValue: number | null;
  readonly atrPercent: number | null;
  readonly structure: MarketStructure;
  readonly rationale: string;
}

const DEFAULT_OPTIONS: MarketRegimeOptions = {
  atrPeriod: 14,
  highVolatilityAtrPercent: 3,
  lowVolatilityAtrPercent: 0.35,
  rangeDriftPercent: 1
};

export function classifyMarketRegime(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  requestedOptions: Partial<MarketRegimeOptions> = {}
): MarketRegimeResult {
  const options = { ...DEFAULT_OPTIONS, ...requestedOptions };
  if (!Number.isInteger(options.atrPeriod) || options.atrPeriod < 1) {
    throw new Error("atrPeriod must be a positive integer");
  }
  if (
    !Number.isFinite(options.highVolatilityAtrPercent) ||
    !Number.isFinite(options.lowVolatilityAtrPercent) ||
    options.highVolatilityAtrPercent <= options.lowVolatilityAtrPercent ||
    options.lowVolatilityAtrPercent < 0 ||
    !Number.isFinite(options.rangeDriftPercent) ||
    options.rangeDriftPercent < 0
  ) {
    throw new Error("Market regime thresholds must be finite, non-negative, and ordered");
  }

  const closed = candles.filter((candle) => candle.closed);
  const structure = classifyMarketStructure(closed, swings);
  const latest = closed.at(-1);
  if (!latest) {
    return {
      regime: "transition_uncertain",
      asOfTime: null,
      atrValue: null,
      atrPercent: null,
      structure,
      rationale: "No closed candles are available."
    };
  }
  const atrValues = atr(closed, options.atrPeriod);
  const atrValue = atrValues.at(-1);
  const close = Number(latest.close);
  const atrPercent = atrValue !== undefined && Number.isFinite(atrValue)
    ? atrValue / close * 100
    : null;

  if (atrPercent !== null && atrPercent >= options.highVolatilityAtrPercent) {
    return {
      regime: "high_volatility",
      asOfTime: latest.closeTime,
      atrValue: atrValue!,
      atrPercent,
      structure,
      rationale:
        `ATR(${options.atrPeriod}) is ${atrPercent.toFixed(3)}% of close, at or above the ` +
        `${options.highVolatilityAtrPercent}% high-volatility threshold.`
    };
  }
  if (atrPercent !== null && atrPercent <= options.lowVolatilityAtrPercent) {
    return {
      regime: "low_volatility",
      asOfTime: latest.closeTime,
      atrValue: atrValue!,
      atrPercent,
      structure,
      rationale:
        `ATR(${options.atrPeriod}) is ${atrPercent.toFixed(3)}% of close, at or below the ` +
        `${options.lowVolatilityAtrPercent}% low-volatility threshold.`
    };
  }
  if (structure.regime === "bullish") {
    return {
      regime: "bullish_trend",
      asOfTime: latest.closeTime,
      atrValue: atrValue !== undefined && Number.isFinite(atrValue) ? atrValue : null,
      atrPercent,
      structure,
      rationale: "The latest confirmed swing structure is bullish and volatility is not extreme."
    };
  }
  if (structure.regime === "bearish") {
    return {
      regime: "bearish_trend",
      asOfTime: latest.closeTime,
      atrValue: atrValue !== undefined && Number.isFinite(atrValue) ? atrValue : null,
      atrPercent,
      structure,
      rationale: "The latest confirmed swing structure is bearish and volatility is not extreme."
    };
  }

  const firstClose = Number(closed[0]!.close);
  const driftPercent = Math.abs(close - firstClose) / firstClose * 100;
  const enoughVolatilityData = atrPercent !== null;
  const regime: MarketRegime = enoughVolatilityData &&
    driftPercent <= options.rangeDriftPercent
    ? "range"
    : "transition_uncertain";
  return {
    regime,
    asOfTime: latest.closeTime,
    atrValue: atrValue !== undefined && Number.isFinite(atrValue) ? atrValue : null,
    atrPercent,
    structure,
    rationale: regime === "range"
      ? `Structure is neutral and absolute close-to-close drift is ${driftPercent.toFixed(3)}%, ` +
        `within the ${options.rangeDriftPercent}% range threshold.`
      : "Swing structure is neutral or volatility history is insufficient to classify a range."
  };
}
