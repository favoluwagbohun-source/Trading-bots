import {
  atr,
  classifyMarketStructure,
  detectTrendlines,
  findConfirmedSwings,
  type MarketStructure,
  type SwingPoint,
  type Trendline
} from "@crypto-signal/indicators";
import {
  normalizeSymbol,
  type MarketTimeframe
} from "@crypto-signal/market-data";
import type { Candle, StrategyId } from "@crypto-signal/shared";
import {
  activateAtNextOpen,
  activateSetupAtNextOpen,
  evaluateBreakAndRetest,
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

export interface TimeframeAnalysis {
  readonly timeframe: MarketTimeframe;
  readonly candles: readonly Candle[];
  readonly availableAt: number | null;
  readonly swings: readonly SwingPoint[];
  readonly marketStructure: MarketStructure;
  readonly trendlines: readonly Trendline[];
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
  const trendlines = timeframe === "4h"
    ? Object.freeze(detectTrendlines(candles, swings).map(immutableTrendline))
    : Object.freeze([] as Trendline[]);
  return Object.freeze({
    timeframe,
    candles,
    availableAt: candles.at(-1)?.closeTime ?? null,
    swings,
    marketStructure,
    trendlines
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

function evaluateCandidates(snapshot: MarketAnalysisSnapshot): SignalCandidate[] {
  const timeframes = snapshot.timeframes;
  const execution = timeframes["5m"].candles;
  const nextCandle = snapshot.nextExecutionCandle;
  if (!nextCandle || execution.length < 3) return [];

  const candidates: SignalCandidate[] = [];
  const executionSwings = timeframes["5m"].swings;
  const levels = executionSwings
    .filter((swing) => swing.confirmedAt <= snapshot.analysisTime)
    .map((swing) => ({
      id: `${swing.direction}:${swing.openTime}`,
      kind: swing.direction === "high" ? "swing_high" as const : "swing_low" as const,
      price: swing.price,
      confirmedAt: swing.confirmedAt
    }));

  const higherTimeframeBias = createBias(timeframes);
  for (const mode of TOP_DOWN_MODES) {
    const signal = evaluateTopDownTrendline({
      symbol: snapshot.symbol,
      mode,
      executionCandles: execution,
      fourHourTrendlines: timeframes["4h"].trendlines,
      higherTimeframeBias
    });
    if (!signal) continue;
    const plan = activateAtNextOpen(signal, nextCandle);
    const trendline = timeframes["4h"].trendlines.find(({ id }) =>
      id === signal.trendlineId
    );
    candidates.push(createCandidate(snapshot, {
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
        ...(trendline === undefined ? {} : {
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
          })
        }),
        levels: Object.freeze([]),
        zones: Object.freeze([])
      }),
      mode
    }));
  }

  const setups = [
    evaluateBreakAndRetest({ symbol: snapshot.symbol, candles: execution, levels }),
    evaluateLiquiditySweep({ symbol: snapshot.symbol, candles: execution, levels }),
    evaluateOrderBlockRetest({
      symbol: snapshot.symbol,
      candles: execution,
      atrValues: atr(execution)
    })
  ];
  for (const setup of setups) {
    if (!setup) continue;
    const plan = activateSetupAtNextOpen(setup, nextCandle);
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
    candidates.push(createCandidate(snapshot, {
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
    }));
  }
  return candidates;
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
    return Object.freeze({
      snapshot,
      candidates: Object.freeze(evaluateCandidates(snapshot))
    });
  }
}
