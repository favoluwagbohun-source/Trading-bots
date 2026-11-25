export interface MarketTime {
  readonly openTime: number;
  readonly closeTime: number;
}

export interface Candle extends MarketTime {
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly closed: boolean;
}

export type StrategyId =
  | "top_down_trendline"
  | "break_and_retest"
  | "liquidity_sweep_reversal"
  | "order_block_retest";
