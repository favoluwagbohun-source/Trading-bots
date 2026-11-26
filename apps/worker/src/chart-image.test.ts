import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import type { SignalCandidate } from "./signal-scanner.js";
import { renderSignalChart } from "./chart-image.js";

function sampleCandidate(): SignalCandidate {
  const candles: Candle[] = Array.from({ length: 8 }, (_, index) => {
    const openTime = 1_800_000 + index * 300_000;
    return {
      openTime,
      closeTime: openTime + 299_999,
      open: String(100 + index),
      high: String(102 + index),
      low: String(99 + index),
      close: String(101 + index),
      volume: "10",
      closed: true
    };
  });
  const signalCandle = candles.at(-1)!;
  return {
    signalId: "BTCUSDT:break_and_retest:3900000",
    snapshotId: "BTCUSDT:5m:3900000",
    symbol: "BTCUSDT",
    strategy: "break_and_retest",
    side: "buy",
    signalCandle,
    entryCandleOpenTime: signalCandle.closeTime + 1,
    entryPrice: 108,
    stopLoss: 104,
    target1: 114,
    target2: 120,
    target3: "trailing_runner",
    minimumRiskReward: 3,
    higherTimeframeBias: "not applicable",
    chartCandles: candles,
    chartAnnotations: {
      levels: [{ label: "Reference level", price: 106 }],
      zones: [{ label: "Supply/demand zone", low: 102, high: 104 }]
    }
  };
}

describe("renderSignalChart", () => {
  it("renders a PNG from the candidate's actual closed candles and matching snapshot", async () => {
    const rendered = renderSignalChart(sampleCandidate());
    const bytes = new Uint8Array(await rendered.image.arrayBuffer());

    expect(rendered.snapshotId).toBe("BTCUSDT:5m:3900000");
    expect(rendered.image.type).toBe("image/png");
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(rendered.image.size).toBeGreaterThan(1_000);
    expect(rendered.image.size).toBeLessThan(10 * 1024 * 1024);
  });

  it("rejects chart data that includes an unfinished candle", () => {
    const candidate = sampleCandidate();
    const chartCandles = candidate.chartCandles.map((candle, index) =>
      index === candidate.chartCandles.length - 1 ? { ...candle, closed: false } : candle
    );
    expect(() => renderSignalChart({ ...candidate, chartCandles }))
      .toThrow("cannot include unfinished candles");
  });

  it("rejects a chart snapshot whose last candle differs from the signal candle", () => {
    const candidate = sampleCandidate();
    expect(() => renderSignalChart({
      ...candidate,
      signalCandle: { ...candidate.signalCandle, openTime: candidate.signalCandle.openTime + 1 }
    })).toThrow("same market snapshot");
  });
});
