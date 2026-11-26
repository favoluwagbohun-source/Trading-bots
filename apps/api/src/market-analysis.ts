import type { BinanceRestClient, MarketTimeframe } from "@crypto-signal/market-data";
import type { Candle, StrategyId } from "@crypto-signal/shared";
import {
  ANALYSIS_TIMEFRAMES,
  MarketAnalysisOrchestrator,
  type AnalysisMarketTimeframe,
  type ChartAnnotations,
  type StrategyEvaluation
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

export interface FourHourTrendlineView {
  readonly id: string;
  readonly direction: "ascending" | "descending";
  readonly status: "valid" | "broken";
  readonly breakStatus: "unbroken" | "broken_above" | "broken_below";
  readonly qualifyingTouchCount: number;
  readonly anchorA: { readonly openTime: number; readonly price: number };
  readonly anchorB: { readonly openTime: number; readonly price: number };
  readonly projectedPrice: number;
}

export interface SwingLevelView {
  readonly id: string;
  readonly timeframe: "4h" | "1h";
  readonly direction: "high" | "low";
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
  readonly snapshotId: string;
  readonly analysisTime: number;
  readonly latestPrice: number;
  readonly signalCandle: Candle;
  readonly timeframes: readonly TimeframeSummaryView[];
  readonly fourHourTrendlines: readonly FourHourTrendlineView[];
  readonly swingLevels: readonly SwingLevelView[];
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

export class LiveMarketAnalysisService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly orchestrator = new MarketAnalysisOrchestrator();

  constructor(
    private readonly restClient: Pick<BinanceRestClient, "getHistoricalKlines">,
    private readonly cacheTtlMs = 20_000
  ) {}

  async getAnalysis(symbol: string): Promise<MarketAnalysisView> {
    const now = Date.now();
    const cached = this.cache.get(symbol);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const results = await Promise.allSettled(
      ANALYSIS_TIMEFRAMES.map((timeframe) =>
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
      const timeframe = ANALYSIS_TIMEFRAMES[index]!;
      if (result.status === "fulfilled") {
        datasets.set(timeframe, result.value);
      } else {
        warnings.push(`Unable to load ${timeframe} candles`);
        if (timeframe === "5m") {
          throw new Error(`Unable to load 5m execution candles: ${String(result.reason)}`);
        }
      }
    }

    const analyzed = this.orchestrator.analyze(symbol, datasets);
    if (!analyzed) {
      throw new Error(`No closed 5m candles available for ${symbol}`);
    }

    const { snapshot, evaluations, candidates } = analyzed;
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

    const fourHour = snapshot.timeframes["4h"];
    const fourHourTrendlines: FourHourTrendlineView[] = fourHour.trendlineLifecycles
      .slice()
      .sort((left, right) => Number(right.isValid) - Number(left.isValid) || right.createdAt - left.createdAt)
      .slice(0, 6)
      .map((lifecycle) => {
        const anchorA = {
          openTime: lifecycle.pointA.openTime,
          price: lifecycle.pointA.price
        };
        const anchorB = {
          openTime: lifecycle.pointB.openTime,
          price: lifecycle.pointB.price
        };
        return {
          id: lifecycle.id,
          direction: lifecycle.direction,
          status: lifecycle.isValid ? "valid" : "broken",
          breakStatus: lifecycle.breakStatus,
          qualifyingTouchCount: lifecycle.qualifyingTouchCount,
          anchorA,
          anchorB,
          projectedPrice: projectPrice(anchorA, anchorB, snapshot.analysisTime)
        };
      });

    const swingLevels: SwingLevelView[] = (["4h", "1h"] as const)
      .flatMap((timeframe) =>
        snapshot.timeframes[timeframe].swings.slice(-3).map((swing) => ({
          id: `${timeframe}:${swing.direction}:${swing.openTime}`,
          timeframe,
          direction: swing.direction,
          price: swing.price,
          openTime: swing.openTime
        }))
      )
      .slice(-6);

    const view: MarketAnalysisView = {
      symbol: snapshot.symbol,
      snapshotId: snapshot.snapshotId,
      analysisTime: snapshot.analysisTime,
      latestPrice: Number(snapshot.signalCandle.close),
      signalCandle: snapshot.signalCandle,
      timeframes,
      fourHourTrendlines,
      swingLevels,
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
      this.cache.set(symbol, {
        expiresAt: now + this.cacheTtlMs,
        value: view
      });
    }
    return view;
  }
}
