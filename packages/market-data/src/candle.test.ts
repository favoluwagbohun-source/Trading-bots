import { describe, expect, it } from "vitest";
import {
  CandleStore,
  normalizeSymbol,
  parseRestKline,
  validateCandle,
  validateTimeframe
} from "./candle.js";

describe("market-data candles", () => {
  it("normalizes valid symbols", () => {
    expect(normalizeSymbol(" btcusdt ")).toBe("BTCUSDT");
  });

  it("supports Binance monthly and one-minute intervals distinctly", () => {
    expect(() => validateTimeframe("1M")).not.toThrow();
    expect(() => validateTimeframe("1m")).not.toThrow();
  });

  it("parses and validates Binance REST klines", () => {
    const candle = parseRestKline([
      1700000000000, "100", "105", "99", "104", "12", 1700000059999,
      "1000", 200, "8", "800", "0"
    ]);

    expect(candle.closed).toBe(true);
    expect(candle.close).toBe("104");
  });

  it("rejects invalid OHLC candles", () => {
    expect(() => validateCandle({
      openTime: 1,
      closeTime: 2,
      open: "100",
      high: "99",
      low: "101",
      close: "100",
      volume: "1",
      closed: true
    })).toThrow("Invalid OHLC");
  });

  it("deduplicates unchanged candles and stores candle updates", () => {
    const store = new CandleStore();
    const candle = {
      openTime: 1700000000000,
      closeTime: 1700000059999,
      open: "100",
      high: "105",
      low: "99",
      close: "104",
      volume: "12",
      closed: false
    };

    expect(store.merge(candle).duplicate).toBe(false);
    expect(store.merge(candle).duplicate).toBe(true);
    expect(store.merge({ ...candle, close: "103", closed: true }).updated).toBe(true);
  });
});
