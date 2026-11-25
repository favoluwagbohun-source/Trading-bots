import type { Candle } from "@crypto-signal/shared";
import type { MarketStructure, SwingPoint } from "./types.js";

export interface SwingOptions {
  readonly leftBars: number;
  readonly rightBars: number;
  readonly includeUnconfirmed?: boolean;
}

export function findConfirmedSwings(
  candles: readonly Candle[],
  options: SwingOptions
): SwingPoint[] {
  const left = options.leftBars;
  const right = options.rightBars;
  if (!Number.isInteger(left) || !Number.isInteger(right) || left < 1 || right < 1) {
    throw new Error("Swing leftBars and rightBars must be positive");
  }

  const closed = candles.filter((candle) => candle.closed);
  const swings: SwingPoint[] = [];
  for (let index = left; index < closed.length - right; index += 1) {
    const candidate = closed[index]!;
    const leftCandles = closed.slice(index - left, index);
    const rightCandles = closed.slice(index + 1, index + 1 + right);
    const high = Number(candidate.high);
    const low = Number(candidate.low);

    if (
      leftCandles.every((candle) => high > Number(candle.high)) &&
      rightCandles.every((candle) => high > Number(candle.high))
    ) {
      const confirmedIndex = index + right;
      swings.push({
        direction: "high",
        index,
        openTime: candidate.openTime,
        price: high,
        confirmedIndex,
        confirmedAt: closed[confirmedIndex]!.closeTime
      });
    }

    if (
      leftCandles.every((candle) => low < Number(candle.low)) &&
      rightCandles.every((candle) => low < Number(candle.low))
    ) {
      const confirmedIndex = index + right;
      swings.push({
        direction: "low",
        index,
        openTime: candidate.openTime,
        price: low,
        confirmedIndex,
        confirmedAt: closed[confirmedIndex]!.closeTime
      });
    }
  }
  return swings.sort((a, b) => a.confirmedIndex - b.confirmedIndex);
}

export function classifyMarketStructure(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  asOfIndex = candles.length - 1
): MarketStructure {
  if (asOfIndex < 0) {
    return {
      regime: "neutral",
      latestHigh: undefined,
      latestLow: undefined,
      brokenStructureLevel: undefined
    };
  }

  const confirmed = swings.filter(
    (swing) => swing.confirmedIndex <= asOfIndex && swing.confirmedIndex < candles.length
  );
  const highs = confirmed.filter((swing) => swing.direction === "high");
  const lows = confirmed.filter((swing) => swing.direction === "low");
  const latestHigh = highs.at(-1);
  const latestLow = lows.at(-1);
  let regime: MarketStructure["regime"] = "neutral";
  let brokenStructureLevel: number | undefined;

  if (latestHigh && latestLow) {
    if (latestHigh.index > latestLow.index) {
      regime = "bullish";
      brokenStructureLevel = latestHigh.price;
    } else {
      regime = "bearish";
      brokenStructureLevel = latestLow.price;
    }
  }

  return { regime, latestHigh, latestLow, brokenStructureLevel };
}
