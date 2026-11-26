import {
  atr,
  buildTrendlineLifecycles,
  classifyMarketStructure,
  classifyMarketRegime,
  detectTrendlines,
  findConfirmedSwings,
  findTrendlineBreaks,
  trendlinePrice,
  type MarketStructure,
  type MarketRegimeResult,
  type SwingPoint,
  type Trendline,
  type TrendlineLifecycle
} from "@crypto-signal/indicators";
import type { Candle, StrategyId } from "@crypto-signal/shared";
import {
  activateSetupAtNextOpen
} from "./additional-types.js";
import {
  evaluateBreakAndRetestState,
  type BreakoutAnticipation
} from "./break-and-retest.js";
import { evaluateLiquiditySweep } from "./liquidity-sweep-reversal.js";
import {
  evaluateOrderBlockRetest,
  findActiveOrderBlocks,
  type ActiveOrderBlockZone
} from "./order-block-retest.js";
import {
  activateAtNextOpen,
  evaluateTopDownTrendline,
  TOP_DOWN_TIMEFRAMES,
  type EntryMode,
  type TopDownBias,
  type TopDownTimeframe
} from "./top-down-trendline.js";

import type { OrderBlockOptions } from "./order-block-retest.js";

export type { ActiveOrderBlockZone };

export function detectActiveOrderBlocks(
  candles: readonly Candle[],
  options?: Partial<OrderBlockOptions>
): readonly ActiveOrderBlockZone[] {
  if (candles.length < 3) return [];
  return findActiveOrderBlocks({
    candles,
    atrValues: atr(candles),
    ...(options === undefined ? {} : { options })
  });
}

export interface ChartTrendlineSummary {
  readonly id: string;
  readonly timeframe: AnalysisMarketTimeframe;
  readonly direction: "ascending" | "descending";
  readonly status: "valid" | "broken";
  readonly breakStatus: "unbroken" | "broken_above" | "broken_below";
  readonly qualifyingTouchCount: number;
  readonly anchorA: { readonly openTime: number; readonly price: number };
  readonly anchorB: { readonly openTime: number; readonly price: number };
  readonly touchpoints: readonly { readonly openTime: number; readonly price: number }[];
  readonly createdAt: number;
}

function passesBodyRespect(
  candles: readonly Candle[],
  line: Trendline
): boolean {
  const tolerance = 0.0025;
  for (let i = line.anchorA.candleIndex + 1; i < line.anchorB.candleIndex; i += 1) {
    const candle = candles[i];
    if (!candle?.closed) continue;
    const projected = trendlinePrice(line, i);
    const close = Number(candle.close);
    if (line.direction === "ascending" && close < projected * (1 - tolerance)) return false;
    if (line.direction === "descending" && close > projected * (1 + tolerance)) return false;
  }
  return true;
}

function collectSwingTouchpoints(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  line: Trendline,
  tolerancePercent: number
): readonly { readonly openTime: number; readonly price: number }[] {
  const matching = swings
    .filter((s) => s.direction === (line.direction === "ascending" ? "low" : "high"))
    .filter((s) => s.index >= line.anchorA.candleIndex)
    .sort((a, b) => a.index - b.index);

  const touches: { candleIndex: number; openTime: number; price: number }[] = [
    {
      candleIndex: line.anchorA.candleIndex,
      openTime: line.anchorA.openTime,
      price: line.anchorA.price
    },
    {
      candleIndex: line.anchorB.candleIndex,
      openTime: line.anchorB.openTime,
      price: line.anchorB.price
    }
  ];

  for (const swing of matching) {
    if (swing.index === line.anchorA.candleIndex || swing.index === line.anchorB.candleIndex) {
      continue;
    }
    const projected = trendlinePrice(line, swing.index);
    const tol = Math.abs(projected) * (tolerancePercent / 100);
    if (Math.abs(swing.price - projected) <= tol) {
      touches.push({
        candleIndex: swing.index,
        openTime: swing.openTime,
        price: swing.price
      });
    }
  }

  touches.sort((a, b) => a.candleIndex - b.candleIndex);
  const spaced: { candleIndex: number; openTime: number; price: number }[] = [];
  for (const item of touches) {
    const prev = spaced.at(-1);
    if (prev && item.candleIndex - prev.candleIndex < 5) continue;
    spaced.push(item);
    if (spaced.length >= 6) break;
  }

  // Ensure both anchors are represented if distinct enough
  if (spaced.length < 2 && candles[line.anchorB.candleIndex]) {
    return [
      { openTime: line.anchorA.openTime, price: line.anchorA.price },
      { openTime: line.anchorB.openTime, price: line.anchorB.price }
    ];
  }
  return spaced.map(({ openTime, price }) => ({ openTime, price }));
}

export function detectChartTrendlines(
  timeframe: AnalysisMarketTimeframe,
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  existingLifecycles: readonly TrendlineLifecycle[]
): readonly ChartTrendlineSummary[] {
  if (candles.length < 16) return [];
  const results: { summary: ChartTrendlineSummary; span: number }[] = [];
  const seenIds = new Set<string>();

  for (const lifecycle of existingLifecycles) {
    const span = lifecycle.pointB.candleIndex - lifecycle.pointA.candleIndex;
    if (span < 6 && !lifecycle.isValid) continue;
    const spacedTouches = lifecycle.touchpoints.filter((pt, idx, arr) => {
      if (idx === 0) return true;
      return pt.candleIndex - arr[idx - 1]!.candleIndex >= 4;
    });
    const summary: ChartTrendlineSummary = {
      id: lifecycle.id,
      timeframe,
      direction: lifecycle.direction,
      status: lifecycle.isValid ? "valid" : "broken",
      breakStatus: lifecycle.breakStatus,
      qualifyingTouchCount: Math.max(2, spacedTouches.length),
      anchorA: { openTime: lifecycle.pointA.openTime, price: lifecycle.pointA.price },
      anchorB: { openTime: lifecycle.pointB.openTime, price: lifecycle.pointB.price },
      touchpoints: spacedTouches.slice(0, 6).map((pt) => ({ openTime: pt.openTime, price: pt.price })),
      createdAt: lifecycle.createdAt
    };
    seenIds.add(summary.id);
    results.push({ summary, span });
  }

  const majorSwings = findConfirmedSwings(candles, { leftBars: 4, rightBars: 4 });
  const fallbackSwings = findConfirmedSwings(candles, { leftBars: 3, rightBars: 3 });
  const candidateSwings =
    majorSwings.length >= 6 ? majorSwings : fallbackSwings.length >= 4 ? fallbackSwings : swings;
  const twoTouch = detectTrendlines(candles, candidateSwings, {
    minimumTouches: 2,
    tolerancePercent: 0.6,
    maximumTrendlines: 18
  });

  for (const line of twoTouch) {
    const span = line.anchorB.candleIndex - line.anchorA.candleIndex;
    if (span < 10) continue;
    const id = `${timeframe}:${line.direction}:${line.anchorA.openTime}:${line.anchorB.openTime}`;
    if (seenIds.has(id)) continue;
    if (!passesBodyRespect(candles, line)) continue;

    const breaks = findTrendlineBreaks(candles, [line]);
    const firstBreak = breaks[0];
    const breakStatus: ChartTrendlineSummary["breakStatus"] = !firstBreak
      ? "unbroken"
      : firstBreak.direction === "break_above"
        ? "broken_above"
        : "broken_below";
    const status: ChartTrendlineSummary["status"] = firstBreak ? "broken" : "valid";
    const touchpoints = collectSwingTouchpoints(candles, candidateSwings, line, 0.75);
    seenIds.add(id);
    results.push({
      span,
      summary: {
        id,
        timeframe,
        direction: line.direction,
        status,
        breakStatus,
        qualifyingTouchCount: touchpoints.length,
        anchorA: { openTime: line.anchorA.openTime, price: line.anchorA.price },
        anchorB: { openTime: line.anchorB.openTime, price: line.anchorB.price },
        touchpoints,
        createdAt: line.confirmedAtTime
      }
    });
  }

  return results
    .sort(
      (left, right) =>
        Number(right.summary.status === "valid") - Number(left.summary.status === "valid") ||
        Number(right.span >= 12) - Number(left.span >= 12) ||
        right.summary.qualifyingTouchCount - left.summary.qualifyingTouchCount ||
        right.summary.anchorB.openTime - left.summary.anchorB.openTime
    )
    .slice(0, 8)
    .map((entry) => entry.summary);
}

export type AnalysisMarketTimeframe = "1M" | "1m" | "5m" | "1h" | "4h" | "1d" | "1w";

export const ANALYSIS_TIMEFRAMES = [
  "1M",
  "1w",
  "1d",
  "4h",
  "1h",
  "5m"
] as const;
type AnalysisTimeframe = (typeof ANALYSIS_TIMEFRAMES)[number];

const TIMEFRAME_MAP: Readonly<Record<TopDownTimeframe, AnalysisTimeframe>> = {
  "1M": "1M",
  "1W": "1w",
  "1D": "1d",
  "4H": "4h",
  "1H": "1h"
};
const TOP_DOWN_MODES: readonly EntryMode[] = ["break", "bounce", "retest"];

function normalizeAnalysisSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(normalized)) {
    throw new Error(`Invalid market symbol: ${symbol}`);
  }
  return normalized;
}

export interface ChartAnnotations {
  readonly actionLine?: AnalysisLine;
  readonly safetyLine?: AnalysisLine;
  readonly trendline?: {
    readonly id: string;
    readonly qualifyingTouchCount: number;
    readonly anchorA: { readonly openTime: number; readonly price: number };
    readonly anchorB: { readonly openTime: number; readonly price: number };
  };
  readonly levels: readonly { readonly label: string; readonly price: number }[];
  readonly zones: readonly {
    readonly label: string;
    readonly low: number;
    readonly high: number;
  }[];
}

export interface AnalysisLine {
  readonly id: string;
  readonly timeframe: AnalysisMarketTimeframe;
  readonly direction: "ascending" | "descending";
  readonly anchorA: { readonly openTime: number; readonly price: number };
  readonly anchorB: { readonly openTime: number; readonly price: number };
  readonly projectedPrice: number;
  readonly status: "valid" | "broken";
  readonly breakStatus: "unbroken" | "broken_above" | "broken_below";
  readonly source: "engineering_assumption";
}

export interface StrategyEvaluation {
  readonly strategy: StrategyId;
  readonly variation?: EntryMode;
  readonly status: "setup_confirmed" | "rejected";
  readonly direction: "buy" | "sell" | null;
  readonly relevantTimeframe: AnalysisMarketTimeframe;
  readonly evidence: readonly string[];
  readonly entryCondition: string;
  readonly invalidationCondition: string;
  readonly stopMethodology: string;
  readonly targetMethodology: string;
  readonly reason: string;
  readonly signalId: string | null;
}

export interface TimeframeAnalysis {
  readonly timeframe: AnalysisMarketTimeframe;
  readonly candles: readonly Candle[];
  readonly availableAt: number | null;
  readonly swings: readonly SwingPoint[];
  readonly marketStructure: MarketStructure;
  readonly trendlines: readonly Trendline[];
  readonly trendlineLifecycles: readonly TrendlineLifecycle[];
  readonly marketRegime: MarketRegimeResult;
}

export interface MarketAnalysisSnapshot {
  readonly snapshotId: string;
  readonly symbol: string;
  readonly executionTimeframe?: AnalysisMarketTimeframe;
  readonly analysisTime: number;
  readonly timeframes: Readonly<Record<AnalysisTimeframe, TimeframeAnalysis>>;
  readonly signalCandle: Candle;
  readonly nextExecutionCandle: Candle | null;
}

export interface SignalChart {
  readonly snapshotId: string;
  readonly symbol: string;
  readonly analysisSnapshot?: MarketAnalysisSnapshot;
  readonly strategy: StrategyId;
  readonly side: "buy" | "sell";
  readonly signalCandle: Candle;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly target1: number;
  readonly target2: number;
  readonly chartCandles: readonly Candle[];
  readonly chartAnnotations: ChartAnnotations;
}

export interface SignalCandidate extends SignalChart {
  readonly signalId: string;
  readonly analysisSnapshot: MarketAnalysisSnapshot;
  readonly entryCandleOpenTime: number;
  readonly target3: "trailing_runner";
  readonly minimumRiskReward: number;
  readonly higherTimeframeBias: string;
  readonly mode?: EntryMode;
}

export interface MarketAnalysisResult {
  readonly snapshot: MarketAnalysisSnapshot;
  readonly candidates: readonly SignalCandidate[];
  readonly evaluations: readonly StrategyEvaluation[];
  readonly breakoutAnticipation?: BreakoutAnticipation;
  readonly topDownBias?: string;
}

function assertCandle(
  candle: Candle,
  timeframe: AnalysisMarketTimeframe,
  previous?: Candle
): void {
  const prices = [candle.open, candle.high, candle.low, candle.close].map(Number);
  const [open, high, low, close] = prices;
  if (
    !Number.isSafeInteger(candle.openTime) ||
    !Number.isSafeInteger(candle.closeTime) ||
    candle.openTime < 0 ||
    candle.closeTime <= candle.openTime ||
    typeof candle.closed !== "boolean" ||
    prices.some((price) => !Number.isFinite(price) || price <= 0) ||
    !Number.isFinite(Number(candle.volume)) ||
    Number(candle.volume) < 0 ||
    high! < Math.max(open!, close!) ||
    low! > Math.min(open!, close!) ||
    high! < low!
  ) {
    throw new Error(`Invalid ${timeframe} market candle at ${candle.openTime}`);
  }
  if (previous && candle.openTime <= previous.openTime) {
    throw new Error(`${timeframe} candles must be in strictly ascending time order`);
  }
  if (previous && candle.openTime <= previous.closeTime) {
    throw new Error(`${timeframe} candles must not overlap`);
  }
}

function immutableCandle(candle: Candle): Candle {
  return Object.freeze({ ...candle });
}

function immutableSwing(swing: SwingPoint): SwingPoint {
  return Object.freeze({ ...swing });
}

function immutableTrendline(trendline: Trendline): Trendline {
  return Object.freeze({
    ...trendline,
    anchorA: Object.freeze({ ...trendline.anchorA }),
    anchorB: Object.freeze({ ...trendline.anchorB }),
    touchIndices: Object.freeze([...trendline.touchIndices])
  });
}

function trendlineFromLifecycle(
  lifecycle: TrendlineLifecycle,
  candles: readonly Candle[]
): Trendline {
  const confirmedAtIndex = candles.findIndex((candle) =>
    candle.closeTime === lifecycle.createdAt
  );
  const brokenAtIndex = lifecycle.brokenAt === null
    ? undefined
    : candles.findIndex((candle) => candle.closeTime === lifecycle.brokenAt);
  if (
    confirmedAtIndex < 0 ||
    (lifecycle.brokenAt !== null &&
      (brokenAtIndex === undefined || brokenAtIndex < 0))
  ) {
    throw new Error(`Trendline lifecycle ${lifecycle.id} references an unavailable candle`);
  }
  return immutableTrendline({
    id: lifecycle.id,
    direction: lifecycle.direction,
    anchorA: {
      candleIndex: lifecycle.pointA.candleIndex,
      openTime: lifecycle.pointA.openTime,
      price: lifecycle.pointA.price
    },
    anchorB: {
      candleIndex: lifecycle.pointB.candleIndex,
      openTime: lifecycle.pointB.openTime,
      price: lifecycle.pointB.price
    },
    slope: lifecycle.slope,
    touchIndices: lifecycle.touchpoints.map(({ candleIndex }) => candleIndex),
    qualifyingTouchCount: lifecycle.qualifyingTouchCount,
    confirmedAtIndex,
    confirmedAtTime: lifecycle.createdAt,
    brokenAtIndex
  });
}

function lineAtTime(
  anchorA: { readonly openTime: number; readonly price: number },
  anchorB: { readonly openTime: number; readonly price: number },
  time: number
): number {
  const duration = anchorB.openTime - anchorA.openTime;
  if (duration <= 0) throw new Error("Trendline anchors must have increasing timestamps");
  return anchorA.price + (anchorB.price - anchorA.price) * (time - anchorA.openTime) / duration;
}

function createTimeframeAnalysis(
  timeframe: AnalysisMarketTimeframe,
  input: readonly Candle[],
  analysisTime: number
): TimeframeAnalysis {
  for (let index = 0; index < input.length; index += 1) {
    assertCandle(input[index]!, timeframe, input[index - 1]);
  }
  const candles = Object.freeze(input
    .filter((candle) => candle.closed && candle.closeTime <= analysisTime)
    .map(immutableCandle));
  const swings = Object.freeze(findConfirmedSwings(candles, {
    leftBars: 2,
    rightBars: 2
  }).map(immutableSwing));
  const marketStructure = Object.freeze(
    classifyMarketStructure(candles, swings)
  );
  const regime = classifyMarketRegime(candles, swings);
  const marketRegime = Object.freeze({
    ...regime,
    structure: Object.freeze({
      ...regime.structure,
      latestHigh: regime.structure.latestHigh
        ? immutableSwing(regime.structure.latestHigh)
        : undefined,
      latestLow: regime.structure.latestLow
        ? immutableSwing(regime.structure.latestLow)
        : undefined
    })
  });
  const trendlineLifecycles = Object.freeze(timeframe === "4h"
    ? buildTrendlineLifecycles(candles, swings, {
        timeframe,
        minimumTouches: 3,
        asOfIndex: candles.length - 1
      })
    : []);
  const trendlines = Object.freeze(timeframe === "4h"
    ? trendlineLifecycles.map((lifecycle) =>
        trendlineFromLifecycle(lifecycle, candles)
      )
    : []);
  return Object.freeze({
    timeframe,
    candles,
    availableAt: candles.at(-1)?.closeTime ?? null,
    swings,
    marketStructure,
    trendlines,
    trendlineLifecycles,
    marketRegime
  });
}

function createBias(
  timeframes: Readonly<Record<AnalysisTimeframe, TimeframeAnalysis>>
): TopDownBias {
  const bias: TopDownBias = {};
  for (const timeframe of TOP_DOWN_TIMEFRAMES) {
    const analysis = timeframes[TIMEFRAME_MAP[timeframe]];
    if (analysis.availableAt === null) continue;
    bias[timeframe] = {
      regime: analysis.marketStructure.regime,
      availableAt: analysis.availableAt
    };
  }
  return bias;
}

function createCandidate(
  snapshot: MarketAnalysisSnapshot,
  args: Omit<SignalCandidate, "signalId" | "snapshotId" | "analysisSnapshot">
): SignalCandidate {
  const suffix = args.mode ? `:${args.mode}` : "";
  return Object.freeze({
    ...args,
    signalId: `${args.symbol}:${args.strategy}${suffix}:${args.signalCandle.openTime}`,
    snapshotId: snapshot.snapshotId,
    analysisSnapshot: snapshot
  });
}

interface CandidateEvaluation {
  readonly candidates: SignalCandidate[];
  readonly evaluations: StrategyEvaluation[];
  readonly breakoutAnticipation?: BreakoutAnticipation;
  readonly topDownBias?: string;
}

const DAILY_DOWN_SEQUENCE: readonly AnalysisTimeframe[] = ["1d", "4h", "1h", "5m"];

function resolveDailyToExecutionBias(
  timeframes: Readonly<Record<AnalysisTimeframe, TimeframeAnalysis>>,
  executionTimeframe: AnalysisMarketTimeframe
): {
  readonly dominant: "bullish" | "bearish" | "neutral";
  readonly summary: string;
} {
  const stopIndex = executionTimeframe === "1m"
    ? DAILY_DOWN_SEQUENCE.length - 1
    : DAILY_DOWN_SEQUENCE.indexOf(
        executionTimeframe === "1M" || executionTimeframe === "1w" ? "1d" : executionTimeframe
      );
  const path = DAILY_DOWN_SEQUENCE.slice(0, stopIndex >= 0 ? stopIndex + 1 : DAILY_DOWN_SEQUENCE.length);
  const available = path
    .map((tf) => ({ tf, entry: timeframes[tf] }))
    .filter(({ entry }) => entry.availableAt !== null && entry.candles.length >= 4);

  if (available.length === 0) {
    return { dominant: "neutral", summary: "not applicable" };
  }

  let score = 0;
  const parts: string[] = [];
  for (const { tf, entry } of available) {
    const regime = entry.marketStructure.regime;
    const weight = tf === "1d" ? 3 : tf === "4h" ? 2 : 1;
    if (regime === "bullish") score += weight;
    else if (regime === "bearish") score -= weight;
    parts.push(`${tf.toUpperCase()}:${regime}`);
  }

  const dailyRegime = timeframes["1d"].availableAt !== null && timeframes["1d"].candles.length >= 4
    ? timeframes["1d"].marketStructure.regime
    : undefined;
  const dominant: "bullish" | "bearish" | "neutral" =
    score >= 2 || (dailyRegime === "bullish" && score > 0)
      ? "bullish"
      : score <= -2 || (dailyRegime === "bearish" && score < 0)
        ? "bearish"
        : "neutral";

  return {
    dominant,
    summary: parts.join(", ")
  };
}

function makeEvaluation(
  evaluation: Omit<StrategyEvaluation, "evidence"> & { readonly evidence: readonly string[] }
): StrategyEvaluation {
  return Object.freeze({ ...evaluation, evidence: Object.freeze([...evaluation.evidence]) });
}

function makeAnalysisLine(
  line: Trendline,
  analysisTime: number,
  status: AnalysisLine["status"],
  breakStatus: AnalysisLine["breakStatus"]
): AnalysisLine {
  return Object.freeze({
    id: line.id,
    timeframe: "4h",
    direction: line.direction,
    anchorA: Object.freeze({ openTime: line.anchorA.openTime, price: line.anchorA.price }),
    anchorB: Object.freeze({ openTime: line.anchorB.openTime, price: line.anchorB.price }),
    projectedPrice: lineAtTime(
      { openTime: line.anchorA.openTime, price: line.anchorA.price },
      { openTime: line.anchorB.openTime, price: line.anchorB.price },
      analysisTime
    ),
    status,
    breakStatus,
    source: "engineering_assumption"
  });
}

function evaluateCandidates(
  snapshot: MarketAnalysisSnapshot,
  executionCandlesOverride?: readonly Candle[]
): CandidateEvaluation {
  const timeframes = snapshot.timeframes;
  const executionTf = snapshot.executionTimeframe ?? "5m";
  const execution = executionCandlesOverride ??
    (executionTf !== "5m" && executionTf !== "1m"
      ? timeframes[executionTf].candles
      : timeframes["5m"].candles);
  const nextCandle = snapshot.nextExecutionCandle;
  const candidates: SignalCandidate[] = [];
  const evaluations: StrategyEvaluation[] = [];
  const dailyToExecution = resolveDailyToExecutionBias(timeframes, executionTf);
  if (!nextCandle || execution.length < 3) {
    for (const mode of TOP_DOWN_MODES) {
      evaluations.push(makeEvaluation({
        strategy: "top_down_trendline",
        variation: mode,
        status: "rejected",
        direction: null,
        relevantTimeframe: executionTf,
        evidence: [],
        entryCondition: `Signal candle close followed by the immediate next ${executionTf} open.`,
        invalidationCondition: "No next execution candle or insufficient closed execution history.",
        stopMethodology: "Opposing 4-hour Safety Line; unavailable.",
        targetMethodology: "Risk-multiple targets, minimum 2R at TP2.",
        reason: `A next execution candle and sufficient closed ${executionTf} history are required.`,
        signalId: null
      }));
    }
    for (const strategy of [
      "break_and_retest",
      "liquidity_sweep_reversal",
      "order_block_retest"
    ] as const) {
      evaluations.push(makeEvaluation({
        strategy,
        status: "rejected",
        direction: null,
        relevantTimeframe: executionTf,
        evidence: [],
        entryCondition: `Setup-specific closed-candle confirmation followed by next ${executionTf} open.`,
        invalidationCondition: "No next execution candle or insufficient closed execution history.",
        stopMethodology: "Strategy-specific stop; not evaluated.",
        targetMethodology: "Risk-multiple targets, minimum 2R at TP2.",
        reason: `A next execution candle and sufficient closed ${executionTf} history are required.`,
        signalId: null
      }));
    }
    return {
      candidates,
      evaluations,
      topDownBias: dailyToExecution.summary
    };
  }

  const levels = (["1d", "4h", "1h", "5m"] as const)
    .flatMap((timeframe) => timeframes[timeframe].swings
      .filter((swing) =>
        swing.confirmedAt <= snapshot.analysisTime &&
        swing.openTime < snapshot.signalCandle.openTime
      )
      .map((swing) => ({
        id: `${timeframe}:${swing.direction}:${swing.openTime}`,
        kind: swing.direction === "high" ? "swing_high" as const : "swing_low" as const,
        price: swing.price,
        confirmedAt: swing.confirmedAt
      })));

  const higherTimeframeBias = createBias(timeframes);
  for (const mode of TOP_DOWN_MODES) {
    const signal = evaluateTopDownTrendline({
      symbol: snapshot.symbol,
      mode,
      executionCandles: execution,
      fourHourTrendlines: timeframes["4h"].trendlines,
      higherTimeframeBias
    });
    if (!signal) {
      evaluations.push(makeEvaluation({
        strategy: "top_down_trendline",
        variation: mode,
        status: "rejected",
        direction: null,
        relevantTimeframe: "4h",
        evidence: [
          `4h regime: ${timeframes["4h"].marketRegime.regime}`,
          `5m analysis close: ${snapshot.analysisTime}`
        ],
        entryCondition: `Confirmed ${mode} on 5-minute close with available aligned higher-timeframe context.`,
        invalidationCondition: "A confirmed close through the relevant trendline invalidates its setup.",
        stopMethodology: "Opposing valid 4-hour Safety Line; no fixed-stop fallback.",
        targetMethodology: "Risk-multiple targets, minimum 2R at TP2.",
        reason: "No qualifying higher-timeframe-aligned trendline setup was confirmed.",
        signalId: null
      }));
      continue;
    }
    const trendline = timeframes["4h"].trendlines.find(({ id }) =>
      id === signal.trendlineId
    );
    const actionLifecycle = timeframes["4h"].trendlineLifecycles.find((item) =>
      item.pointA.openTime === trendline?.anchorA.openTime &&
      item.pointB.openTime === trendline?.anchorB.openTime
    );
    const actionLine = trendline
      ? makeAnalysisLine(
          trendline,
          snapshot.analysisTime,
          actionLifecycle?.isValid === false ? "broken" : "valid",
          actionLifecycle?.breakStatus ?? "unbroken"
        )
      : undefined;
    const expectedBreakStatus = signal.side === "buy" ? "broken_above" : "broken_below";
    const actionLifecycleConfirmed = actionLifecycle !== undefined &&
      (mode === "break"
        ? actionLifecycle.breakStatus === expectedBreakStatus &&
          actionLifecycle.brokenAt !== null &&
          actionLifecycle.brokenAt <= snapshot.analysisTime
        : mode === "retest"
          ? actionLifecycle.breakStatus === expectedBreakStatus &&
            actionLifecycle.brokenAt !== null &&
            actionLifecycle.brokenAt <= snapshot.analysisTime
          : actionLifecycle.isValid && actionLifecycle.breakStatus === "unbroken");
    const safetyLine = timeframes["4h"].trendlines
      .filter((line) => line.direction !== trendline?.direction)
      .filter((line) => {
        const lifecycle = timeframes["4h"].trendlineLifecycles.find((item) =>
          item.pointA.openTime === line.anchorA.openTime &&
          item.pointB.openTime === line.anchorB.openTime
        );
        if (!lifecycle?.isValid || lifecycle.breakStatus !== "unbroken") return false;
        const projected = lineAtTime(
          { openTime: line.anchorA.openTime, price: line.anchorA.price },
          { openTime: line.anchorB.openTime, price: line.anchorB.price },
          snapshot.analysisTime
        );
        const signalClose = Number(signal.signalCandle.close);
        const nextOpen = Number(nextCandle.open);
        return signal.side === "buy"
          ? projected < signalClose && projected < nextOpen
          : projected > signalClose && projected > nextOpen;
      })
      .sort((left, right) => {
        const leftPrice = lineAtTime(
          { openTime: left.anchorA.openTime, price: left.anchorA.price },
          { openTime: left.anchorB.openTime, price: left.anchorB.price },
          snapshot.analysisTime
        );
        const rightPrice = lineAtTime(
          { openTime: right.anchorA.openTime, price: right.anchorA.price },
          { openTime: right.anchorB.openTime, price: right.anchorB.price },
          snapshot.analysisTime
        );
        return signal.side === "buy" ? rightPrice - leftPrice : leftPrice - rightPrice;
      })[0];
    if (!trendline || !actionLine || !actionLifecycleConfirmed || !safetyLine) {
      evaluations.push(makeEvaluation({
        strategy: "top_down_trendline",
        variation: mode,
        status: "rejected",
        direction: signal.side,
        relevantTimeframe: "4h",
        evidence: [`Action line: ${signal.trendlineId}`],
        entryCondition: `Confirmed ${mode} on 5-minute close.`,
        invalidationCondition: "A confirmed close through the action line invalidates the setup.",
        stopMethodology: "Opposing valid 4-hour Safety Line; no fixed-stop fallback.",
        targetMethodology: "Risk-multiple targets, minimum 2R at TP2.",
        reason: !safetyLine
          ? "Rejected: no valid opposing 4-hour Safety Line is available."
          : !actionLifecycleConfirmed
            ? `Rejected: 4-hour Action Line lifecycle does not confirm the requested ${mode} condition.`
            : "Rejected: action-line lifecycle evidence is incomplete.",
        signalId: null
      }));
      continue;
    }
    const safetyAnalysisLine = makeAnalysisLine(safetyLine, snapshot.analysisTime, "valid", "unbroken");
    const safetyBufferPercent = 0.1;
    const safetyStop = safetyAnalysisLine.projectedPrice *
      (signal.side === "buy"
        ? 1 - safetyBufferPercent / 100
        : 1 + safetyBufferPercent / 100);
    const safetySignal = { ...signal, stopLoss: safetyStop };
    let plan;
    try {
      plan = activateAtNextOpen(safetySignal, nextCandle);
    } catch (error) {
      evaluations.push(makeEvaluation({
        strategy: "top_down_trendline",
        variation: mode,
        status: "rejected",
        direction: signal.side,
        relevantTimeframe: "4h",
        evidence: [`Action line: ${actionLine.id}`, `Safety line: ${safetyAnalysisLine.id}`],
        entryCondition: `Confirmed ${mode} on 5-minute close.`,
        invalidationCondition: "A confirmed close through the Safety Line invalidates the setup.",
        stopMethodology: `0.1% buffer beyond the opposing 4-hour Safety Line (engineering assumption).`,
        targetMethodology: "Risk-multiple targets, minimum 2R at TP2.",
        reason: error instanceof Error ? error.message : String(error),
        signalId: null
      }));
      continue;
    }
    const candidate = createCandidate(snapshot, {
      symbol: snapshot.symbol,
      strategy: signal.strategy,
      side: signal.side,
      signalCandle: signal.signalCandle,
      entryCandleOpenTime: plan.entryTime,
      entryPrice: plan.entryPrice,
      stopLoss: plan.stopLoss,
      target1: plan.target1,
      target2: plan.target2,
      target3: plan.target3,
      minimumRiskReward: plan.minimumRiskReward,
      higherTimeframeBias: Object.entries(signal.higherTimeframeBias)
        .map(([timeframe, bias]) => `${timeframe}:${bias}`)
        .join(", "),
      chartCandles: execution,
      chartAnnotations: Object.freeze({
        actionLine,
        safetyLine: safetyAnalysisLine,
        trendline: Object.freeze({
          id: trendline.id,
          qualifyingTouchCount: trendline.qualifyingTouchCount,
          anchorA: Object.freeze({
            openTime: trendline.anchorA.openTime,
            price: trendline.anchorA.price
          }),
          anchorB: Object.freeze({
            openTime: trendline.anchorB.openTime,
            price: trendline.anchorB.price
          })
        }),
        levels: Object.freeze([]),
        zones: Object.freeze([])
      }),
      mode
    });
    candidates.push(candidate);
    evaluations.push(makeEvaluation({
      strategy: candidate.strategy,
      variation: mode,
      status: "setup_confirmed",
      direction: candidate.side,
      relevantTimeframe: "4h",
      evidence: [
        `Action line ${actionLine.id} (${actionLine.direction}), ${actionLine.status}.`,
        `Safety line ${safetyAnalysisLine.id} (${safetyAnalysisLine.direction}), valid.`,
        `5m close ${signal.signalCandle.close} at ${signal.signalCandle.closeTime}.`,
        ...Object.entries(signal.higherTimeframeBias)
          .map(([timeframe, bias]) => `${timeframe} ${bias}.`)
      ],
      entryCondition: `Enter at the immediate next 5-minute open (${plan.entryTime}).`,
      invalidationCondition: `Confirmed close through Safety Line ${safetyAnalysisLine.id}.`,
      stopMethodology: "0.1% buffer beyond the opposing 4-hour Safety Line (engineering assumption).",
      targetMethodology: `${plan.target1R}R partial and ${plan.target2R}R TP2; runner may trail.`,
      reason: "Trendline condition, higher-timeframe alignment, and opposing safety structure confirmed; portfolio risk gate remains downstream.",
      signalId: candidate.signalId
    }));
  }

  const breakAndRetest = evaluateBreakAndRetestState({
    symbol: snapshot.symbol,
    candles: execution,
    levels,
    higherTimeframeBias: dailyToExecution.dominant,
    executionTimeframe: executionTf
  });
  const setups = [
    {
      strategy: "break_and_retest" as const,
      timeframe: executionTf,
      setup: breakAndRetest.setup,
      state: breakAndRetest.state,
      rejectedReason: breakAndRetest.state === "awaiting_retest"
        ? "A confirmed breakout is awaiting a subsequent retest and directional rejection."
        : breakAndRetest.anticipation?.kind === "approaching_breakout"
          ? breakAndRetest.anticipation.note
          : breakAndRetest.state === "invalidated"
            ? "The confirmed breakout level was invalidated before a valid retest entry."
            : "No confirmed break, subsequent retest, and directional rejection were all present."
    },
    {
      strategy: "liquidity_sweep_reversal" as const,
      timeframe: executionTf,
      setup: evaluateLiquiditySweep({
        symbol: snapshot.symbol,
        candles: execution,
        levels,
        higherTimeframeBias: timeframes["4h"].marketStructure.regime
      }),
      rejectedReason: "No confirmed swing sweep, reclaim, and reversal candle were all present."
    },
    {
      strategy: "order_block_retest" as const,
      timeframe: executionTf,
      setup: evaluateOrderBlockRetest({
        symbol: snapshot.symbol,
        candles: execution,
        atrValues: atr(execution)
      }),
      rejectedReason: "No valid displacement-origin zone survived invalidation and retest confirmation."
    }
  ];
  for (const item of setups) {
    const setup = item.setup;
    if (!setup) {
      evaluations.push(makeEvaluation({
        strategy: item.strategy,
        status: "rejected",
        direction: null,
        relevantTimeframe: item.timeframe,
        evidence: [
          `Analysis timestamp: ${snapshot.analysisTime}.`,
          ...(item.strategy === "break_and_retest"
            ? [
                `Break/retest state: ${item.state}.`,
                `Top-down (${executionTf}): ${dailyToExecution.summary}.`
              ]
            : []),
          ...(item.strategy === "liquidity_sweep_reversal"
            ? [`4h context: ${timeframes["4h"].marketStructure.regime}.`]
            : [])
        ],
        entryCondition: `Setup-specific closed-candle confirmation followed by next ${executionTf} open.`,
        invalidationCondition: "See strategy-specific level/zone invalidation rules.",
        stopMethodology: "Strategy-specific signal structure with configured buffer.",
        targetMethodology: "Risk-multiple targets, minimum 2R at TP2.",
        reason: item.rejectedReason,
        signalId: null
      }));
      continue;
    }
    let plan;
    try {
      plan = activateSetupAtNextOpen(setup, nextCandle);
    } catch (error) {
      evaluations.push(makeEvaluation({
        strategy: item.strategy,
        status: "rejected",
        direction: setup.side,
        relevantTimeframe: item.timeframe,
        evidence: [`Signal candle close: ${setup.signalCandle.close}.`],
        entryCondition: `Entry at the immediate next ${executionTf} open.`,
        invalidationCondition: "Setup reference is invalidated before entry.",
        stopMethodology: "Strategy-specific signal structure with configured buffer.",
        targetMethodology: "Risk-multiple targets, minimum 2R at TP2.",
        reason: error instanceof Error ? error.message : String(error),
        signalId: null
      }));
      continue;
    }
    const chartAnnotations: ChartAnnotations = setup.reference.kind === "level"
      ? Object.freeze({
          levels: Object.freeze([Object.freeze({
            label: "Reference level",
            price: setup.reference.price
          })]),
          zones: Object.freeze([])
        })
      : Object.freeze({
          levels: Object.freeze([]),
          zones: Object.freeze([Object.freeze({
            label: "Supply/demand zone",
            low: setup.reference.low,
            high: setup.reference.high
          })])
        });
    const candidate = createCandidate(snapshot, {
      symbol: snapshot.symbol,
      strategy: setup.strategy,
      side: setup.side,
      signalCandle: setup.signalCandle,
      entryCandleOpenTime: plan.entryTime,
      entryPrice: plan.entryPrice,
      stopLoss: plan.stopLoss,
      target1: plan.target1,
      target2: plan.target2,
      target3: plan.target3,
      minimumRiskReward: plan.minimumRiskReward,
      higherTimeframeBias: item.strategy === "break_and_retest"
        ? dailyToExecution.summary
        : "not applicable",
      chartCandles: execution,
      chartAnnotations
    });
    candidates.push(candidate);
    evaluations.push(makeEvaluation({
      strategy: item.strategy,
      status: "setup_confirmed",
      direction: candidate.side,
      relevantTimeframe: item.timeframe,
      evidence: [
        `Confirmed ${item.strategy} setup on ${item.timeframe}.`,
        ...(item.strategy === "break_and_retest"
          ? [`Top-down (${executionTf}): ${dailyToExecution.summary}.`]
          : []),
        ...(item.strategy === "liquidity_sweep_reversal"
          ? [`4h context: ${timeframes["4h"].marketStructure.regime}.`]
          : []),
        setup.reference.kind === "level"
          ? `Reference level: ${setup.reference.price}.`
          : `Reference zone: ${setup.reference.low} - ${setup.reference.high}.`
      ],
      entryCondition: `Enter at the immediate next ${executionTf} open (${plan.entryTime}).`,
      invalidationCondition: "Setup-specific level or zone invalidation before entry.",
      stopMethodology: "Strategy-specific signal-candle extreme with configured buffer (engineering assumption).",
      targetMethodology: `${plan.target1R}R partial and ${plan.target2R}R TP2; runner may trail.`,
      reason: "Strategy-specific closed-candle conditions and minimum reward/risk are confirmed; portfolio risk gate remains downstream.",
      signalId: candidate.signalId
    }));
  }
  return {
    candidates,
    evaluations,
    ...(breakAndRetest.anticipation ? { breakoutAnticipation: breakAndRetest.anticipation } : {}),
    topDownBias: dailyToExecution.summary
  };
}

export class MarketAnalysisOrchestrator {
  analyze(
    symbolInput: string,
    datasets: ReadonlyMap<AnalysisMarketTimeframe, readonly Candle[]>,
    options?: { readonly executionTimeframe?: AnalysisMarketTimeframe }
  ): MarketAnalysisResult | undefined {
    const symbol = normalizeAnalysisSymbol(symbolInput);
    const executionTf: AnalysisMarketTimeframe = options?.executionTimeframe ?? "5m";
    const inputExecution = datasets.get(executionTf) ?? datasets.get("5m") ?? [];
    for (let index = 0; index < inputExecution.length; index += 1) {
      assertCandle(inputExecution[index]!, executionTf, inputExecution[index - 1]);
    }
    const signalCandle = [...inputExecution]
      .reverse()
      .find((candle) => candle.closed);
    if (!signalCandle) return undefined;
    const analysisTime = signalCandle.closeTime;

    const analyses = {} as Record<AnalysisTimeframe, TimeframeAnalysis>;
    for (const timeframe of ANALYSIS_TIMEFRAMES) {
      analyses[timeframe] = createTimeframeAnalysis(
        timeframe,
        datasets.get(timeframe) ?? [],
        analysisTime
      );
    }
    const immutableAnalyses = Object.freeze(analyses);
    const closedCustomExecution = executionTf === "1m"
      ? Object.freeze(
          inputExecution
            .filter((candle) => candle.closed && candle.closeTime <= analysisTime)
            .map(immutableCandle)
        )
      : undefined;
    const nextExecutionCandle = inputExecution.find((candle) =>
      candle.openTime === signalCandle.closeTime + 1 && !candle.closed
    );
    const snapshotSignalCandle = executionTf === "1m"
      ? (closedCustomExecution?.at(-1) ?? immutableCandle(signalCandle))
      : immutableAnalyses[executionTf].candles.at(-1)!;
    const snapshot: MarketAnalysisSnapshot = Object.freeze({
      snapshotId: `${symbol}:${executionTf}:${signalCandle.openTime}`,
      symbol,
      ...(executionTf === "5m" ? {} : { executionTimeframe: executionTf }),
      analysisTime,
      timeframes: immutableAnalyses,
      signalCandle: snapshotSignalCandle,
      nextExecutionCandle: nextExecutionCandle
        ? immutableCandle(nextExecutionCandle)
        : null
    });
    const evaluated = evaluateCandidates(snapshot, closedCustomExecution);
    return Object.freeze({
      snapshot,
      candidates: Object.freeze(evaluated.candidates),
      evaluations: Object.freeze(evaluated.evaluations),
      ...(evaluated.breakoutAnticipation
        ? { breakoutAnticipation: evaluated.breakoutAnticipation }
        : {}),
      ...(evaluated.topDownBias ? { topDownBias: evaluated.topDownBias } : {})
    });
  }
}
