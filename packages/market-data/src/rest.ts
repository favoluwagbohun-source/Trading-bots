import type { Candle } from "@crypto-signal/shared";
import { normalizeSymbol, parseRestKline, validateTimeframe } from "./candle.js";
import type { MarketTimeframe } from "./types.js";

export interface ExchangeInstrumentRules {
  readonly quantityStep: number;
  readonly minimumQuantity: number;
  readonly maximumQuantity: number;
  readonly minimumNotional: number;
  readonly maximumNotional?: number;
  readonly contractMultiplier: number;
}

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

  async getInstrumentRules(symbolInput: string): Promise<ExchangeInstrumentRules> {
    const symbol = normalizeSymbol(symbolInput);
    const params = new URLSearchParams({ symbol });
    let lastError: unknown;
    for (const endpoint of this.endpoints) {
      try {
        const response = await this.fetchImpl(
          `${endpoint}/api/v3/exchangeInfo?${params.toString()}`
        );
        if (!response.ok) {
          throw new Error(`Binance REST ${response.status}: ${await response.text()}`);
        }
        const payload: unknown = await response.json();
        return parseInstrumentRules(payload, symbol);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Unable to retrieve Binance instrument rules: ${String(lastError)}`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInstrumentRules(payload: unknown, symbol: string): ExchangeInstrumentRules {
  if (!isRecord(payload) || !Array.isArray(payload.symbols)) {
    throw new Error("Binance exchangeInfo returned a malformed response");
  }
  const instrument = payload.symbols.find((item) =>
    isRecord(item) && item.symbol === symbol
  );
  if (!isRecord(instrument) || !Array.isArray(instrument.filters)) {
    throw new Error(`Binance exchangeInfo did not include ${symbol}`);
  }

  const filters = instrument.filters.filter(isRecord);
  const lotSizes = filters.filter((filter) =>
    filter.filterType === "LOT_SIZE" || filter.filterType === "MARKET_LOT_SIZE"
  );
  const notionals = filters.filter((filter) =>
    filter.filterType === "MIN_NOTIONAL" || filter.filterType === "NOTIONAL"
  );
  const steps = lotSizes.map((filter) => Number(filter.stepSize));
  const quantityStep = steps.length ? Math.max(...steps) : NaN;
  const minimumQuantity = lotSizes.length
    ? Math.max(...lotSizes.map((filter) => Number(filter.minQty)))
    : NaN;
  const maximumQuantity = lotSizes.length
    ? Math.min(...lotSizes.map((filter) => Number(filter.maxQty)))
    : NaN;
  const minimumNotionals = notionals
    .map((filter) => Number(filter.minNotional))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const maximumNotionals = notionals
    .filter((filter) => filter.applyMaxToMarket !== false)
    .map((filter) => Number(filter.maxNotional))
    .filter((value) => Number.isFinite(value) && value > 0);
  const minimumNotional = minimumNotionals.length
    ? Math.max(...minimumNotionals)
    : NaN;
  const maximumNotional = maximumNotionals.length
    ? Math.min(...maximumNotionals)
    : undefined;
  const compatibleSteps = steps.every((step) => {
    const ratio = quantityStep / step;
    return Number.isFinite(step) && step > 0 && Math.abs(ratio - Math.round(ratio)) < 1e-8;
  });
  if (
    !lotSizes.length ||
    !notionals.length ||
    !compatibleSteps ||
    !Number.isFinite(quantityStep) || quantityStep <= 0 ||
    !Number.isFinite(minimumQuantity) || minimumQuantity <= 0 ||
    !Number.isFinite(maximumQuantity) || maximumQuantity < minimumQuantity ||
    !Number.isFinite(minimumNotional)
  ) {
    throw new Error(`Binance exchangeInfo has incomplete quantity rules for ${symbol}`);
  }
  return {
    quantityStep,
    minimumQuantity,
    maximumQuantity,
    minimumNotional,
    ...(maximumNotional === undefined ? {} : { maximumNotional }),
    contractMultiplier: 1
  };
}
