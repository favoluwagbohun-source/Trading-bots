import type { Candle } from "@crypto-signal/shared";
import type { TrendlineDirection, SwingPoint } from "./types.js";

export interface TrendlineLifecycleOptions {
  readonly timeframe: string;
  readonly asOfIndex?: number;
  readonly minimumTouches?: number;
  readonly tolerancePercent?: number;
  readonly maximumTrendlines?: number;
}

export interface TrendlineLifecycle {
  readonly id: string;
  readonly timeframe: string;
  readonly direction: TrendlineDirection;
  readonly pointA: { readonly openTime: number; readonly price: number; readonly candleIndex: number };
  readonly pointB: { readonly openTime: number; readonly price: number; readonly candleIndex: number };
  readonly touchpoints: readonly {
    readonly openTime: number;
    readonly price: number;
    readonly candleIndex: number;
  }[];
  readonly createdAt: number;
  readonly lastValidatedAt: number;
  readonly structuralViolationIndices: readonly number[];
  readonly isValid: boolean;
  readonly breakStatus: "unbroken" | "broken_above" | "broken_below";
  readonly brokenAt: number | null;
  readonly slope: number;
  readonly qualifyingTouchCount: number;
}

function priceAtIndex(
  pointA: SwingPoint,
  pointB: SwingPoint,
  index: number
): number {
  return pointA.price + (pointB.price - pointA.price) *
    (index - pointA.index) / (pointB.index - pointA.index);
}

export function buildTrendlineLifecycles(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  options: TrendlineLifecycleOptions
): TrendlineLifecycle[] {
  if (!options.timeframe.trim()) throw new Error("Trendline timeframe is required");
  const minimumTouches = options.minimumTouches ?? 3;
  const tolerancePercent = options.tolerancePercent ?? 0.35;
  const maximumTrendlines = options.maximumTrendlines ?? 12;
  const asOfIndex = options.asOfIndex ?? candles.length - 1;
  if (!Number.isInteger(minimumTouches) || minimumTouches < 2) {
    throw new Error("minimumTouches must be at least two");
  }
  if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0) {
    throw new Error("tolerancePercent must be a non-negative finite number");
  }
  if (!Number.isInteger(maximumTrendlines) || maximumTrendlines < 1) {
    throw new Error("maximumTrendlines must be a positive integer");
  }
  if (candles.length === 0) return [];
  if (!Number.isInteger(asOfIndex) || asOfIndex < 0 || asOfIndex >= candles.length) {
    throw new Error("asOfIndex must refer to an available candle");
  }

  const pivots = swings
    .filter((swing) =>
      swing.confirmedIndex <= asOfIndex &&
      swing.confirmedIndex < candles.length &&
      swing.index >= 0 &&
      swing.index <= asOfIndex
    )
    .sort((left, right) => left.confirmedIndex - right.confirmedIndex);
  const results: TrendlineLifecycle[] = [];

  for (const direction of ["ascending", "descending"] as const) {
    const relevant = pivots.filter((pivot) =>
      pivot.direction === (direction === "ascending" ? "low" : "high")
    );
    for (let pairIndex = 0; pairIndex < relevant.length - 1; pairIndex += 1) {
      const pointA = relevant[pairIndex]!;
      const pointB = relevant[pairIndex + 1]!;
      const progresses = direction === "ascending"
        ? pointB.price > pointA.price
        : pointB.price < pointA.price;
      if (!progresses || pointB.index <= pointA.index) continue;

      const touchpoints = [pointA, pointB];
      const violations: number[] = [];
      let brokenAt: number | null = null;
      let breakStatus: TrendlineLifecycle["breakStatus"] = "unbroken";
      for (let index = pointA.index + 1; index <= pointB.index; index += 1) {
        const candle = candles[index]!;
        if (!candle.closed) continue;
        const projected = priceAtIndex(pointA, pointB, index);
        const tolerance = Math.abs(projected) * tolerancePercent / 100;
        const testedExtreme = direction === "ascending"
          ? Number(candle.low)
          : Number(candle.high);
        if (
          direction === "ascending"
            ? testedExtreme < projected - tolerance
            : testedExtreme > projected + tolerance
        ) {
          violations.push(index);
        }
      }
      for (let index = pointB.index + 1; index <= asOfIndex; index += 1) {
        const candle = candles[index]!;
        if (!candle.closed) continue;
        const projected = priceAtIndex(pointA, pointB, index);
        const tolerance = Math.abs(projected) * tolerancePercent / 100;
        const close = Number(candle.close);
        const crossed = direction === "ascending"
          ? close < projected - tolerance
          : close > projected + tolerance;
        if (crossed) {
          if (brokenAt === null) {
            brokenAt = candle.closeTime;
            breakStatus = direction === "ascending" ? "broken_below" : "broken_above";
          }
          violations.push(index);
        } else if (
          direction === "ascending"
            ? Number(candle.low) < projected - tolerance
            : Number(candle.high) > projected + tolerance
        ) {
          violations.push(index);
        }
      }
      for (const pivot of relevant) {
        if (
          pivot.index <= pointB.index ||
          pivot.confirmedAt <= pointB.confirmedAt ||
          pivot.confirmedIndex > asOfIndex
        ) continue;
        const candle = candles[pivot.index]!;
        if (candle.openTime < pointB.confirmedAt) continue;
        const projected = priceAtIndex(pointA, pointB, pivot.index);
        const tolerance = Math.abs(projected) * tolerancePercent / 100;
        if (Math.abs(pivot.price - projected) <= tolerance) {
          touchpoints.push(pivot);
        }
      }

      if (touchpoints.length < minimumTouches) continue;
      const lastValidationIndex = Math.max(pointB.confirmedIndex, asOfIndex);
      results.push(Object.freeze({
        id: `${options.timeframe}:${direction}:${pointA.openTime}:${pointB.openTime}`,
        timeframe: options.timeframe,
        direction,
        pointA: Object.freeze({
          openTime: pointA.openTime,
          price: pointA.price,
          candleIndex: pointA.index
        }),
        pointB: Object.freeze({
          openTime: pointB.openTime,
          price: pointB.price,
          candleIndex: pointB.index
        }),
        touchpoints: Object.freeze(touchpoints.map((touch) => Object.freeze({
          openTime: touch.openTime,
          price: touch.price,
          candleIndex: touch.index
        }))),
        createdAt: candles[pointB.confirmedIndex]!.closeTime,
        lastValidatedAt: candles[lastValidationIndex]!.closeTime,
        structuralViolationIndices: Object.freeze(violations),
        isValid: violations.length === 0,
        breakStatus,
        brokenAt,
        slope: (pointB.price - pointA.price) / (pointB.index - pointA.index),
        qualifyingTouchCount: touchpoints.length
      }));
    }
  }

  return results
    .sort((left, right) =>
      Number(right.isValid) - Number(left.isValid) ||
      right.qualifyingTouchCount - left.qualifyingTouchCount ||
      right.createdAt - left.createdAt
    )
    .slice(0, maximumTrendlines);
}
