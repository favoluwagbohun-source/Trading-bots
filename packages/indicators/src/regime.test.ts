import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { classifyMarketRegime } from "./regime.js";

function candle(index: number, close: number, range: number): Candle {
  const openTime = index * 300_000;
  return {
    openTime,
    closeTime: openTime + 299_999,
    open: String(close),
    high: String(close + range / 2),
    low: String(close - range / 2),
    close: String(close),
    volume: "10",
    closed: true
  };
}

function swing(
  direction: "high" | "low",
  index: number,
  price: number
) {
  return {
    direction,
    index,
    openTime: index * 300_000,
    price,
    confirmedIndex: index + 1,
    confirmedAt: (index + 1) * 300_000 + 299_999
  } as const;
}

describe("documented market regime classifier", () => {
  it("uses ATR percent thresholds for high and low volatility", () => {
    const high = Array.from({ length: 5 }, (_, index) => candle(index, 100, 8));
    const low = Array.from({ length: 5 }, (_, index) => candle(index, 100, 0.1));

    expect(classifyMarketRegime(high, [], {
      atrPeriod: 3,
      highVolatilityAtrPercent: 5,
      lowVolatilityAtrPercent: 0.1
    }).regime).toBe("high_volatility");
    expect(classifyMarketRegime(low, [], {
      atrPeriod: 3,
      highVolatilityAtrPercent: 5,
      lowVolatilityAtrPercent: 0.2
    }).regime).toBe("low_volatility");
  });

  it("returns an explicit uncertain regime when confirmed directional structure is absent", () => {
    const candles = Array.from({ length: 5 }, (_, index) => candle(index, 100 + index * 2, 1));
    const result = classifyMarketRegime(candles, [], {
      atrPeriod: 3,
      highVolatilityAtrPercent: 50,
      lowVolatilityAtrPercent: 0,
      rangeDriftPercent: 0.1
    });

    expect(result.regime).toBe("transition_uncertain");
    expect(result.asOfTime).toBe(candles.at(-1)!.closeTime);
    expect(result.rationale).toContain("neutral");
  });

  it("distinguishes confirmed trends and a neutral range", () => {
    const candles = Array.from({ length: 20 }, (_, index) => candle(index, 100, 1));
    const options = {
      atrPeriod: 3,
      highVolatilityAtrPercent: 50,
      lowVolatilityAtrPercent: 0,
      rangeDriftPercent: 0.1
    };

    expect(classifyMarketRegime(candles, [
      swing("low", 5, 98),
      swing("high", 10, 102)
    ], options).regime).toBe("bullish_trend");
    expect(classifyMarketRegime(candles, [
      swing("high", 5, 102),
      swing("low", 10, 98)
    ], options).regime).toBe("bearish_trend");
    expect(classifyMarketRegime(candles, [], options).regime).toBe("range");
  });

  it("reports transition for an empty closed-candle history", () => {
    expect(classifyMarketRegime([], []).regime).toBe("transition_uncertain");
  });
});
