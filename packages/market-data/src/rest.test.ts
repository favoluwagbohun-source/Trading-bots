import { describe, expect, it, vi } from "vitest";
import { BinanceRestClient } from "./rest.js";

describe("Binance REST client", () => {
  it("retrieves historical public klines", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      [1700000000000, "100", "105", "99", "104", "12", 1700000059999,
        "1000", 200, "8", "800", "0"]
    ]), { status: 200 }));
    const client = new BinanceRestClient(["https://data-api.binance.vision"], fetchImpl);

    const candles = await client.getHistoricalKlines({
      symbol: "btcusdt",
      timeframe: "5m",
      limit: 1
    });

    expect(candles).toHaveLength(1);
    expect(candles[0]?.close).toBe("104");
  });

  it("falls back to the secondary endpoint", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    const client = new BinanceRestClient(
      ["https://data-api.binance.vision", "https://api.binance.com"],
      fetchImpl
    );

    await expect(client.getHistoricalKlines({
      symbol: "BTCUSDT",
      timeframe: "5m"
    })).resolves.toEqual([]);
  });

  it("marks the current unfinished Binance candle as open", async () => {
    const now = Date.now();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      [now, "100", "105", "99", "104", "12", now + 299_999,
        "1000", 200, "8", "800", "0"]
    ]), { status: 200 }));
    const client = new BinanceRestClient(["https://data-api.binance.vision"], fetchImpl);

    const candles = await client.getHistoricalKlines({
      symbol: "BTCUSDT",
      timeframe: "5m",
      limit: 1
    });

    expect(candles[0]?.closed).toBe(false);
  });
});
