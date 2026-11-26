import type { Candle, HealthState, StrategyId } from "@crypto-signal/shared";
import {
  SUPPORTED_TIMEFRAMES,
  type MarketTimeframe
} from "@crypto-signal/market-data";
import type { ChartAnnotationsView, TimeframeSummary } from "./market-api.js";

export interface ChartTradeOverlay {
  readonly label: string;
  readonly symbol: string;
  readonly strategy?: StrategyId;
  readonly side: "long" | "short";
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly target1: number;
  readonly target2: number;
  readonly annotations?: ChartAnnotationsView;
}

export interface TopDownSummary {
  readonly bullishCount: number;
  readonly bearishCount: number;
  readonly neutralCount: number;
  readonly dominantRegime: "bullish" | "bearish" | "neutral" | "mixed";
  readonly alignedCount: number;
  readonly totalAvailable: number;
}

export const STRATEGY_META: Readonly<
  Record<StrategyId, { readonly name: string; readonly summary: string }>
> = {
  top_down_trendline: {
    name: "Top-Down Trendline",
    summary: "Higher-timeframe alignment + 4H Action/Safety trendlines confirmed on 5m close."
  },
  break_and_retest: {
    name: "Break & Retest",
    summary: "Confirmed structure breakout followed by retest and directional rejection on 5m."
  },
  liquidity_sweep_reversal: {
    name: "Liquidity Sweep Reversal",
    summary: "Swing-level sweep, immediate reclaim, and reversal confirmation aligned with 4H bias."
  },
  order_block_retest: {
    name: "Order-Block Retest",
    summary: "Unmitigated displacement-origin zone surviving invalidation and retest trigger."
  }
};

export function mergeCandles(previous: readonly Candle[], incoming: readonly Candle[]): Candle[] {
  const candlesByTime = new Map(previous.map((candle) => [candle.openTime, candle]));
  for (const candle of incoming) candlesByTime.set(candle.openTime, candle);
  return [...candlesByTime.values()]
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-1000);
}

export function formatPrice(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "—";
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return parsed.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8
  });
}

export function formatVolume(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "—";
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return "—";
  if (parsed >= 1_000_000) return `${(parsed / 1_000_000).toFixed(2)}M`;
  if (parsed >= 1_000) return `${(parsed / 1_000).toFixed(2)}K`;
  return parsed.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function formatRelativeTime(timestamp: number | null | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "Never";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function startOfUtcDay(value: string): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function endOfUtcDay(value: string): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(`${value}T23:59:59.999Z`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function isMarketTimeframe(value: string): value is MarketTimeframe {
  return SUPPORTED_TIMEFRAMES.some((interval) => interval === value);
}

export function normalizeChartSymbol(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{6,20}$/.test(normalized) ? normalized : null;
}

export const ORDERED_TIMEFRAMES: readonly MarketTimeframe[] = [
  "1m",
  "5m",
  "1h",
  "4h",
  "1d",
  "1w",
  "1M"
];

export function formatTimeframeLabel(interval: MarketTimeframe): string {
  switch (interval) {
    case "1d":
      return "1D";
    case "1w":
      return "1W";
    case "1M":
      return "1M";
    default:
      return interval;
  }
}

export function formatTimeframeMatrixLabel(interval: MarketTimeframe): string {
  switch (interval) {
    case "1m":
      return "1m";
    case "5m":
      return "5M";
    case "1h":
      return "1H";
    case "4h":
      return "4H";
    case "1d":
      return "1D";
    case "1w":
      return "1W";
    case "1M":
      return "1M";
  }
}

export function summarizeTopDownAlignment(
  timeframes: readonly TimeframeSummary[]
): TopDownSummary {
  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;
  let totalAvailable = 0;
  for (const tf of timeframes) {
    if (tf.availableAt === null) continue;
    totalAvailable += 1;
    if (tf.regime === "bullish") bullishCount += 1;
    else if (tf.regime === "bearish") bearishCount += 1;
    else neutralCount += 1;
  }
  const dominantRegime: TopDownSummary["dominantRegime"] =
    bullishCount > bearishCount && bullishCount >= neutralCount
      ? "bullish"
      : bearishCount > bullishCount && bearishCount >= neutralCount
        ? "bearish"
        : bullishCount > 0 && bullishCount === bearishCount
          ? "mixed"
          : "neutral";
  const alignedCount = dominantRegime === "bullish"
    ? bullishCount
    : dominantRegime === "bearish"
      ? bearishCount
      : dominantRegime === "mixed"
        ? Math.max(bullishCount, bearishCount)
        : neutralCount;
  return {
    bullishCount,
    bearishCount,
    neutralCount,
    dominantRegime,
    alignedCount,
    totalAvailable
  };
}

export function formatHealthLabel(state: HealthState): string {
  switch (state) {
    case "HEALTHY":
      return "Healthy";
    case "DEGRADED":
      return "Degraded";
    case "DISCONNECTED":
      return "Disconnected";
    case "SLEEPING":
      return "Idle / No Heartbeat";
    case "RECOVERING":
      return "Recovering";
  }
}
