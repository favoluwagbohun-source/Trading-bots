import type { Candle, StrategyId } from "@crypto-signal/shared";
import type { MarketTimeframe } from "@crypto-signal/market-data";
import type { SeriesMarker, UTCTimestamp } from "lightweight-charts";
import type { ChartTradeOverlay } from "./chart-state.js";
import type {
  ActiveOrderBlockZone,
  FourHourTrendline,
  MarketAnalysisData,
  SwingLevel,
  TrendlineTouchpoint
} from "./market-api.js";

export type OverlayLens =
  | "auto"
  | StrategyId
  | "off";

export const OVERLAY_LENS_OPTIONS: readonly { readonly id: OverlayLens; readonly label: string }[] = [
  { id: "auto", label: "TA: Auto (TF)" },
  { id: "top_down_trendline", label: "TA: Top-Down 4H" },
  { id: "break_and_retest", label: "TA: Break & Retest" },
  { id: "liquidity_sweep_reversal", label: "TA: Liquidity Sweep" },
  { id: "order_block_retest", label: "TA: Order Blocks" },
  { id: "off", label: "TA: Off" }
];

export interface LegendBadgeItem {
  readonly label: string;
  readonly color: string;
}

export interface ResolvedTrendlineOverlay {
  readonly id: string;
  readonly role: "support" | "resistance" | "action" | "safety";
  readonly direction: "ascending" | "descending";
  readonly status: "valid" | "broken";
  readonly label: string;
  readonly color: string;
  readonly dashed: boolean;
  readonly lineWidth: 1 | 2;
  readonly anchorA: TrendlineTouchpoint;
  readonly anchorB: TrendlineTouchpoint;
  readonly touchpoints: readonly TrendlineTouchpoint[];
}

export interface ResolvedLevelOverlay {
  readonly id: string;
  readonly price: number;
  readonly label: string;
  readonly color: string;
  readonly dashed: boolean;
}

export interface ResolvedZoneOverlay {
  readonly id: string;
  readonly direction: "demand" | "supply";
  readonly label: string;
  readonly low: number;
  readonly high: number;
  readonly startTime: number;
}

export interface ResolvedTouchDot {
  readonly id: string;
  readonly openTime: number;
  readonly price: number;
  readonly color: string;
  readonly label: string;
}

export interface ChartOverlayBundle {
  readonly legend: string | null;
  readonly legendItems: readonly LegendBadgeItem[];
  readonly trendlines: readonly ResolvedTrendlineOverlay[];
  readonly levels: readonly ResolvedLevelOverlay[];
  readonly zones: readonly ResolvedZoneOverlay[];
  readonly touchDots: readonly ResolvedTouchDot[];
  readonly markers: readonly SeriesMarker<UTCTimestamp>[];
}

const TIMEFRAME_MS: Readonly<Record<MarketTimeframe, number>> = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
  "1M": 2_592_000_000
};

function formatTfBadge(tf: MarketTimeframe): string {
  switch (tf) {
    case "1d":
      return "1D";
    case "1w":
      return "1W";
    case "1M":
      return "1M";
    case "4h":
      return "4H";
    case "1h":
      return "1H";
    default:
      return tf;
  }
}

function interpolateAt(line: FourHourTrendline, timeMs: number): number {
  const duration = line.anchorB.openTime - line.anchorA.openTime;
  if (duration <= 0) return line.anchorB.price;
  return (
    line.anchorA.price +
    ((line.anchorB.price - line.anchorA.price) * (timeMs - line.anchorA.openTime)) / duration
  );
}

function isLineWithinCandleRange(
  line: FourHourTrendline,
  firstMs: number,
  lastMs: number,
  candleLow: number,
  candleHigh: number
): boolean {
  const clippedStart = Math.max(line.anchorA.openTime, firstMs);
  const clippedEnd = Math.max(line.anchorB.openTime, lastMs);
  if (clippedEnd <= clippedStart) return false;
  const startVal = interpolateAt(line, clippedStart);
  const endVal = interpolateAt(line, clippedEnd);
  if (endVal > candleHigh * 1.25 || endVal < candleLow * 0.75) return false;
  const minVal = Math.min(startVal, endVal);
  const maxVal = Math.max(startVal, endVal);
  return !(minVal > candleHigh * 1.18 || maxVal < candleLow * 0.82);
}

function snapTouchToVisibleCandle(
  touch: TrendlineTouchpoint,
  sourceTimeframe: MarketTimeframe,
  direction: "ascending" | "descending",
  candles: readonly Candle[],
  candleByTime: ReadonlyMap<number, Candle>
): { readonly candle: Candle; readonly price: number } | undefined {
  const exact = candleByTime.get(touch.openTime);
  if (exact) return { candle: exact, price: touch.price };

  const spanMs = TIMEFRAME_MS[sourceTimeframe] ?? 300_000;
  const windowEnd = touch.openTime + spanMs;
  let best: Candle | undefined;
  let bestExtreme = direction === "ascending" ? Infinity : -Infinity;
  for (const candle of candles) {
    if (candle.openTime < touch.openTime || candle.openTime >= windowEnd) continue;
    const extreme = direction === "ascending" ? Number(candle.low) : Number(candle.high);
    if (
      (direction === "ascending" && extreme < bestExtreme) ||
      (direction === "descending" && extreme > bestExtreme)
    ) {
      bestExtreme = extreme;
      best = candle;
    }
  }
  return best ? { candle: best, price: bestExtreme } : undefined;
}

function selectBestPair(
  lines: readonly FourHourTrendline[],
  firstMs: number,
  lastMs: number,
  candleLow: number,
  candleHigh: number
): FourHourTrendline[] {
  const inRange = lines.filter((line) =>
    isLineWithinCandleRange(line, firstMs, lastMs, candleLow, candleHigh)
  );
  const pickBest = (direction: "ascending" | "descending") =>
    inRange
      .filter((line) => line.direction === direction)
      .sort(
        (left, right) =>
          Number(right.status === "valid") - Number(left.status === "valid") ||
          Number(right.qualifyingTouchCount >= 3) - Number(left.qualifyingTouchCount >= 3) ||
          right.anchorB.openTime - left.anchorB.openTime
      )[0];

  const picked: FourHourTrendline[] = [];
  const asc = pickBest("ascending");
  const desc = pickBest("descending");
  if (asc) picked.push(asc);
  if (desc) picked.push(desc);
  return picked;
}

function toResolvedTrendline(
  line: FourHourTrendline,
  timeframe: MarketTimeframe,
  roleOverride?: "action" | "safety"
): ResolvedTrendlineOverlay {
  const role: ResolvedTrendlineOverlay["role"] =
    roleOverride ?? (line.direction === "ascending" ? "support" : "resistance");
  const tfLabel = formatTfBadge(line.timeframe ?? timeframe);
  const brokenTag = line.status === "broken" ? " (Broken)" : "";
  const touchBadge = `${line.qualifyingTouchCount}T`;
  const label =
    roleOverride === "action"
      ? `Action Line ${touchBadge}`
      : roleOverride === "safety"
        ? "Safety Line"
        : line.direction === "ascending"
          ? `${tfLabel} Support ▲ ${touchBadge}${brokenTag}`
          : `${tfLabel} Resistance ▼ ${touchBadge}${brokenTag}`;

  const color =
    roleOverride === "safety"
      ? "#f6465d"
      : roleOverride === "action"
        ? "#c084fc"
        : line.status === "valid"
          ? line.direction === "ascending"
            ? "#0ecb81"
            : "#f0b90b"
          : line.direction === "ascending"
            ? "rgba(14, 203, 129, 0.58)"
            : "rgba(240, 185, 11, 0.58)";

  const touchpoints =
    line.touchpoints && line.touchpoints.length > 0
      ? line.touchpoints
      : [line.anchorA, line.anchorB];

  return {
    id: `${role}:${line.id}`,
    role,
    direction: line.direction,
    status: line.status,
    label,
    color,
    dashed: line.status === "broken" || roleOverride === "safety",
    lineWidth: line.status === "valid" || roleOverride !== undefined ? 2 : 1,
    anchorA: line.anchorA,
    anchorB: line.anchorB,
    touchpoints
  };
}

function addLevelsWithPriceSpacing(
  target: ResolvedLevelOverlay[],
  candidates: readonly ResolvedLevelOverlay[],
  maxLevels: number,
  minSpacingPercent = 0.0045
): void {
  for (const item of candidates) {
    if (target.length >= maxLevels) break;
    const tooClose = target.some(
      (existing) => Math.abs(existing.price - item.price) / Math.max(1, item.price) < minSpacingPercent
    );
    if (!tooClose) target.push(item);
  }
}

function resolveTouchpointsAndMarkers(
  trendlines: readonly ResolvedTrendlineOverlay[],
  swings: readonly SwingLevel[],
  includeSwings: boolean,
  sourceTimeframe: MarketTimeframe,
  chartTimeframe: MarketTimeframe,
  candles: readonly Candle[]
): {
  readonly touchDots: ResolvedTouchDot[];
  readonly markers: SeriesMarker<UTCTimestamp>[];
} {
  if (candles.length === 0) return { touchDots: [], markers: [] };
  const candleByTime = new Map(candles.map((c) => [c.openTime, c]));
  const barStepMs =
    candles.length >= 2
      ? Math.max(60_000, candles[1]!.openTime - candles[0]!.openTime)
      : TIMEFRAME_MS[chartTimeframe] ?? 300_000;
  const minTouchMarkerGapMs = barStepMs * Math.max(3, Math.floor(candles.length / 45));
  const minDotGapMs = barStepMs * Math.max(2, Math.floor(candles.length / 80));
  const minSwingMarkerGapMs = barStepMs * Math.max(6, Math.floor(candles.length / 26));

  const markerList: {
    openTime: number;
    timeSec: number;
    position: "aboveBar" | "belowBar";
    priority: number;
    marker: SeriesMarker<UTCTimestamp>;
  }[] = [];
  const touchDots: ResolvedTouchDot[] = [];

  const hasNearbyMarker = (
    openTime: number,
    position: "aboveBar" | "belowBar",
    minGapMs: number,
    minPriority: number
  ) =>
    markerList.some(
      (entry) =>
        entry.position === position &&
        entry.priority >= minPriority &&
        Math.abs(entry.openTime - openTime) < minGapMs
    );

  for (const line of trendlines) {
    let lastDotTime = -Infinity;
    line.touchpoints.forEach((touch, idx) => {
      const snapped = snapTouchToVisibleCandle(
        touch,
        sourceTimeframe,
        line.direction,
        candles,
        candleByTime
      );
      if (!snapped) return;
      const touchNumber = idx + 1;
      const isUpTurn = line.direction === "ascending";
      const timeSec = Math.floor(snapped.candle.openTime / 1000);
      const position: "aboveBar" | "belowBar" = isUpTurn ? "belowBar" : "aboveBar";
      const color = line.role === "action"
        ? "#c084fc"
        : line.role === "safety"
          ? "#f6465d"
          : isUpTurn
            ? "#0ecb81"
            : "#f0b90b";

      if (snapped.candle.openTime - lastDotTime >= minDotGapMs) {
        touchDots.push({
          id: `${line.id}:t${touchNumber}:${snapped.candle.openTime}`,
          openTime: snapped.candle.openTime,
          price: snapped.price,
          color,
          label: `T${touchNumber}`
        });
        lastDotTime = snapped.candle.openTime;
      }

      if (!hasNearbyMarker(snapped.candle.openTime, position, minTouchMarkerGapMs, 2)) {
        markerList.push({
          openTime: snapped.candle.openTime,
          timeSec,
          position,
          priority: 2,
          marker: {
            time: timeSec as UTCTimestamp,
            position,
            shape: isUpTurn ? "arrowUp" : "arrowDown",
            color,
            text: `T${touchNumber}`,
            size: 1
          }
        });
      }
    });
  }

  if (includeSwings) {
    const recentHighs = swings.filter((s) => s.direction === "high").slice(-3).reverse();
    const recentLows = swings.filter((s) => s.direction === "low").slice(-3).reverse();
    const pickedSwings = [...recentHighs.slice(0, 2), ...recentLows.slice(0, 2)];

    for (const swing of pickedSwings) {
      const snapped = snapTouchToVisibleCandle(
        { openTime: swing.openTime, price: swing.price },
        swing.timeframe,
        swing.direction === "low" ? "ascending" : "descending",
        candles,
        candleByTime
      );
      if (!snapped) continue;
      const isUpTurn = swing.direction === "low";
      const timeSec = Math.floor(snapped.candle.openTime / 1000);
      const position: "aboveBar" | "belowBar" = isUpTurn ? "belowBar" : "aboveBar";
      if (hasNearbyMarker(snapped.candle.openTime, position, minSwingMarkerGapMs, 1)) {
        continue;
      }

      const tag = swing.structureTag ?? (swing.direction === "high" ? "SH" : "SL");
      markerList.push({
        openTime: snapped.candle.openTime,
        timeSec,
        position,
        priority: 1,
        marker: {
          time: timeSec as UTCTimestamp,
          position,
          shape: isUpTurn ? "arrowUp" : "arrowDown",
          color: isUpTurn ? "rgba(14, 203, 129, 0.85)" : "rgba(246, 70, 93, 0.85)",
          text: tag,
          size: 1
        }
      });
    }
  }

  const markers = markerList
    .sort((left, right) => left.timeSec - right.timeSec)
    .map((entry) => entry.marker);

  return { touchDots, markers };
}

export function selectChartAnalysisOverlay(input: {
  readonly lens?: OverlayLens;
  readonly enabledStrategies?: ReadonlySet<OverlayLens | "swings">;
  readonly chartTimeframe: MarketTimeframe;
  readonly candles: readonly Candle[];
  readonly analysis: MarketAnalysisData | null;
  readonly activeTradeOverlay: ChartTradeOverlay | null;
}): ChartOverlayBundle {
  const { lens, enabledStrategies, chartTimeframe, candles, analysis, activeTradeOverlay } = input;
  const activeSet = enabledStrategies ?? (
    lens === "off"
      ? new Set<OverlayLens | "swings">()
      : lens === "top_down_trendline"
        ? new Set<OverlayLens | "swings">(["top_down_trendline", "swings"])
        : lens === "break_and_retest"
          ? new Set<OverlayLens | "swings">(["break_and_retest", "swings"])
          : lens === "liquidity_sweep_reversal"
            ? new Set<OverlayLens | "swings">(["liquidity_sweep_reversal", "swings"])
            : lens === "order_block_retest"
              ? new Set<OverlayLens | "swings">(["order_block_retest"])
              : new Set<OverlayLens | "swings">(["top_down_trendline", "order_block_retest", "swings"])
  );

  if (activeSet.size === 0 || candles.length === 0) {
    return {
      legend: null,
      legendItems: [],
      trendlines: [],
      levels: [],
      zones: [],
      touchDots: [],
      markers: []
    };
  }

  const firstMs = candles[0]!.openTime;
  const lastMs = candles.at(-1)!.openTime;
  let candleLow = Infinity;
  let candleHigh = -Infinity;
  for (const c of candles) {
    const lo = Number(c.low);
    const hi = Number(c.high);
    if (lo < candleLow) candleLow = lo;
    if (hi > candleHigh) candleHigh = hi;
  }

  const analysisTf: MarketTimeframe = chartTimeframe === "1m" ? "5m" : chartTimeframe;
  const tfLines = analysis?.trendlinesByTimeframe?.[analysisTf] ??
    (analysisTf === "4h" ? analysis?.fourHourTrendlines ?? [] : []);
  const tfSwings = analysis?.swingsByTimeframe?.[analysisTf] ?? [];
  const fourHourLines = analysis?.trendlinesByTimeframe?.["4h"] ?? analysis?.fourHourTrendlines ?? [];
  const htfSwings = analysis?.swingLevels ?? [];
  const orderBlocks: readonly ActiveOrderBlockZone[] = analysis?.activeOrderBlocks ?? [];

  const resolvedLines: ResolvedTrendlineOverlay[] = [];
  const resolvedLevels: ResolvedLevelOverlay[] = [];
  const resolvedZones: ResolvedZoneOverlay[] = [];
  const legendItems: LegendBadgeItem[] = [];
  let markerSourceTf: MarketTimeframe = analysisTf;
  let markerSwings: readonly SwingLevel[] = tfSwings;
  const includeSwings = activeSet.has("swings");
  let legend: string | null = null;

  if (activeTradeOverlay?.annotations) {
    const { actionLine, safetyLine, levels, zones } = activeTradeOverlay.annotations;
    if (actionLine) {
      const matched = fourHourLines.find((item) => item.id === actionLine.id);
      resolvedLines.push(toResolvedTrendline(matched ?? actionLine, "4h", "action"));
    }
    if (safetyLine) {
      const matched = fourHourLines.find((item) => item.id === safetyLine.id);
      resolvedLines.push(toResolvedTrendline(matched ?? safetyLine, "4h", "safety"));
    }
    for (const lvl of levels) {
      resolvedLevels.push({
        id: `trade-lvl:${lvl.label}:${lvl.price}`,
        price: lvl.price,
        label: lvl.label,
        color: "#3d9bff",
        dashed: false
      });
    }
    for (const z of zones) {
      const dir = activeTradeOverlay.side === "long" ? "demand" : "supply";
      resolvedZones.push({
        id: `trade-zone:${z.label}:${z.low}`,
        direction: dir,
        label: z.label,
        low: z.low,
        high: z.high,
        startTime: candles[Math.max(0, candles.length - 40)]!.openTime
      });
    }
  }

  if (activeSet.has("top_down_trendline")) {
    markerSourceTf = "4h";
    markerSwings = analysis?.swingsByTimeframe?.["4h"] ?? htfSwings;
    const picked = selectBestPair(fourHourLines, firstMs, lastMs, candleLow, candleHigh);
    for (const line of picked) {
      if (!resolvedLines.some((existing) => existing.id.endsWith(line.id))) {
        resolvedLines.push(toResolvedTrendline(line, "4h"));
      }
    }
    for (const line of resolvedLines) {
      if (!legendItems.some((item) => item.label === line.label)) {
        legendItems.push({ label: line.label, color: line.color });
      }
    }
  }

  if (activeSet.has("break_and_retest")) {
    markerSourceTf = analysisTf;
    const candidateSwings: ResolvedLevelOverlay[] = [
      ...(analysis?.swingsByTimeframe?.["4h"] ?? []).slice(-2),
      ...(analysis?.swingsByTimeframe?.["1h"] ?? []).slice(-2),
      ...(analysis?.swingsByTimeframe?.["5m"] ?? []).slice(-2)
    ]
      .filter((swing) => swing.price >= candleLow * 0.9 && swing.price <= candleHigh * 1.1)
      .map((swing) => ({
        id: `br-lvl:${swing.id}`,
        price: swing.price,
        label: `${formatTfBadge(swing.timeframe)} ${swing.structureTag ?? (swing.direction === "high" ? "Resistance" : "Support")}`,
        color: swing.direction === "high" ? "rgba(246, 70, 93, 0.78)" : "rgba(14, 203, 129, 0.78)",
        dashed: true
      }));
    addLevelsWithPriceSpacing(resolvedLevels, candidateSwings, 3);
    if (!legendItems.some((item) => item.label.includes("Support"))) {
      legendItems.push(
        { label: "Break & Retest Support", color: "#0ecb81" },
        { label: "Break & Retest Resistance", color: "#f6465d" }
      );
    }
  }

  if (activeSet.has("liquidity_sweep_reversal")) {
    markerSourceTf = analysisTf;
    const pools: ResolvedLevelOverlay[] = [
      ...(analysis?.swingsByTimeframe?.["4h"] ?? []).slice(-2),
      ...(analysis?.swingsByTimeframe?.["1h"] ?? []).slice(-2),
      ...(analysis?.swingsByTimeframe?.["5m"] ?? []).slice(-2)
    ]
      .filter((swing) => swing.price >= candleLow * 0.9 && swing.price <= candleHigh * 1.1)
      .map((swing) => ({
        id: `ls-lvl:${swing.id}`,
        price: swing.price,
        label: `${formatTfBadge(swing.timeframe)} ${swing.direction === "high" ? "BSL High" : "SSL Low"}`,
        color: swing.direction === "high" ? "#f6465d" : "#0ecb81",
        dashed: true
      }));
    addLevelsWithPriceSpacing(resolvedLevels, pools, 3);
    if (!legendItems.some((item) => item.label.includes("BSL"))) {
      legendItems.push(
        { label: "BSL Buy-Side High", color: "#f6465d" },
        { label: "SSL Sell-Side Low", color: "#0ecb81" }
      );
    }
  }

  if (activeSet.has("order_block_retest")) {
    const visibleObs = orderBlocks
      .filter((ob) => ob.high >= candleLow * 0.86 && ob.low <= candleHigh * 1.14)
      .slice(0, 3);
    for (const ob of visibleObs) {
      const tfPrefix = ob.timeframe ? `${formatTfBadge(ob.timeframe)} ` : "";
      resolvedZones.push({
        id: `ob:${ob.timeframe ?? "5m"}:${ob.direction}:${ob.startTime}`,
        direction: ob.direction,
        label: `${tfPrefix}${ob.direction === "demand" ? "Demand OB ▲" : "Supply OB ▼"}`,
        low: ob.low,
        high: ob.high,
        startTime: ob.startTime
      });
    }
    if (!legendItems.some((item) => item.label.includes("Demand OB"))) {
      legendItems.push(
        { label: "Demand OB", color: "#0ecb81" },
        { label: "Supply OB", color: "#f6465d" }
      );
    }
  }

  const enabledNames = [...activeSet].filter((item) => item !== "swings").map((item) => {
    switch (item) {
      case "top_down_trendline":
        return "Top-Down";
      case "break_and_retest":
        return "Break & Retest";
      case "liquidity_sweep_reversal":
        return "Liquidity Sweep";
      case "order_block_retest":
        return "Order Blocks";
      default:
        return "Auto";
    }
  });

  legend = enabledNames.length > 0
    ? `${enabledNames.join(" + ")} Active`
    : "No Overlays Selected";

  const { touchDots, markers } = resolveTouchpointsAndMarkers(
    resolvedLines,
    markerSwings,
    includeSwings,
    markerSourceTf,
    chartTimeframe,
    candles
  );

  return {
    legend,
    legendItems,
    trendlines: resolvedLines,
    levels: resolvedLevels,
    zones: resolvedZones,
    touchDots,
    markers
  };
}
