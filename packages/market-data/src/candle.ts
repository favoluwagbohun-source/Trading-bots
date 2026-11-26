import type { Candle } from "@crypto-signal/shared";
import { SUPPORTED_TIMEFRAMES, type MarketTimeframe } from "./types.js";

export type BinanceKlineArray = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

export function normalizeSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!/^([A-Z0-9]{6,20})$/.test(normalized)) {
    throw new Error(`Invalid Binance symbol: ${symbol}`);
  }
  return normalized;
}

export function validateTimeframe(timeframe: string): asserts timeframe is MarketTimeframe {
  if (!SUPPORTED_TIMEFRAMES.includes(timeframe as MarketTimeframe)) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }
}

function finitePrice(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${field} price: ${value}`);
  }
  return parsed;
}

export function validateCandle(candle: Candle): Candle {
  const openTime = Number(candle.openTime);
  const closeTime = Number(candle.closeTime);
  const volume = Number(candle.volume);
  const open = finitePrice(candle.open, "open");
  const high = finitePrice(candle.high, "high");
  const low = finitePrice(candle.low, "low");
  const close = finitePrice(candle.close, "close");

  if (
    !Number.isSafeInteger(openTime) ||
    !Number.isSafeInteger(closeTime) ||
    openTime < 0 ||
    closeTime <= openTime
  ) {
    throw new Error("Invalid candle timestamps");
  }
  if (high < open || high < close || low > open || low > close || high < low) {
    throw new Error("Invalid OHLC candle");
  }
  if (!Number.isFinite(volume) || volume < 0) {
    throw new Error("Invalid candle volume");
  }

  return candle;
}

export function parseRestKline(raw: readonly unknown[], closed = true): Candle {
  if (!Array.isArray(raw) || raw.length < 12) {
    throw new Error("Malformed Binance kline");
  }

  const values = raw as unknown as BinanceKlineArray;
  const candle: Candle = {
    openTime: Number(values[0]),
    open: String(values[1]),
    high: String(values[2]),
    low: String(values[3]),
    close: String(values[4]),
    volume: String(values[5]),
    closeTime: Number(values[6]),
    closed
  };
  return validateCandle(candle);
}

export class CandleStore {
  private readonly candles = new Map<number, Candle>();

  constructor(private readonly expectedIntervalMs?: number) {}

  merge(candle: Candle): { candle: Candle; updated: boolean; duplicate: boolean } {
    const valid = validateCandle(candle);
    const interval = this.expectedIntervalMs;
    if (interval && valid.openTime % interval !== 0) {
      throw new Error("Candle open timestamp is not aligned to timeframe");
    }

    const existing = this.candles.get(valid.openTime);
    if (
      existing &&
      existing.open === valid.open &&
      existing.high === valid.high &&
      existing.low === valid.low &&
      existing.close === valid.close &&
      existing.volume === valid.volume &&
      existing.closed === valid.closed
    ) {
      return { candle: existing, updated: false, duplicate: true };
    }

    this.candles.set(valid.openTime, valid);
    return { candle: valid, updated: true, duplicate: false };
  }

  closedSince(openTimeExclusive: number): Candle[] {
    return [...this.candles.values()]
      .filter((candle) => candle.closed && candle.openTime > openTimeExclusive)
      .sort((a, b) => a.openTime - b.openTime);
  }

  latest(): Candle | undefined {
    const latestTime = Math.max(-1, ...this.candles.keys());
    return latestTime >= 0 ? this.candles.get(latestTime) : undefined;
  }

  clear(): void {
    this.candles.clear();
  }
}
