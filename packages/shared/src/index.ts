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

export type HealthState =
  | "HEALTHY"
  | "DEGRADED"
  | "DISCONNECTED"
  | "SLEEPING"
  | "RECOVERING";

export interface MarketDataHealthSnapshot {
  readonly state: HealthState;
  readonly lastSuccessfulUpdateAt: number | null;
  readonly consecutiveFailures: number;
  readonly skippedNoTradeCandleCount: number;
  readonly lastError: string | null;
}

export interface SignalEngineHealthSnapshot {
  readonly state: HealthState;
  readonly lastScanStartedAt: number | null;
  readonly lastScanCompletedAt: number | null;
  readonly scanIntervalMs: number;
  readonly watchlist: readonly string[];
  readonly lastProcessedOpenTimeBySymbol: Readonly<Record<string, number>>;
  readonly activePaperTradeCount: number;
  readonly pendingEventCount: number;
  readonly lastError: string | null;
}

export interface TelegramHealthSnapshot {
  readonly state: HealthState;
  readonly configured: boolean;
  readonly pollingActive: boolean;
  readonly lastPollAt: number | null;
  readonly lastDeliveryAt: number | null;
  readonly pendingNotifications: number;
  readonly failedDeliveries: number;
  readonly lastError: string | null;
}

export interface WorkerHealthSnapshot {
  readonly version: 1;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly hostingEnvironment: string;
  readonly marketData: MarketDataHealthSnapshot;
  readonly signalEngine: SignalEngineHealthSnapshot;
  readonly telegram: TelegramHealthSnapshot;
}
