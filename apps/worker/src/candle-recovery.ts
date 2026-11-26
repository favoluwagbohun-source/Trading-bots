import type { Candle } from "@crypto-signal/shared";
import type { BinanceRestClient } from "@crypto-signal/market-data";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export interface CandleRecoveryOptions {
  readonly symbols: readonly string[];
  readonly marketData: Pick<BinanceRestClient, "iterateHistoricalKlines">;
  readonly getLastProcessedOpenTime: (symbol: string) => number | undefined;
  readonly onCandles: (symbol: string, candles: readonly Candle[]) => Promise<void> | void;
  readonly now?: () => number;
  readonly onInfo?: (message: string) => void;
  readonly onError?: (symbol: string, error: unknown) => void;
}

export interface CandleRecoveryResult {
  readonly recoveredSymbols: number;
  readonly recoveredCandles: number;
  readonly hadError: boolean;
  readonly lastError: string | null;
}

export function latestClosedFiveMinuteOpenTime(nowMs: number): number {
  return Math.floor(nowMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS - FIVE_MINUTES_MS;
}

export async function recoverMissingCandles(
  options: CandleRecoveryOptions
): Promise<CandleRecoveryResult> {
  const nowMs = (options.now ?? (() => Date.now()))();
  const latestClosedOpen = latestClosedFiveMinuteOpenTime(nowMs);
  const endTime = latestClosedOpen + FIVE_MINUTES_MS - 1;
  let recoveredSymbols = 0;
  let recoveredCandles = 0;
  let hadError = false;
  let lastError: string | null = null;

  for (const rawSymbol of options.symbols) {
    const symbol = rawSymbol.trim().toUpperCase();
    const checkpoint = options.getLastProcessedOpenTime(symbol);
    if (checkpoint === undefined || checkpoint >= latestClosedOpen) continue;

    const startTime = checkpoint + FIVE_MINUTES_MS;
    try {
      const recoveredForSymbol: Candle[] = [];
      for await (const page of options.marketData.iterateHistoricalKlines({
        symbol,
        timeframe: "5m",
        startTime,
        endTime
      })) {
        for (const candle of page) {
          if (candle.closed && candle.openTime > checkpoint && candle.openTime <= latestClosedOpen) {
            recoveredForSymbol.push(candle);
          }
        }
      }
      if (recoveredForSymbol.length === 0) continue;

      await options.onCandles(symbol, recoveredForSymbol);
      recoveredSymbols += 1;
      recoveredCandles += recoveredForSymbol.length;
      options.onInfo?.(
        `Recovered ${recoveredForSymbol.length} missed 5m candle(s) for ${symbol} after checkpoint ${checkpoint}.`
      );
    } catch (error) {
      hadError = true;
      lastError = error instanceof Error ? error.message : String(error);
      options.onError?.(symbol, error);
    }
  }

  return {
    recoveredSymbols,
    recoveredCandles,
    hadError,
    lastError
  };
}
