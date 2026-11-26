import {
  atr,
  buildTrendlineLifecycles,
  classifyMarketStructure,
  classifyMarketRegime,
  findConfirmedSwings,
  type MarketStructure,
  type MarketRegimeResult,
  type SwingPoint,
  type Trendline,
  type TrendlineLifecycle
} from "@crypto-signal/indicators";
import {
  normalizeSymbol,
  type MarketTimeframe
} from "@crypto-signal/market-data";
import type { Candle, StrategyId } from "@crypto-signal/shared";
import {
  activateAtNextOpen,
  activateSetupAtNextOpen,
  evaluateBreakAndRetestState,
  evaluateLiquiditySweep,
  evaluateOrderBlockRetest,
  evaluateTopDownTrendline,
  TOP_DOWN_TIMEFRAMES,
  type EntryMode,
  type TopDownBias,
  type TopDownTimeframe
} from "@crypto-signal/strategies";

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
  readonly timeframe: MarketTimeframe;
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
  readonly relevantTimeframe: MarketTimeframe;
  readonly evidence: readonly string[];
  readonly entryCondition: string;
  readonly invalidationCondition: string;
  readonly stopMethodology: string;
  readonly targetMethodology: string;
  readonly reason: string;
  readonly signalId: string | null;
}

export interface TimeframeAnalysis {
  readonly timeframe: MarketTimeframe;
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
}

function assertCandle(candle: Candle, timeframe: MarketTimeframe, previous?: Candle): void {
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
  timeframe: MarketTimeframe,
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

function evaluateCandidates(snapshot: MarketAnalysisSnapshot): CandidateEvaluation {
  const timeframes = snapshot.timeframes;
  const execution = timeframes["5m"].candles;
  const nextCandle = snapshot.nextExecutionCandle;
  const candidates: SignalCandidate[] = [];
  const evaluations: StrategyEvaluation[] = [];
  if (!nextCandle || execution.length < 3) {
    for (const mode of TOP_DOWN_MODES) {
      evaluations.push(makeEvaluation({
        strategy: "top_down_trendline",
        variation: mode,
        status: "rejected",
        direction: null,
        relevantTimeframe: "5m",
        evidence: [],
        entryCondition: "Signal candle close followed by the immediate next 5-minute open.",
        invalidationCondition: "No next execution candle or insufficient closed execution history.",
        stopMethodology: "Opposing 4-hour Safety Line; unavailable.",
        targetMethodology: "Risk-multiple targets, minimum 2R at TP2.",
        reason: "A next execution candle and sufficient closed 5-minute history are required.",
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
        relevantTimeframe: "5m",
        evidence: [],
        entryCondition: "Setup-specific closed-candle confirmation followed by next 5-minute open.",
        invalidationCondition: "No next execution candle or insufficient closed execution history.",
        stopMethodology: "Strategy-specific stop; not evaluated.",
        targetMethodology: "Risk-multiple targets, minimum 2R at TP2.",
        reason: "A next execution candle and sufficient closed 5-minute history are required.",
        signalId: null
      }));
    }
    return { candidates, evaluations };
  }

  const levels = (["4h", "1h", "5m"] as const)
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
    levels
  });
  const setups = [
    {
      strategy: "break_and_retest" as const,
      timeframe: "5m" as const,
      setup: breakAndRetest.setup,
      state: breakAndRetest.state,
      rejectedReason: breakAndRetest.state === "awaiting_retest"
        ? "A confirmed breakout is awaiting a subsequent retest and directional rejection."
        : breakAndRetest.state === "invalidated"
          ? "The confirmed breakout level was invalidated before a valid retest entry."
          : "No confirmed break, subsequent retest, and directional rejection were all present."
    },
    {
      strategy: "liquidity_sweep_reversal" as const,
      timeframe: "5m" as const,
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
      timeframe: "5m" as const,
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
            ? [`Break/retest state: ${item.state}.`]
            : []),
          ...(item.strategy === "liquidity_sweep_reversal"
            ? [`4h context: ${timeframes["4h"].marketStructure.regime}.`]
            : [])
        ],
        entryCondition: "Setup-specific closed-candle confirmation followed by next 5-minute open.",
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
        entryCondition: "Entry at the immediate next 5-minute open.",
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
      higherTimeframeBias: "not applicable",
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
        ...(item.strategy === "liquidity_sweep_reversal"
          ? [`4h context: ${timeframes["4h"].marketStructure.regime}.`]
          : []),
        setup.reference.kind === "level"
          ? `Reference level: ${setup.reference.price}.`
          : `Reference zone: ${setup.reference.low} - ${setup.reference.high}.`
      ],
      entryCondition: `Enter at the immediate next 5-minute open (${plan.entryTime}).`,
      invalidationCondition: "Setup-specific level or zone invalidation before entry.",
      stopMethodology: "Strategy-specific signal-candle extreme with configured buffer (engineering assumption).",
      targetMethodology: `${plan.target1R}R partial and ${plan.target2R}R TP2; runner may trail.`,
      reason: "Strategy-specific closed-candle conditions and minimum reward/risk are confirmed; portfolio risk gate remains downstream.",
      signalId: candidate.signalId
    }));
  }
  return { candidates, evaluations };
}

export class MarketAnalysisOrchestrator {
  analyze(
    symbolInput: string,
    datasets: ReadonlyMap<MarketTimeframe, readonly Candle[]>
  ): MarketAnalysisResult | undefined {
    const symbol = normalizeSymbol(symbolInput);
    const inputExecution = datasets.get("5m") ?? [];
    for (let index = 0; index < inputExecution.length; index += 1) {
      assertCandle(inputExecution[index]!, "5m", inputExecution[index - 1]);
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
    const nextExecutionCandle = inputExecution.find((candle) =>
      candle.openTime === signalCandle.closeTime + 1 && !candle.closed
    );
    const snapshot: MarketAnalysisSnapshot = Object.freeze({
      snapshotId: `${symbol}:5m:${signalCandle.openTime}`,
      symbol,
      analysisTime,
      timeframes: immutableAnalyses,
      signalCandle: immutableAnalyses["5m"].candles.at(-1)!,
      nextExecutionCandle: nextExecutionCandle
        ? immutableCandle(nextExecutionCandle)
        : null
    });
    const evaluated = evaluateCandidates(snapshot);
    return Object.freeze({
      snapshot,
      candidates: Object.freeze(evaluated.candidates),
      evaluations: Object.freeze(evaluated.evaluations)
    });
  }
}
