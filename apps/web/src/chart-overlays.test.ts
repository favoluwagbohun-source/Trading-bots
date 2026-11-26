import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { selectChartAnalysisOverlay } from "./chart-overlays.js";
import type { MarketAnalysisData } from "./market-api.js";

function makeCandles(count: number, stepMs = 14_400_000): Candle[] {
  return Array.from({ length: count }, (_, idx) => {
    const openTime = 1_700_000_000_000 + idx * stepMs;
    const base = 60_000 + Math.sin(idx / 2) * 500;
    return {
      openTime,
      closeTime: openTime + stepMs - 1,
      open: String(base),
      high: String(base + 250),
      low: String(base - 250),
      close: String(base + 40),
      volume: "120",
      closed: true
    };
  });
}

function makeAnalysis(candles4h: readonly Candle[]): MarketAnalysisData {
  const t1 = candles4h[2]!;
  const t2 = candles4h[6]!;
  const t3 = candles4h[10]!;
  const h1 = candles4h[4]!;
  const h2 = candles4h[8]!;
  const h3 = candles4h[12]!;

  return {
    symbol: "BTCUSDT",
    snapshotId: "BTCUSDT:5m:1700000000000",
    analysisTime: candles4h.at(-1)!.closeTime,
    latestPrice: 60_100,
    signalCandle: candles4h.at(-1)!,
    timeframes: [],
    fourHourTrendlines: [
      {
        id: "4h-asc",
        timeframe: "4h",
        direction: "ascending",
        status: "valid",
        breakStatus: "unbroken",
        qualifyingTouchCount: 3,
        anchorA: { openTime: t1.openTime, price: Number(t1.low) },
        anchorB: { openTime: t2.openTime, price: Number(t2.low) },
        touchpoints: [
          { openTime: t1.openTime, price: Number(t1.low) },
          { openTime: t2.openTime, price: Number(t2.low) },
          { openTime: t3.openTime, price: Number(t3.low) }
        ],
        projectedPrice: 60_050
      },
      {
        id: "4h-desc",
        timeframe: "4h",
        direction: "descending",
        status: "valid",
        breakStatus: "unbroken",
        qualifyingTouchCount: 3,
        anchorA: { openTime: h1.openTime, price: Number(h1.high) },
        anchorB: { openTime: h2.openTime, price: Number(h2.high) },
        touchpoints: [
          { openTime: h1.openTime, price: Number(h1.high) },
          { openTime: h2.openTime, price: Number(h2.high) },
          { openTime: h3.openTime, price: Number(h3.high) }
        ],
        projectedPrice: 60_200
      }
    ],
    trendlinesByTimeframe: {
      "4h": [
        {
          id: "4h-asc",
          timeframe: "4h",
          direction: "ascending",
          status: "valid",
          breakStatus: "unbroken",
          qualifyingTouchCount: 3,
          anchorA: { openTime: t1.openTime, price: Number(t1.low) },
          anchorB: { openTime: t2.openTime, price: Number(t2.low) },
          touchpoints: [
            { openTime: t1.openTime, price: Number(t1.low) },
            { openTime: t2.openTime, price: Number(t2.low) },
            { openTime: t3.openTime, price: Number(t3.low) }
          ],
          projectedPrice: 60_050
        },
        {
          id: "4h-desc",
          timeframe: "4h",
          direction: "descending",
          status: "valid",
          breakStatus: "unbroken",
          qualifyingTouchCount: 3,
          anchorA: { openTime: h1.openTime, price: Number(h1.high) },
          anchorB: { openTime: h2.openTime, price: Number(h2.high) },
          touchpoints: [
            { openTime: h1.openTime, price: Number(h1.high) },
            { openTime: h2.openTime, price: Number(h2.high) },
            { openTime: h3.openTime, price: Number(h3.high) }
          ],
          projectedPrice: 60_200
        }
      ]
    },
    swingLevels: [
      {
        id: "4h:high:1",
        timeframe: "4h",
        direction: "high",
        structureTag: "LH",
        price: Number(h2.high),
        openTime: h2.openTime
      },
      {
        id: "4h:low:1",
        timeframe: "4h",
        direction: "low",
        structureTag: "HL",
        price: Number(t2.low),
        openTime: t2.openTime
      }
    ],
    swingsByTimeframe: {
      "4h": [
        {
          id: "4h:high:1",
          timeframe: "4h",
          direction: "high",
          structureTag: "LH",
          price: Number(h2.high),
          openTime: h2.openTime
        },
        {
          id: "4h:low:1",
          timeframe: "4h",
          direction: "low",
          structureTag: "HL",
          price: Number(t2.low),
          openTime: t2.openTime
        }
      ]
    },
    activeOrderBlocks: [
      {
        side: "buy",
        direction: "demand",
        low: 59_500,
        high: 59_800,
        startTime: t1.openTime,
        displacementTime: t2.openTime
      }
    ],
    evaluations: [],
    candidates: [],
    warnings: []
  };
}

describe("chart-overlays", () => {
  it("plots ascending support and descending resistance touchpoints in strictly ascending marker order", () => {
    const candles = makeCandles(20);
    const analysis = makeAnalysis(candles);
    const overlay = selectChartAnalysisOverlay({
      lens: "top_down_trendline",
      chartTimeframe: "4h",
      candles,
      analysis,
      activeTradeOverlay: null
    });

    expect(overlay.trendlines).toHaveLength(2);
    expect(overlay.trendlines.map((line) => line.role)).toEqual(["support", "resistance"]);
    expect(overlay.trendlines.find((line) => line.direction === "ascending")?.color).toBe("#0ecb81");
    expect(overlay.trendlines.find((line) => line.direction === "descending")?.color).toBe("#f6465d");
    expect(overlay.touchDots).toHaveLength(6);
    expect(overlay.markers.length).toBe(6);

    for (let i = 1; i < overlay.markers.length; i += 1) {
      expect(Number(overlay.markers[i]!.time)).toBeGreaterThanOrEqual(Number(overlay.markers[i - 1]!.time));
    }
    expect(overlay.markers.some((m) => m.shape === "arrowUp" && m.text === "T1")).toBe(true);
    expect(overlay.markers.some((m) => m.shape === "arrowDown" && m.text === "T3")).toBe(true);
  });

  it("switches cleanly between Order-Block zones, Liquidity Sweep levels, and Off", () => {
    const candles = makeCandles(20);
    const analysis = makeAnalysis(candles);

    const ob = selectChartAnalysisOverlay({
      lens: "order_block_retest",
      chartTimeframe: "5m",
      candles,
      analysis,
      activeTradeOverlay: null
    });
    expect(ob.zones).toHaveLength(1);
    expect(ob.zones[0]!.direction).toBe("demand");

    const liq = selectChartAnalysisOverlay({
      lens: "liquidity_sweep_reversal",
      chartTimeframe: "5m",
      candles,
      analysis,
      activeTradeOverlay: null
    });
    expect(liq.levels.some((lvl) => lvl.label.includes("BSL High"))).toBe(true);

    const off = selectChartAnalysisOverlay({
      lens: "off",
      chartTimeframe: "4h",
      candles,
      analysis,
      activeTradeOverlay: null
    });
    expect(off.trendlines).toEqual([]);
    expect(off.markers).toEqual([]);
    expect(off.legend).toBeNull();
    expect(off.legendItems).toEqual([]);
  });

  it("keeps default auto overlay focused on green/red rays, Supply/Demand zones, and S/R levels without swing-marker spam", () => {
    const candles = makeCandles(50, 14_400_000);
    const tA = candles[10]!;
    const tB = candles[20]!;
    const tC = candles[30]!;
    const analysis = makeAnalysis(candles);
    const denseAnalysis: MarketAnalysisData = {
      ...analysis,
      fourHourTrendlines: [
        {
          id: "4h-asc",
          timeframe: "4h",
          direction: "ascending",
          status: "valid",
          breakStatus: "unbroken",
          qualifyingTouchCount: 3,
          anchorA: { openTime: tA.openTime, price: Number(tA.low) },
          anchorB: { openTime: tB.openTime, price: Number(tB.low) },
          touchpoints: [
            { openTime: tA.openTime, price: Number(tA.low) },
            { openTime: tB.openTime, price: Number(tB.low) },
            { openTime: tC.openTime, price: Number(tC.low) }
          ],
          projectedPrice: Number(tB.low)
        }
      ]
    };

    const overlay = selectChartAnalysisOverlay({
      lens: "auto",
      chartTimeframe: "4h",
      candles,
      analysis: denseAnalysis,
      activeTradeOverlay: null
    });

    expect(overlay.legend).toBe("Pure PA · Break & Retest");
    expect(overlay.legendItems.some((item) => item.label.includes("Support"))).toBe(true);
    expect(overlay.levels.length).toBeLessThanOrEqual(2);
    expect(overlay.zones.length).toBeLessThanOrEqual(2);
    expect(overlay.markers.every((m) => m.text?.startsWith("T"))).toBe(true);
  });
});
