import type { Candle } from "@crypto-signal/shared";
import type { BinanceRestClient } from "@crypto-signal/market-data";
import type { MarketTimeframe } from "@crypto-signal/market-data";
import {
  ANALYSIS_TIMEFRAMES,
  MarketAnalysisOrchestrator,
  type SignalCandidate
} from "./market-analysis.js";

const CANDIDATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type { ChartAnnotations, SignalCandidate } from "./market-analysis.js";

export interface SignalScannerOptions {
  readonly symbols: readonly string[];
  readonly client: Pick<BinanceRestClient, "getHistoricalKlines">;
  readonly scanIntervalMs: number;
  readonly onCandidate: (candidate: SignalCandidate) => void | Promise<void>;
  readonly onError: (symbol: string, error: unknown) => void;
  readonly onCandles?: (symbol: string, candles: readonly Candle[]) => void | Promise<void>;
  readonly onDatasets?: (
    symbol: string,
    datasets: ReadonlyMap<MarketTimeframe, readonly Candle[]>
  ) => void | Promise<void>;
  readonly onMarketDataSuccess?: (symbol: string) => void;
  readonly onScanStart?: () => void;
  readonly onScanComplete?: (summary: {
    readonly hadError: boolean;
    readonly lastError: string | null;
  }) => void;
  readonly historyLimit?: number;
}

function normalizeSymbols(symbols: readonly string[]): string[] {
  const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))];
  if (
    normalized.length === 0 ||
    normalized.some((symbol) => !/^[A-Z0-9]{6,20}$/.test(symbol))
  ) {
    throw new Error("Configure at least one valid Binance symbol in the watchlist");
  }
  return normalized;
}

function waitForNextScan(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class SignalScanner {
  private readonly symbols: readonly string[];
  private readonly historyLimit: number;
  private readonly emittedCandidates = new Map<string, number>();
  private readonly analysis = new MarketAnalysisOrchestrator();

  constructor(private readonly options: SignalScannerOptions) {
    this.symbols = normalizeSymbols(options.symbols);
    if (!Number.isInteger(options.scanIntervalMs) || options.scanIntervalMs < 5_000) {
      throw new Error("Scan interval must be an integer of at least 5000ms");
    }
    this.historyLimit = options.historyLimit ?? 500;
    if (!Number.isInteger(this.historyLimit) || this.historyLimit < 20 || this.historyLimit > 1000) {
      throw new Error("History limit must be an integer between 20 and 1000");
    }
  }

  async scanOnce(): Promise<SignalCandidate[]> {
    this.options.onScanStart?.();
    const emitted: SignalCandidate[] = [];
    let hadError = false;
    let lastError: string | null = null;
    for (const symbol of this.symbols) {
      try {
        const results = await Promise.allSettled(ANALYSIS_TIMEFRAMES.map((timeframe) =>
          this.options.client.getHistoricalKlines({
              symbol,
              timeframe,
              limit: this.historyLimit
            })
        ));
        const datasets = new Map<MarketTimeframe, readonly Candle[]>();
        let symbolHadTimeframeError = false;
        for (const [index, result] of results.entries()) {
          const timeframe = ANALYSIS_TIMEFRAMES[index]!;
          if (result.status === "fulfilled") {
            datasets.set(timeframe, result.value);
          } else {
            symbolHadTimeframeError = true;
            hadError = true;
            const error = new Error(`Unable to load ${timeframe} candles: ${String(result.reason)}`);
            lastError = error.message;
            this.options.onError(symbol, error);
          }
        }
        if (!datasets.has("5m")) continue;
        if (!symbolHadTimeframeError) {
          this.options.onMarketDataSuccess?.(symbol);
        }
        if (this.options.onCandles) {
          await this.options.onCandles(symbol, datasets.get("5m")!);
        }
        if (this.options.onDatasets) {
          await this.options.onDatasets(symbol, datasets);
        }
        const analysis = this.analysis.analyze(symbol, datasets);
        for (const candidate of analysis?.candidates ?? []) {
          if (this.emittedCandidates.has(candidate.signalId)) continue;
          await this.options.onCandidate(candidate);
          this.emittedCandidates.set(candidate.signalId, Date.now());
          emitted.push(candidate);
        }
      } catch (error) {
        hadError = true;
        lastError = error instanceof Error ? error.message : String(error);
        this.options.onError(symbol, error);
      }
    }

    const cutoff = Date.now() - CANDIDATE_RETENTION_MS;
    for (const [signalId, createdAt] of this.emittedCandidates) {
      if (createdAt < cutoff) this.emittedCandidates.delete(signalId);
    }
    this.options.onScanComplete?.({ hadError, lastError });
    return emitted;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.scanOnce();
      await waitForNextScan(this.options.scanIntervalMs, signal);
    }
  }
}
