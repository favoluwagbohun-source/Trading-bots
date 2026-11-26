import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import {
  activateSetupAtNextOpen,
  evaluateBreakAndRetest,
  evaluateBreakAndRetestState,
  evaluateLiquiditySweep,
  evaluateOrderBlockRetest,
  type PriceLevel
} from "./index.js";

function candle(index: number, values: {
  open: number;
  high: number;
  low: number;
  close: number;
  closed?: boolean;
}): Candle {
  const openTime = 2_000_000 + index * 300_000;
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

describe("independent additional strategy prototypes", () => {
  it("detects an established-level breakout, valid retest, and next-open plan", () => {
    const level: PriceLevel = {
      id: "swing-high",
      kind: "swing_high",
      price: 10,
      confirmedAt: 0
    };
    const candles = [
      candle(0, { open: 9, high: 10, low: 8, close: 9 }),
      candle(1, { open: 9, high: 11, low: 9, close: 11 }),
      candle(2, { open: 11, high: 12, low: 10.5, close: 11.5 }),
      candle(3, { open: 10.1, high: 11, low: 9.9, close: 10.5 })
    ];
    const setup = evaluateBreakAndRetest({
      symbol: "btcusdt",
      candles,
      levels: [level]
    });
    expect(setup).toMatchObject({
      strategy: "break_and_retest",
      side: "buy",
      reference: { kind: "level", price: 10 }
    });
    expect(evaluateBreakAndRetestState({
      symbol: "btcusdt",
      candles,
      levels: [level]
    })).toMatchObject({ state: "retest_confirmed", levelId: level.id });

    const next = candle(4, { open: 10.5, high: 11, low: 10, close: 10.7 });
    const plan = activateSetupAtNextOpen(setup!, next);
    expect(plan.entryPrice).toBe(10.5);
    expect(plan.minimumRiskReward).toBe(2);
  });

  it("rejects a retest after price invalidates the broken level", () => {
    const level: PriceLevel = {
      id: "swing-high",
      kind: "swing_high",
      price: 10,
      confirmedAt: 0
    };
    const candles = [
      candle(0, { open: 9, high: 10, low: 8, close: 9 }),
      candle(1, { open: 9, high: 11, low: 9, close: 11 }),
      candle(2, { open: 10, high: 10.5, low: 9, close: 9.5 }),
      candle(3, { open: 9.5, high: 11, low: 9.4, close: 10.5 })
    ];
    expect(evaluateBreakAndRetest({
      symbol: "BTCUSDT",
      candles,
      levels: [level]
    })).toBeUndefined();
    expect(evaluateBreakAndRetestState({
      symbol: "BTCUSDT",
      candles,
      levels: [level]
    })).toMatchObject({ state: "invalidated", levelId: level.id });
  });

  it("distinguishes an active breakout awaiting a retest from a completed setup", () => {
    const level: PriceLevel = {
      id: "swing-high",
      kind: "swing_high",
      price: 10,
      confirmedAt: 0
    };
    const evaluation = evaluateBreakAndRetestState({
      symbol: "BTCUSDT",
      levels: [level],
      candles: [
        candle(0, { open: 9, high: 10, low: 8, close: 9 }),
        candle(1, { open: 9, high: 11, low: 9, close: 11 }),
        candle(2, { open: 11, high: 12, low: 10.5, close: 11.5 })
      ]
    });

    expect(evaluation).toMatchObject({
      state: "awaiting_retest",
      levelId: level.id
    });
    expect(evaluation.setup).toBeUndefined();
  });

  it("requires a closed sweep candle and a previously confirmed swing level", () => {
    const level: PriceLevel = {
      id: "swing-low",
      kind: "swing_low",
      price: 100,
      confirmedAt: 0
    };
    const base = [
      candle(0, { open: 100.5, high: 101, low: 99, close: 100.5 }),
      candle(1, { open: 100.5, high: 101, low: 99, close: 100.8 })
    ];
    const setup = evaluateLiquiditySweep({
      symbol: "BTCUSDT",
      candles: base,
      levels: [level]
    });
    expect(setup).toMatchObject({
      strategy: "liquidity_sweep_reversal",
      side: "buy",
      reference: { kind: "level", price: 100 }
    });

    expect(evaluateLiquiditySweep({
      symbol: "BTCUSDT",
      candles: [{ ...base[1]!, closed: false }],
      levels: [level]
    })).toBeUndefined();
    expect(evaluateLiquiditySweep({
      symbol: "BTCUSDT",
      candles: [base[1]!],
      levels: [{ ...level, confirmedAt: base[1]!.openTime + 1 }]
    })).toBeUndefined();
  });

  it("uses higher-timeframe bias to reject opposing liquidity-sweep setups", () => {
    const level: PriceLevel = {
      id: "4h-swing-low",
      kind: "swing_low",
      price: 100,
      confirmedAt: 0
    };
    const candles = [
      candle(0, { open: 100.5, high: 101, low: 99, close: 100.5 }),
      candle(1, { open: 100.5, high: 101, low: 99, close: 100.8 })
    ];

    expect(evaluateLiquiditySweep({
      symbol: "BTCUSDT",
      candles,
      levels: [level],
      higherTimeframeBias: "bearish"
    })).toBeUndefined();
    expect(evaluateLiquiditySweep({
      symbol: "BTCUSDT",
      candles,
      levels: [level],
      higherTimeframeBias: "bullish"
    })).toMatchObject({ side: "buy" });
  });

  it("requires opposing base, ATR displacement, and confirmed zone retest", () => {
    const candles = [
      candle(0, { open: 101, high: 102, low: 99, close: 100 }),
      candle(1, { open: 100, high: 107, low: 100, close: 106 }),
      candle(2, { open: 102.5, high: 105, low: 101, close: 103 })
    ];
    const setup = evaluateOrderBlockRetest({
      symbol: "BTCUSDT",
      candles,
      atrValues: [1, 2, 1]
    });
    expect(setup).toMatchObject({
      strategy: "order_block_retest",
      side: "buy",
      reference: { kind: "zone", low: 99, high: 102 }
    });

    expect(evaluateOrderBlockRetest({
      symbol: "BTCUSDT",
      candles,
      atrValues: [1, 4, 1]
    })).toBeUndefined();
  });

  it("allows the order-block invalidation rule to be selected independently", () => {
    const candles = [
      candle(0, { open: 101, high: 102, low: 99, close: 100 }),
      candle(1, { open: 100, high: 107, low: 100, close: 106 }),
      candle(2, { open: 102, high: 104, low: 98, close: 103 }),
      candle(3, { open: 102, high: 105, low: 101, close: 104 })
    ];

    expect(evaluateOrderBlockRetest({
      symbol: "BTCUSDT",
      candles,
      atrValues: [1, 2, 1, 1]
    })).toMatchObject({ side: "buy" });
    expect(evaluateOrderBlockRetest({
      symbol: "BTCUSDT",
      candles,
      atrValues: [1, 2, 1, 1],
      options: { invalidationMode: "wick" }
    })).toBeUndefined();
  });

  it("rejects target configurations below the minimum reward ratio", () => {
    const level: PriceLevel = {
      id: "swing-high",
      kind: "swing_high",
      price: 10,
      confirmedAt: 0
    };
    const setup = evaluateBreakAndRetest({
      symbol: "BTCUSDT",
      candles: [
        candle(0, { open: 9, high: 10, low: 8, close: 9 }),
        candle(1, { open: 9, high: 11, low: 9, close: 11 }),
        candle(2, { open: 11, high: 12, low: 10.5, close: 11.5 }),
        candle(3, { open: 10.1, high: 11, low: 9.9, close: 10.5 })
      ],
      levels: [level]
    });

    expect(() => activateSetupAtNextOpen(
      setup!,
      candle(4, { open: 10.5, high: 11, low: 10, close: 10.7 }),
      { target1R: 1, target2R: 1.5 }
    )).toThrow("TP2 must be at least 2R");
  });
});
