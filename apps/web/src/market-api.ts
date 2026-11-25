import type { Candle } from "@crypto-signal/shared";
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
