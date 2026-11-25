import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import type { Trendline } from "@crypto-signal/indicators";
import {
  activateAtNextOpen,
  evaluateTopDownTrendline,
  type TopDownBias,
  type TopDownContext
} from "./top-down-trendline.js";

function candle(index: number, values: {
  open: number;
  high: number;
  low: number;
  close: number;
  closed?: boolean;
}): Candle {
  const openTime = 1_000_000 + index * 300_000;
  return {
    openTime,
    closeTime: openTime + 299_999,
    open: String(values.open),
    high: String(values.high),
    low: String(values.low),
    close: String(values.close),
    volume: "10",
    closed: values.closed ?? true
  };
}

const bullishBias: TopDownBias = {
  "1M": { regime: "bullish", availableAt: 0 },
  "1W": { regime: "bullish", availableAt: 0 },
  "1D": { regime: "bullish", availableAt: 0 },
  "4H": { regime: "bullish", availableAt: 0 },
  "1H": { regime: "bullish", availableAt: 0 }
};

function descendingLine(): Trendline {
  return {
    id: "descending-example",
    direction: "descending",
    anchorA: { candleIndex: 0, openTime: 1_200_000, price: 105 },
    anchorB: { candleIndex: 1, openTime: 1_500_000, price: 103 },
    slope: -2 / 300_000,
    touchIndices: [0, 1, 2],
    qualifyingTouchCount: 3,
    confirmedAtIndex: 2,
    confirmedAtTime: 1_799_999,
    brokenAtIndex: undefined
  };
}

function ascendingLine(): Trendline {
  return {
    ...descendingLine(),
    id: "ascending-example",
    direction: "ascending",
    anchorA: { candleIndex: 0, openTime: 1_200_000, price: 100 },
    anchorB: { candleIndex: 1, openTime: 1_500_000, price: 102 },
    slope: 2 / 300_000
  };
}

function context(
  mode: TopDownContext["mode"],
  executionCandles: readonly Candle[],
  fourHourTrendlines: readonly Trendline[] = [descendingLine()],
  higherTimeframeBias = bullishBias
): TopDownContext {
  return {
    symbol: "btcusdt",
    mode,
    executionCandles,
    fourHourTrendlines,
    higherTimeframeBias
  };
}

describe("top-down trendline prototype", () => {
  it("generates a bullish break signal only on a closed 5m candle", () => {
    const execution = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 101, high: 102, low: 100, close: 101 }),
      candle(2, { open: 102, high: 106, low: 101, close: 106 })
    ];
    const signal = evaluateTopDownTrendline(context("break", execution));

    expect(signal).toMatchObject({
      strategy: "top_down_trendline",
      side: "buy",
      mode: "break",
      executionTimeframe: "5m",
      entryCandleOpenTime: execution[2]!.closeTime + 1
    });

    const unfinished = [...execution.slice(0, 2), { ...execution[2]!, closed: false }];
    expect(evaluateTopDownTrendline(context("break", unfinished))).toBeUndefined();
  });

  it("rejects stale or opposing higher-timeframe bias", () => {
    const execution = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 101, high: 102, low: 100, close: 101 }),
      candle(2, { open: 102, high: 106, low: 101, close: 106 })
    ];
    const conflicting: TopDownBias = {
      ...bullishBias,
      "1D": { regime: "bearish", availableAt: 0 }
    };
    const stale: TopDownBias = {
      ...bullishBias,
      "1H": { regime: "bullish", availableAt: execution[2]!.closeTime + 1 }
    };

    expect(evaluateTopDownTrendline(context("break", execution, [descendingLine()], conflicting)))
      .toBeUndefined();
    expect(evaluateTopDownTrendline(context("break", execution, [descendingLine()], stale)))
      .toBeUndefined();
  });

  it("supports bounce and retest confirmations", () => {
    const bounceCandles = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 101, high: 103, low: 100, close: 102 }),
      candle(2, { open: 104, high: 106, low: 104.5, close: 105 })
    ];
    const bounce = evaluateTopDownTrendline(context(
      "bounce",
      bounceCandles,
      [ascendingLine()]
    ));
    expect(bounce).toMatchObject({ side: "buy", mode: "bounce" });

    const retestCandles = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 102, high: 104, low: 101, close: 103 }),
      candle(2, { open: 100.8, high: 103, low: 100.2, close: 101.5 })
    ];
    const retest = evaluateTopDownTrendline(context("retest", retestCandles));
    expect(retest).toMatchObject({ side: "buy", mode: "retest" });
  });

  it("requires the next candle open and calculates fixed R targets", () => {
    const execution = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 101, high: 102, low: 100, close: 101 }),
      candle(2, { open: 102, high: 106, low: 100, close: 106 })
    ];
    const signal = evaluateTopDownTrendline(context("break", execution));
    expect(signal).toBeDefined();
    const next = candle(3, { open: 106, high: 108, low: 105, close: 107 });
    const plan = activateAtNextOpen(signal!, next);

    expect(plan.entryPrice).toBe(106);
    expect(plan.target1).toBeGreaterThan(plan.entryPrice);
    expect(plan.target2).toBeGreaterThan(plan.target1);
    expect(plan.minimumRiskReward).toBe(3);
    expect(plan.target3).toBe("trailing_runner");
    expect(() => activateAtNextOpen(signal!, candle(4, {
      open: 106, high: 108, low: 105, close: 107
    }))).toThrow("immediate next");
  });

  it("ignores trendlines not confirmed by the signal candle", () => {
    const execution = [
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 101, high: 102, low: 100, close: 101 }),
      candle(2, { open: 102, high: 106, low: 101, close: 106 })
    ];
    const futureLine = {
      ...descendingLine(),
      confirmedAtTime: execution[2]!.closeTime + 1
    };
    expect(evaluateTopDownTrendline(context("break", execution, [futureLine])))
      .toBeUndefined();
  });
});
