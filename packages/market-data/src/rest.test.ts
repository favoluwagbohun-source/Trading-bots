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

  it("retrieves and validates Binance spot quantity and notional rules", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      symbols: [{
        symbol: "BTCUSDT",
        filters: [
          { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "9000", stepSize: "0.00001" },
          { filterType: "MARKET_LOT_SIZE", minQty: "0.00002", maxQty: "8000", stepSize: "0.00002" },
          { filterType: "MIN_NOTIONAL", minNotional: "5" },
          { filterType: "NOTIONAL", minNotional: "5", maxNotional: "1000000", applyMaxToMarket: true }
        ]
      }]
    }), { status: 200 }));
    const client = new BinanceRestClient(["https://data-api.binance.vision"], fetchImpl);

    await expect(client.getInstrumentRules("btcusdt")).resolves.toEqual({
      quantityStep: 0.00002,
      minimumQuantity: 0.00002,
      maximumQuantity: 8000,
      minimumNotional: 5,
      maximumNotional: 1000000,
      contractMultiplier: 1
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/api/v3/exchangeInfo?symbol=BTCUSDT");
  });

  it("rejects incomplete exchange filters instead of guessing sizing rules", async () => {
    const client = new BinanceRestClient(["https://data-api.binance.vision"], async () =>
      new Response(JSON.stringify({
        symbols: [{ symbol: "BTCUSDT", filters: [] }]
      }), { status: 200 })
    );

    await expect(client.getInstrumentRules("BTCUSDT"))
      .rejects.toThrow("incomplete quantity rules");
  });
});
