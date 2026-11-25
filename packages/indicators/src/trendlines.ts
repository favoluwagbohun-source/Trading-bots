import type { Candle } from "@crypto-signal/shared";
import type {
  SwingPoint,
  Trendline,
  TrendlineAnchor,
  TrendlineDirection
} from "./types.js";

export interface TrendlineOptions {
  readonly minimumTouches: number;
  readonly tolerancePercent: number;
  readonly maximumTrendlines: number;
  readonly asOfIndex?: number;
}

export interface TrendlineBreak {
  readonly trendlineId: string;
  readonly index: number;
  readonly openTime: number;
  readonly closePrice: number;
  readonly direction: "break_above" | "break_below";
}

const DEFAULT_OPTIONS: TrendlineOptions = {
  minimumTouches: 2,
  tolerancePercent: 0.35,
  maximumTrendlines: 4
};

function linePrice(
  anchorA: TrendlineAnchor,
  anchorB: TrendlineAnchor,
  index: number
): number {
  return anchorA.price + (
    (anchorB.price - anchorA.price) / (anchorB.candleIndex - anchorA.candleIndex)
  ) * (index - anchorA.candleIndex);
}

export function trendlinePrice(trendline: Trendline, candleIndex: number): number {
  return linePrice(trendline.anchorA, trendline.anchorB, candleIndex);
}

export function detectTrendlines(
  candles: readonly Candle[],
  confirmedSwings: readonly SwingPoint[],
  requestedOptions: Partial<TrendlineOptions> = {}
): Trendline[] {
  const options: TrendlineOptions = { ...DEFAULT_OPTIONS, ...requestedOptions };
  if (options.minimumTouches < 2) throw new Error("A trendline requires at least two touches");
  if (options.tolerancePercent < 0) throw new Error("Trendline tolerance cannot be negative");
  if (options.maximumTrendlines < 1) throw new Error("maximumTrendlines must be positive");

  const asOfIndex = options.asOfIndex ?? candles.length - 1;
  const allowedSwings = confirmedSwings
    .filter((swing) =>
      swing.confirmedIndex <= asOfIndex &&
      swing.confirmedIndex < candles.length &&
      swing.index > 0
    )
    .sort((a, b) => a.index - b.index);

  const candidates: Trendline[] = [];
  for (const direction of ["ascending", "descending"] as const) {
    const matching = allowedSwings.filter((swing) =>
      direction === "ascending" ? swing.direction === "low" : swing.direction === "high"
    );
    for (let first = 0; first < matching.length - 1; first += 1) {
      for (let second = first + 1; second < matching.length; second += 1) {
        const anchorA = matching[first]!;
        const anchorB = matching[second]!;
        if (anchorB.index <= anchorA.index) continue;

        const actualDirection: TrendlineDirection =
          anchorB.price >= anchorA.price ? "ascending" : "descending";
        if (actualDirection !== direction) continue;

        const touchIndices: number[] = [anchorA.index, anchorB.index];
        for (let index = anchorA.index + 1; index <= asOfIndex; index += 1) {
          if (touchIndices.includes(index)) continue;
          const candle = candles[index];
          if (!candle?.closed) continue;
          const line = linePrice(
            {
              candleIndex: anchorA.index,
              openTime: anchorA.openTime,
              price: anchorA.price
            },
            {
              candleIndex: anchorB.index,
              openTime: anchorB.openTime,
              price: anchorB.price
            },
            index
          );
          const tolerance = line * (options.tolerancePercent / 100);
          const testedPrice = direction === "ascending"
            ? Number(candle.low)
            : Number(candle.high);
          if (Math.abs(testedPrice - line) <= tolerance) touchIndices.push(index);
        }

        if (touchIndices.length < options.minimumTouches) continue;

        const anchorStart: TrendlineAnchor = {
          candleIndex: anchorA.index,
          openTime: anchorA.openTime,
          price: anchorA.price
        };
        const anchorEnd: TrendlineAnchor = {
          candleIndex: anchorB.index,
          openTime: anchorB.openTime,
          price: anchorB.price
        };
        const slope =
          (anchorEnd.price - anchorStart.price) /
          (anchorEnd.candleIndex - anchorStart.candleIndex);
        candidates.push({
          id: `${direction}-${anchorA.openTime}-${anchorB.openTime}`,
          direction,
          anchorA: anchorStart,
          anchorB: anchorEnd,
          slope,
          touchIndices,
          qualifyingTouchCount: touchIndices.length,
          confirmedAtIndex: Math.max(
            anchorB.confirmedIndex,
            touchIndices.at(-1) ?? anchorB.confirmedIndex
          ),
          confirmedAtTime: candles[
            Math.max(anchorB.confirmedIndex, touchIndices.at(-1) ?? anchorB.confirmedIndex)
          ]!.closeTime,
          brokenAtIndex: undefined
        });
      }
    }
  }

  return candidates
    .sort((a, b) => b.qualifyingTouchCount - a.qualifyingTouchCount)
    .slice(0, options.maximumTrendlines);
}

export function findTrendlineBreaks(
  candles: readonly Candle[],
  trendlines: readonly Trendline[],
  startIndex = 0
): TrendlineBreak[] {
  const breaks: TrendlineBreak[] = [];
  for (const trendline of trendlines) {
    for (let index = Math.max(startIndex, trendline.anchorB.candleIndex + 1); index < candles.length; index += 1) {
      const candle = candles[index];
      if (!candle?.closed) continue;
      const rayPrice = trendlinePrice(trendline, index);
      const closePrice = Number(candle.close);
      if (trendline.direction === "ascending" && closePrice < rayPrice) {
        breaks.push({
          trendlineId: trendline.id,
          index,
          openTime: candle.openTime,
          closePrice,
          direction: "break_below"
        });
        break;
      }
      if (trendline.direction === "descending" && closePrice > rayPrice) {
        breaks.push({
          trendlineId: trendline.id,
          index,
          openTime: candle.openTime,
          closePrice,
          direction: "break_above"
        });
        break;
      }
    }
  }
  return breaks;
}
