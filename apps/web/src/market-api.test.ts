import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchHistoricalCandles,
  marketStreamUrl,
  parseMarketStreamMessage
} from "./market-api.js";

const candle = {
  openTime: 1_700_000_000_000,
  closeTime: 1_700_000_299_999,
  open: "100",
  high: "102",
  low: "99",
  close: "101",
  volume: "10",
  closed: true
};

describe("web market API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests historical candles from the platform API and validates the response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candles: [candle] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchHistoricalCandles({
      symbol: "BTCUSDT",
      timeframe: "5m",
      limit: 500,
      startTime: 1_700_000_000_000
    })).resolves.toEqual([candle]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/market/klines?symbol=BTCUSDT&timeframe=5m&limit=500&startTime=1700000000000",
      {}
    );
  });

  it("rejects malformed OHLC data rather than rendering it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      candles: [{ ...candle, high: "98" }]
    }))));

    await expect(fetchHistoricalCandles({
      symbol: "BTCUSDT",
      timeframe: "5m",
      limit: 10
    })).rejects.toThrow("invalid OHLCV candle");
  });

  it("builds secure WebSocket URLs and parses live candle messages", () => {
    expect(marketStreamUrl("BTCUSDT", "5m", "https://charts.example"))
      .toBe("wss://charts.example/api/market/stream?symbol=BTCUSDT&timeframe=5m");
    expect(parseMarketStreamMessage(JSON.stringify({ type: "candle", candle })))
      .toEqual({ type: "candle", candle });
  });
});
