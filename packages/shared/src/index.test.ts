import { describe, expect, it } from "vitest";
import type { Candle, StrategyId } from "./index.js";

describe("shared types", () => {
  it("models a closed candle", () => {
    const candle: Candle = {
      openTime: 1,
      closeTime: 2,
      open: "100",
      high: "101",
      low: "99",
      close: "100.5",
      volume: "10",
      closed: true
    };

    expect(candle.closed).toBe(true);
  });

  it("limits strategy identifiers to the four specified strategies", () => {
    const strategies: StrategyId[] = [
      "top_down_trendline",
      "break_and_retest",
      "liquidity_sweep_reversal",
      "order_block_retest"
    ];

    expect(strategies).toHaveLength(4);
  });
});
