export type SwingDirection = "high" | "low";

export interface SwingPoint {
  readonly direction: SwingDirection;
  readonly index: number;
  readonly openTime: number;
  readonly price: number;
  readonly confirmedIndex: number;
  readonly confirmedAt: number;
}

export interface MarketStructure {
  readonly regime: "bullish" | "bearish" | "neutral";
  readonly latestHigh: SwingPoint | undefined;
  readonly latestLow: SwingPoint | undefined;
  readonly brokenStructureLevel: number | undefined;
}

export type TrendlineDirection = "ascending" | "descending";

export interface TrendlineAnchor {
  readonly candleIndex: number;
  readonly openTime: number;
  readonly price: number;
}

export interface Trendline {
  readonly id: string;
  readonly direction: TrendlineDirection;
  readonly anchorA: TrendlineAnchor;
  readonly anchorB: TrendlineAnchor;
  readonly slope: number;
  readonly touchIndices: readonly number[];
  readonly qualifyingTouchCount: number;
  readonly confirmedAtIndex: number;
  readonly confirmedAtTime: number;
  readonly brokenAtIndex: number | undefined;
}
