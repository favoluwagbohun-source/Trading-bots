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
