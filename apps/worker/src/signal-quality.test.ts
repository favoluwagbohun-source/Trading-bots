import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import type { SignalCandidate } from "./signal-scanner.js";
import { scoreSignalQuality } from "./signal-quality.js";

function candidate(): SignalCandidate {
  const candles: Candle[] = Array.from({ length: 24 }, (_, index) => {
    const openTime = 1_800_000 + index * 300_000;
    const final = index === 23;
    return {
      openTime,
      closeTime: openTime + 299_999,
      open: String(final ? 122 : 100 + index),
      high: String(final ? 124.1 : 102 + index),
      low: String(final ? 121.9 : 99 + index),
      close: String(final ? 124 : 101 + index),
      volume: String(final ? 20 : 10),
      closed: true
    };
  });
  const signalCandle = candles.at(-1)!;
  return {
    signalId: "BTCUSDT:top_down_trendline:bounce:8700000",
    snapshotId: `BTCUSDT:5m:${signalCandle.openTime}`,
    symbol: "BTCUSDT",
    strategy: "top_down_trendline",
    side: "buy",
    signalCandle,
    entryCandleOpenTime: signalCandle.closeTime + 1,
    entryPrice: 124,
    stopLoss: 120,
    target1: 130,
    target2: 136,
    target3: "trailing_runner",
    minimumRiskReward: 3,
    higherTimeframeBias: "1M:bullish, 1W:bullish, 1D:bullish, 4H:bullish, 1H:bullish",
    chartCandles: candles,
    chartAnnotations: {
      trendline: {
        id: "ascending-1-2",
        qualifyingTouchCount: 4,
        anchorA: { openTime: 1_800_000, price: 99 },
        anchorB: { openTime: 2_100_000, price: 100 }
      },
      levels: [],
      zones: []
    }
  };
}

describe("scoreSignalQuality", () => {
  it("returns a transparent factor breakdown without treating score as win probability", () => {
    const result = scoreSignalQuality(candidate());

    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.factors.map(({ id }) => id)).toEqual([
      "higher_timeframe_alignment",
      "trendline_validity",
      "entry_confirmation",
      "volume",
      "candle_quality",
      "market_regime",
      "risk_reward"
    ]);
    expect(result.factors.find(({ id }) => id === "higher_timeframe_alignment"))
      .toMatchObject({ points: 20, maximumPoints: 20 });
    expect(result.factors.find(({ id }) => id === "trendline_validity"))
      .toMatchObject({ points: 15, maximumPoints: 15 });
    expect(result.factors.find(({ id }) => id === "volume"))
      .toMatchObject({ points: 10, maximumPoints: 10 });
    expect(result.evidenceAvailable).toBe(false);
    expect(result.publishEligible).toBe(false);
    expect(["C", "D"]).toContain(result.strategyGrade);
  });

  it("requires strategy evidence before granting a B-or-better publish grade", () => {
    const current = candidate();
    const unvalidated = scoreSignalQuality(current);
    const validated = scoreSignalQuality(current, {
      maximumSupportedGrade: "B",
      source: "test-fixture:strategy-validation-evidence"
    });

    expect(unvalidated.publishEligible).toBe(false);
    expect(validated.evidenceSource).toBe("test-fixture:strategy-validation-evidence");
    expect(validated.strategyGrade).toBe("B");
    expect(validated.publishEligible).toBe(true);
  });

  it("scores realistic 3R liquidity sweep pinbar setups as Grade B+ when evidence is provided", () => {
    const base = candidate();
    const sweepCandles: Candle[] = base.chartCandles.map((candle, index) => {
      if (index !== base.chartCandles.length - 1) return candle;
      return {
        ...candle,
        open: "123.4",
        high: "124.0",
        low: "121.0",
        close: "123.9",
        volume: "10"
      };
    });
    const signalCandle = sweepCandles.at(-1)!;
    const sweepCandidate: SignalCandidate = {
      ...base,
      signalId: "BTCUSDT:liquidity_sweep_reversal:1800000",
      strategy: "liquidity_sweep_reversal",
      higherTimeframeBias: "not applicable",
      signalCandle,
      entryPrice: 124,
      stopLoss: 121,
      target1: 128.5,
      target2: 133,
      chartCandles: sweepCandles,
      chartAnnotations: {
        levels: [{ label: "Reference level", price: 121.5 }],
        zones: []
      }
    };

    const validated = scoreSignalQuality(sweepCandidate, {
      maximumSupportedGrade: "A",
      source: "deterministic-engine-v1"
    });

    expect(validated.score).toBeGreaterThanOrEqual(80);
    expect(["A", "B"]).toContain(validated.strategyGrade);
    expect(validated.publishEligible).toBe(true);
  });

  it("rejects a score when the chart snapshot or signal candle is not closed", () => {
    const current = candidate();
    expect(() => scoreSignalQuality({
      ...current,
      signalCandle: { ...current.signalCandle, closed: false }
    })).toThrow("matching closed-candle snapshot");
  });
});
