import type {
  Candle,
  HealthState,
  MarketDataHealthSnapshot,
  SignalEngineHealthSnapshot,
  StrategyId,
  TelegramHealthSnapshot
} from "@crypto-signal/shared";
import type { MarketTimeframe, StreamStatus } from "@crypto-signal/market-data";

export interface HistoricalQuery {
  readonly symbol: string;
  readonly timeframe: MarketTimeframe;
  readonly limit: number;
  readonly startTime?: number;
  readonly endTime?: number;
}

export type MarketStreamMessage =
  | { readonly type: "candle"; readonly candle: Candle }
  | { readonly type: "status"; readonly status: StreamStatus }
  | { readonly type: "error"; readonly message: string };

export interface TimeframeSummary {
  readonly timeframe: MarketTimeframe;
  readonly availableAt: number | null;
  readonly regime: "bullish" | "bearish" | "neutral";
  readonly volatilityRegime: "low" | "normal" | "high";
  readonly trendStrength: number;
  readonly latestHigh: number | null;
  readonly latestLow: number | null;
  readonly candleCount: number;
}

export interface FourHourTrendline {
  readonly id: string;
  readonly direction: "ascending" | "descending";
  readonly status: "valid" | "broken";
  readonly breakStatus: "unbroken" | "broken_above" | "broken_below";
  readonly qualifyingTouchCount: number;
  readonly anchorA: { readonly openTime: number; readonly price: number };
  readonly anchorB: { readonly openTime: number; readonly price: number };
  readonly projectedPrice: number;
}

export interface SwingLevel {
  readonly id: string;
  readonly timeframe: "4h" | "1h";
  readonly direction: "high" | "low";
  readonly price: number;
  readonly openTime: number;
}

export interface StrategyEvaluationSummary {
  readonly strategy: StrategyId;
  readonly variation?: "break" | "bounce" | "retest";
  readonly status: "setup_confirmed" | "rejected";
  readonly direction: "buy" | "sell" | null;
  readonly relevantTimeframe: MarketTimeframe;
  readonly evidence: readonly string[];
  readonly entryCondition: string;
  readonly invalidationCondition: string;
  readonly stopMethodology: string;
  readonly targetMethodology: string;
  readonly reason: string;
  readonly signalId: string | null;
}

export interface SignalCandidateSummary {
  readonly signalId: string;
  readonly strategy: StrategyId;
  readonly mode?: "break" | "bounce" | "retest";
  readonly side: "buy" | "sell";
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly target1: number;
  readonly target2: number;
  readonly target3: "trailing_runner";
  readonly minimumRiskReward: number;
  readonly higherTimeframeBias: string;
  readonly entryCandleOpenTime: number;
}

export interface MarketAnalysisData {
  readonly symbol: string;
  readonly snapshotId: string;
  readonly analysisTime: number;
  readonly latestPrice: number;
  readonly signalCandle: Candle;
  readonly timeframes: readonly TimeframeSummary[];
  readonly fourHourTrendlines: readonly FourHourTrendline[];
  readonly swingLevels: readonly SwingLevel[];
  readonly evaluations: readonly StrategyEvaluationSummary[];
  readonly candidates: readonly SignalCandidateSummary[];
  readonly warnings: readonly string[];
}

export interface OverallHealthSummary {
  readonly status: "ok";
  readonly api: "HEALTHY";
  readonly state: HealthState;
  readonly workerState: HealthState;
  readonly stale: boolean;
  readonly hostingEnvironment: string;
  readonly workerUpdatedAt: number | null;
  readonly uptimeSeconds: number;
  readonly timestamp: number;
  readonly subsystems: {
    readonly marketData: HealthState;
    readonly signalEngine: HealthState;
    readonly telegram: HealthState;
  };
}

export interface PlatformHealthBundle {
  readonly overall: OverallHealthSummary;
  readonly marketData: MarketDataHealthSnapshot & {
    readonly stale: boolean;
    readonly updatedAt: number | null;
    readonly hostingEnvironment: string;
  };
  readonly signalEngine: SignalEngineHealthSnapshot & {
    readonly stale: boolean;
    readonly updatedAt: number | null;
    readonly hostingEnvironment: string;
  };
  readonly telegram: TelegramHealthSnapshot & {
    readonly stale: boolean;
    readonly updatedAt: number | null;
    readonly hostingEnvironment: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCandle(value: unknown): Candle {
  if (!isRecord(value)) throw new Error("Market API returned an invalid candle");
  const { openTime, closeTime, open, high, low, close, volume, closed } = value;
  const prices = [open, high, low, close].map(Number);
  if (
    !Number.isSafeInteger(openTime) ||
    !Number.isSafeInteger(closeTime) ||
    Number(closeTime) <= Number(openTime) ||
    !prices.every((price) => Number.isFinite(price) && price > 0) ||
    prices[1]! < Math.max(prices[0]!, prices[3]!) ||
    prices[2]! > Math.min(prices[0]!, prices[3]!) ||
    prices[2]! > prices[1]! ||
    !Number.isFinite(Number(volume)) ||
    Number(volume) < 0 ||
    typeof closed !== "boolean"
  ) {
    throw new Error("Market API returned an invalid OHLCV candle");
  }
  return {
    openTime: Number(openTime),
    closeTime: Number(closeTime),
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: String(volume),
    closed
  };
}

export async function fetchHistoricalCandles(
  query: HistoricalQuery,
  signal?: AbortSignal
): Promise<Candle[]> {
  const params = new URLSearchParams({
    symbol: query.symbol,
    timeframe: query.timeframe,
    limit: String(query.limit)
  });
  if (query.startTime !== undefined) params.set("startTime", String(query.startTime));
  if (query.endTime !== undefined) params.set("endTime", String(query.endTime));

  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
  const init: RequestInit = signal === undefined ? {} : { signal };
  const response = await fetch(`${baseUrl}/api/market/klines?${params.toString()}`, init);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const message = isRecord(body) && typeof body.error === "string"
      ? body.error
      : `Market API returned HTTP ${response.status}`;
    throw new Error(message);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.candles)) {
    throw new Error("Market API returned an invalid historical response");
  }
  return body.candles.map(parseCandle);
}

export async function fetchMarketAnalysis(
  symbol: string,
  signal?: AbortSignal
): Promise<MarketAnalysisData> {
  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
  const init: RequestInit = signal === undefined ? {} : { signal };
  const params = new URLSearchParams({ symbol });
  const response = await fetch(`${baseUrl}/api/market/analysis?${params.toString()}`, init);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const message = isRecord(body) && typeof body.error === "string"
      ? body.error
      : `Market analysis API returned HTTP ${response.status}`;
    throw new Error(message);
  }
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    typeof body.symbol !== "string" ||
    !Array.isArray(body.timeframes) ||
    !Array.isArray(body.evaluations)
  ) {
    throw new Error("Market analysis API returned an invalid response");
  }
  return body as unknown as MarketAnalysisData;
}

export async function fetchPlatformHealth(
  signal?: AbortSignal
): Promise<PlatformHealthBundle> {
  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
  const init: RequestInit = signal === undefined ? {} : { signal };
  const [overallRes, marketRes, engineRes, telegramRes] = await Promise.all([
    fetch(`${baseUrl}/health`, init),
    fetch(`${baseUrl}/health/market-data`, init),
    fetch(`${baseUrl}/health/signal-engine`, init),
    fetch(`${baseUrl}/health/telegram`, init)
  ]);
  if (!overallRes.ok || !marketRes.ok || !engineRes.ok || !telegramRes.ok) {
    throw new Error("Health endpoint returned an unexpected status");
  }
  const [overall, marketData, signalEngine, telegram] = await Promise.all([
    overallRes.json(),
    marketRes.json(),
    engineRes.json(),
    telegramRes.json()
  ]);
  return {
    overall: overall as OverallHealthSummary,
    marketData: marketData as PlatformHealthBundle["marketData"],
    signalEngine: signalEngine as PlatformHealthBundle["signalEngine"],
    telegram: telegram as PlatformHealthBundle["telegram"]
  };
}

export function marketStreamUrl(
  symbol: string,
  timeframe: MarketTimeframe,
  origin = window.location.origin,
  configuredBaseUrl = import.meta.env.VITE_API_BASE_URL ?? ""
): string {
  const url = new URL("/api/market/stream", configuredBaseUrl || origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = new URLSearchParams({ symbol, timeframe }).toString();
  return url.toString();
}

export function parseMarketStreamMessage(data: string): MarketStreamMessage {
  const parsed: unknown = JSON.parse(data);
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new Error("Market stream returned an invalid message");
  }
  if (parsed.type === "candle") {
    return { type: "candle", candle: parseCandle(parsed.candle) };
  }
  if (parsed.type === "status") {
    const status = parsed.status;
    if (
      !isRecord(status) ||
      typeof status.connected !== "boolean" ||
      typeof status.reconnectAttempt !== "number" ||
      !Number.isInteger(status.reconnectAttempt) ||
      (status.lastUpdateTime !== null &&
        (typeof status.lastUpdateTime !== "number" ||
          !Number.isSafeInteger(status.lastUpdateTime))) ||
      typeof status.message !== "string"
    ) {
      throw new Error("Market stream returned an invalid connection status");
    }
    return {
      type: "status",
      status: {
        connected: status.connected,
        lastUpdateTime: status.lastUpdateTime,
        reconnectAttempt: status.reconnectAttempt,
        message: status.message
      }
    };
  }
  if (parsed.type === "error" && typeof parsed.message === "string") {
    return { type: "error", message: parsed.message };
  }
  throw new Error("Market stream returned an unsupported message");
}
