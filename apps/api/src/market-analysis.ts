import type { BinanceRestClient, MarketTimeframe } from "@crypto-signal/market-data";
import type { Candle, StrategyId } from "@crypto-signal/shared";
import {
  ANALYSIS_TIMEFRAMES,
  MarketAnalysisOrchestrator,
  detectActiveOrderBlocks,
  detectChartTrendlines,
  type ActiveOrderBlockZone,
  type AnalysisMarketTimeframe,
  type BreakoutAnticipation,
  type ChartAnnotations,
  type StrategyEvaluation,
  type TimeframeAnalysis
} from "@crypto-signal/strategies";

export interface TimeframeSummaryView {
  readonly timeframe: MarketTimeframe;
  readonly availableAt: number | null;
  readonly regime: "bullish" | "bearish" | "neutral";
  readonly volatilityRegime: "low" | "normal" | "high";
  readonly trendStrength: number;
  readonly latestHigh: number | null;
  readonly latestLow: number | null;
  readonly candleCount: number;
}

export interface TrendlineTouchpointView {
  readonly openTime: number;
  readonly price: number;
}

export interface FourHourTrendlineView {
  readonly id: string;
  readonly timeframe: MarketTimeframe;
  readonly direction: "ascending" | "descending";
  readonly status: "valid" | "broken";
  readonly breakStatus: "unbroken" | "broken_above" | "broken_below";
  readonly qualifyingTouchCount: number;
  readonly anchorA: TrendlineTouchpointView;
  readonly anchorB: TrendlineTouchpointView;
  readonly touchpoints: readonly TrendlineTouchpointView[];
  readonly projectedPrice: number;
}

export type SwingStructureTag = "HH" | "LH" | "HL" | "LL" | "SH" | "SL";

export interface SwingLevelView {
  readonly id: string;
  readonly timeframe: MarketTimeframe;
  readonly direction: "high" | "low";
  readonly structureTag: SwingStructureTag;
  readonly price: number;
  readonly openTime: number;
}

export interface SignalCandidateView {
  readonly signalId: string;
  readonly strategy: StrategyId;
  readonly mode?: "break" | "bounce" | "retest";
  readonly side: "buy" | "sell";
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly target1: number;
  readonly target2: number;
  readonly target3: "trailing_runner";
  readonly minimumRiskReward: number;
  readonly higherTimeframeBias: string;
  readonly entryCandleOpenTime: number;
  readonly chartAnnotations: ChartAnnotations;
}

export interface MarketAnalysisView {
  readonly symbol: string;
  readonly executionTimeframe: MarketTimeframe;
  readonly snapshotId: string;
  readonly analysisTime: number;
  readonly latestPrice: number;
  readonly signalCandle: Candle;
  readonly topDownBias?: string;
  readonly breakoutAnticipation?: BreakoutAnticipation;
  readonly timeframes: readonly TimeframeSummaryView[];
  readonly fourHourTrendlines: readonly FourHourTrendlineView[];
  readonly trendlinesByTimeframe: Readonly<Partial<Record<MarketTimeframe, readonly FourHourTrendlineView[]>>>;
  readonly swingLevels: readonly SwingLevelView[];
  readonly swingsByTimeframe: Readonly<Partial<Record<MarketTimeframe, readonly SwingLevelView[]>>>;
  readonly activeOrderBlocks: readonly (ActiveOrderBlockZone & { readonly timeframe?: MarketTimeframe })[];
  readonly evaluations: readonly StrategyEvaluation[];
  readonly candidates: readonly SignalCandidateView[];
  readonly warnings: readonly string[];
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly value: MarketAnalysisView;
}

function projectPrice(
  anchorA: { readonly openTime: number; readonly price: number },
  anchorB: { readonly openTime: number; readonly price: number },
  atTime: number
): number {
  const duration = anchorB.openTime - anchorA.openTime;
  if (duration <= 0) return anchorB.price;
  return anchorA.price + ((anchorB.price - anchorA.price) / duration) * (atTime - anchorA.openTime);
}

function mapTimeframeTrendlines(
  timeframe: MarketTimeframe,
  entry: TimeframeAnalysis,
  analysisTime: number
): readonly FourHourTrendlineView[] {
  const visual = detectChartTrendlines(
    timeframe as AnalysisMarketTimeframe,
    entry.candles,
    entry.swings,
    entry.trendlineLifecycles
  );
  return visual.slice(0, 6).map((item) => ({
    id: item.id,
    timeframe,
    direction: item.direction,
    status: item.status,
    breakStatus: item.breakStatus,
    qualifyingTouchCount: item.qualifyingTouchCount,
    anchorA: item.anchorA,
    anchorB: item.anchorB,
    touchpoints: item.touchpoints,
    projectedPrice: projectPrice(item.anchorA, item.anchorB, analysisTime)
  }));
}

function mapTimeframeSwings(
  timeframe: MarketTimeframe,
  entry: TimeframeAnalysis,
  limit: number
): readonly SwingLevelView[] {
  const sorted = entry.swings
    .slice()
    .sort((left, right) => left.openTime - right.openTime);
  let previousHigh: number | undefined;
  let previousLow: number | undefined;
  const tagged: SwingLevelView[] = sorted.map((swing) => {
    let structureTag: SwingStructureTag;
    if (swing.direction === "high") {
      structureTag = previousHigh === undefined
        ? "SH"
        : swing.price > previousHigh
          ? "HH"
          : "LH";
      previousHigh = swing.price;
    } else {
      structureTag = previousLow === undefined
        ? "SL"
        : swing.price > previousLow
          ? "HL"
          : "LL";
      previousLow = swing.price;
    }
    return {
      id: `${timeframe}:${swing.direction}:${swing.openTime}`,
      timeframe,
      direction: swing.direction,
      structureTag,
      price: swing.price,
      openTime: swing.openTime
    };
  });
  return tagged.slice(-limit);
}

export class LiveMarketAnalysisService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly orchestrator = new MarketAnalysisOrchestrator();

  constructor(
    private readonly restClient: Pick<BinanceRestClient, "getHistoricalKlines">,
    private readonly cacheTtlMs = 20_000
  ) {}

  async getAnalysis(
    symbol: string,
    executionTimeframe: MarketTimeframe = "5m"
  ): Promise<MarketAnalysisView> {
    const cacheKey = `${symbol}:${executionTimeframe}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const fetchTimeframes: readonly AnalysisMarketTimeframe[] =
      executionTimeframe === "1m"
        ? [...ANALYSIS_TIMEFRAMES, "1m"]
        : ANALYSIS_TIMEFRAMES;

    const results = await Promise.allSettled(
      fetchTimeframes.map((timeframe) =>
        this.restClient.getHistoricalKlines({
          symbol,
          timeframe,
          limit: 200
        })
      )
    );

    const datasets = new Map<AnalysisMarketTimeframe, readonly Candle[]>();
    const warnings: string[] = [];
    for (const [index, result] of results.entries()) {
      const timeframe = fetchTimeframes[index]!;
      if (result.status === "fulfilled") {
        datasets.set(timeframe, result.value);
      } else {
        warnings.push(`Unable to load ${timeframe} candles`);
        if (timeframe === "5m" || timeframe === executionTimeframe) {
          throw new Error(`Unable to load ${timeframe} execution candles: ${String(result.reason)}`);
        }
      }
    }

    const analyzed = this.orchestrator.analyze(symbol, datasets, {
      executionTimeframe: executionTimeframe as AnalysisMarketTimeframe
    });
    if (!analyzed) {
      throw new Error(`No closed ${executionTimeframe} candles available for ${symbol}`);
    }

    const { snapshot, evaluations, candidates, breakoutAnticipation, topDownBias } = analyzed;
    const timeframes: TimeframeSummaryView[] = ANALYSIS_TIMEFRAMES.map((timeframe) => {
      const entry = snapshot.timeframes[timeframe];
      const volatilityRegime: TimeframeSummaryView["volatilityRegime"] =
        entry.marketRegime.regime === "high_volatility"
          ? "high"
          : entry.marketRegime.regime === "low_volatility"
            ? "low"
            : "normal";
      return {
        timeframe,
        availableAt: entry.availableAt,
        regime: entry.marketStructure.regime,
        volatilityRegime,
        trendStrength: entry.marketRegime.atrPercent === null
          ? 0
          : Number(entry.marketRegime.atrPercent.toFixed(2)),
        latestHigh: entry.marketStructure.latestHigh?.price ?? null,
        latestLow: entry.marketStructure.latestLow?.price ?? null,
        candleCount: entry.candles.length
      };
    });

    const trendlinesByTimeframe: Partial<Record<MarketTimeframe, readonly FourHourTrendlineView[]>> = {};
    const swingsByTimeframe: Partial<Record<MarketTimeframe, readonly SwingLevelView[]>> = {};
    for (const timeframe of ANALYSIS_TIMEFRAMES) {
      const entry = snapshot.timeframes[timeframe];
      trendlinesByTimeframe[timeframe] = mapTimeframeTrendlines(timeframe, entry, snapshot.analysisTime);
      swingsByTimeframe[timeframe] = mapTimeframeSwings(timeframe, entry, 12);
    }

    const fourHourTrendlines = trendlinesByTimeframe["4h"] ?? [];
    const swingLevels: SwingLevelView[] = [
      ...(swingsByTimeframe["1d"] ?? []).slice(-2),
      ...(swingsByTimeframe["4h"] ?? []).slice(-3),
      ...(swingsByTimeframe["1h"] ?? []).slice(-3)
    ].slice(-6);
    const activeOrderBlocks = [
      ...detectActiveOrderBlocks(snapshot.timeframes["5m"].candles, {
        maximumZoneAgeCandles: Math.min(180, Math.max(10, snapshot.timeframes["5m"].candles.length - 2))
      }).map((zone) => ({ ...zone, timeframe: "5m" as const })),
      ...detectActiveOrderBlocks(snapshot.timeframes["1h"].candles, {
        maximumZoneAgeCandles: Math.min(120, Math.max(10, snapshot.timeframes["1h"].candles.length - 2))
      }).map((zone) => ({ ...zone, timeframe: "1h" as const })),
      ...detectActiveOrderBlocks(snapshot.timeframes["4h"].candles, {
        maximumZoneAgeCandles: Math.min(80, Math.max(10, snapshot.timeframes["4h"].candles.length - 2))
      }).map((zone) => ({ ...zone, timeframe: "4h" as const })),
      ...detectActiveOrderBlocks(snapshot.timeframes["1d"].candles, {
        maximumZoneAgeCandles: Math.min(60, Math.max(8, snapshot.timeframes["1d"].candles.length - 2))
      }).map((zone) => ({ ...zone, timeframe: "1d" as const }))
    ];

    const view: MarketAnalysisView = {
      symbol: snapshot.symbol,
      executionTimeframe,
      snapshotId: snapshot.snapshotId,
      analysisTime: snapshot.analysisTime,
      latestPrice: Number(snapshot.signalCandle.close),
      signalCandle: snapshot.signalCandle,
      ...(topDownBias ? { topDownBias } : {}),
      ...(breakoutAnticipation ? { breakoutAnticipation } : {}),
      timeframes,
      fourHourTrendlines,
      trendlinesByTimeframe,
      swingLevels,
      swingsByTimeframe,
      activeOrderBlocks,
      evaluations,
      candidates: candidates.map((candidate) => ({
        signalId: candidate.signalId,
        strategy: candidate.strategy,
        ...(candidate.mode === undefined ? {} : { mode: candidate.mode }),
        side: candidate.side,
        entryPrice: candidate.entryPrice,
        stopLoss: candidate.stopLoss,
        target1: candidate.target1,
        target2: candidate.target2,
        target3: candidate.target3,
        minimumRiskReward: candidate.minimumRiskReward,
        higherTimeframeBias: candidate.higherTimeframeBias,
        entryCandleOpenTime: candidate.entryCandleOpenTime,
        chartAnnotations: candidate.chartAnnotations
      })),
      warnings
    };

    if (this.cacheTtlMs > 0) {
      if (this.cache.size > 50) this.cache.clear();
      this.cache.set(cacheKey, {
        expiresAt: now + this.cacheTtlMs,
        value: view
      });
    }
    return view;
  }
}
