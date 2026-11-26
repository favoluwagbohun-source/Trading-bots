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

  it("streams a requested historical range in bounded, non-overlapping pages", async () => {
    const rows = [
      [100, "100", "101", "99", "100", "1", 199, "1", 1, "1", "1", "0"],
      [200, "100", "101", "99", "100", "1", 299, "1", 1, "1", "1", "0"],
      [300, "100", "101", "99", "100", "1", 399, "1", 1, "1", "1", "0"]
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const startTime = Number(url.searchParams.get("startTime"));
      const limit = Number(url.searchParams.get("limit"));
      const page = rows.filter((row) => Number(row[0]) >= startTime).slice(0, limit);
      return new Response(JSON.stringify(page), { status: 200 });
    });
    const client = new BinanceRestClient(["https://data-api.binance.vision"], fetchImpl);
    const pages = [];
    for await (const page of client.iterateHistoricalKlines({
      symbol: "BTCUSDT",
      timeframe: "5m",
      startTime: 100,
      endTime: 300,
      limit: 2,
      pageDelayMs: 0
    })) {
      pages.push(page.map(({ openTime }) => openTime));
    }

    expect(pages).toEqual([[100, 200], [300]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("skips and counts only Binance zero-duration, zero-volume empty candles", async () => {
    const emptyRow = [
      100, "100", "100", "100", "100", "0", 100, "0", 0, "0", "0", "0"
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new BinanceRestClient(
      ["https://data-api.binance.vision"],
      async () => new Response(JSON.stringify([emptyRow]), { status: 200 })
    );
    try {
      await expect(client.getHistoricalKlines({
        symbol: "BTCUSDT",
        timeframe: "5m",
        limit: 1
      })).resolves.toEqual([]);
      expect(client.skippedNoTradeCandleCount).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        "Skipping Binance zero-duration zero-volume candle at 100"
      );

      const pages = [];
      const rangeClient = new BinanceRestClient(
        ["https://data-api.binance.vision"],
        async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          const startTime = Number(url.searchParams.get("startTime"));
          const page = startTime <= 100
            ? [emptyRow, [
                200, "100", "101", "99", "100", "1", 299, "1", 1, "1", "1", "0"
              ]]
            : [[
                300, "100", "101", "99", "100", "1", 399, "1", 1, "1", "1", "0"
              ]];
          return new Response(JSON.stringify(page), { status: 200 });
        }
      );
      for await (const page of rangeClient.iterateHistoricalKlines({
        symbol: "BTCUSDT",
        timeframe: "5m",
        startTime: 100,
        endTime: 300,
        limit: 2,
        pageDelayMs: 0
      })) {
        pages.push(page.map(({ openTime }) => openTime));
      }
      expect(pages).toEqual([[200], [300]]);
      expect(rangeClient.skippedNoTradeCandleCount).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects invalid historical range arguments before requesting Binance", async () => {
    const fetchImpl = vi.fn();
    const client = new BinanceRestClient(["https://data-api.binance.vision"], fetchImpl);
    const iterator = client.iterateHistoricalKlines({
      symbol: "BTCUSDT",
      timeframe: "5m",
      startTime: 300,
      endTime: 100
    });

    await expect(iterator.next()).rejects.toThrow("valid and ordered");
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it("ignores Binance's zero market quantity step while retaining its maximum quantity", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      symbols: [{
        symbol: "BTCUSDT",
        filters: [
          { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "9000", stepSize: "0.00001" },
          { filterType: "MARKET_LOT_SIZE", minQty: "0", maxQty: "136.43606129", stepSize: "0" },
          { filterType: "NOTIONAL", minNotional: "5", applyMaxToMarket: false }
        ]
      }]
    }), { status: 200 }));
    const client = new BinanceRestClient(["https://data-api.binance.vision"], fetchImpl);

    await expect(client.getInstrumentRules("BTCUSDT")).resolves.toEqual({
      quantityStep: 0.00001,
      minimumQuantity: 0.00001,
      maximumQuantity: 136.43606129,
      minimumNotional: 5,
      contractMultiplier: 1
    });
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
