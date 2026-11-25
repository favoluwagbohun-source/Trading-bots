import type { Candle } from "@crypto-signal/shared";
import { normalizeSymbol, parseRestKline, validateTimeframe } from "./candle.js";
import type { MarketTimeframe } from "./types.js";

export interface HistoricalRequest {
  readonly symbol: string;
  readonly timeframe: MarketTimeframe;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly limit?: number;
}

export class BinanceRestClient {
  private readonly endpoints: readonly string[];

  constructor(
    endpoints = ["https://data-api.binance.vision", "https://api.binance.com"],
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {
    this.endpoints = endpoints;
  }

  async getHistoricalKlines(request: HistoricalRequest): Promise<Candle[]> {
    validateTimeframe(request.timeframe);
    const symbol = normalizeSymbol(request.symbol);
    const limit = request.limit ?? 1000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("Kline limit must be between 1 and 1000");
    }

    const params = new URLSearchParams({
      symbol,
      interval: request.timeframe,
      limit: String(limit)
    });
    if (request.startTime !== undefined) params.set("startTime", String(request.startTime));
    if (request.endTime !== undefined) params.set("endTime", String(request.endTime));

    let lastError: unknown;
    for (const endpoint of this.endpoints) {
      try {
        const response = await this.fetchImpl(`${endpoint}/api/v3/klines?${params.toString()}`);
        if (!response.ok) {
          throw new Error(`Binance REST ${response.status}: ${await response.text()}`);
        }
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) {
          throw new Error("Binance REST returned a non-array kline response");
        }
        const receivedAt = Date.now();
        return payload.map((row) =>
          parseRestKline(row, Number(Array.isArray(row) ? row[6] : NaN) < receivedAt)
        );
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`Unable to retrieve Binance klines: ${String(lastError)}`);
  }

  async getServerTime(): Promise<number> {
    for (const endpoint of this.endpoints) {
      try {
        const response = await this.fetchImpl(`${endpoint}/api/v3/time`);
        if (!response.ok) continue;
        const payload = (await response.json()) as { serverTime?: unknown };
        if (typeof payload.serverTime === "number") return payload.serverTime;
      } catch {
        // Try the next supported public endpoint.
      }
    }
    throw new Error("Unable to synchronize with Binance server time");
  }
}
