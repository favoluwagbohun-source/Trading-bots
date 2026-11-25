import type { Candle } from "@crypto-signal/shared";
import { normalizeSymbol, validateTimeframe } from "./candle.js";
import { BinanceRestClient } from "./rest.js";
import { BinanceKlineStream } from "./stream.js";
import type { MarketTimeframe, StreamStatus } from "./types.js";

export interface MarketDataEngineOptions {
  readonly symbol: string;
  readonly timeframe: MarketTimeframe;
  readonly onCandle: (candle: Candle) => void;
  readonly onStatus?: (status: StreamStatus) => void;
  readonly pollingIntervalMs?: number;
}

export class MarketDataEngine {
  private readonly rest: BinanceRestClient;
  private readonly stream: BinanceKlineStream;
  private pollingTimer: ReturnType<typeof setInterval> | undefined;
  private latestClosedTime = 0;

  constructor(
    private readonly options: MarketDataEngineOptions,
    rest = new BinanceRestClient()
  ) {
    validateTimeframe(options.timeframe);
    normalizeSymbol(options.symbol);
    this.rest = rest;
    this.stream = new BinanceKlineStream({
      symbol: options.symbol,
      timeframe: options.timeframe,
      onCandle: (candle) => this.acceptCandle(candle),
      onStatus: (status) => {
        options.onStatus?.(status);
        if (!status.connected) this.startPolling();
      }
    });
  }

  start(): void {
    this.stream.start();
  }

  stop(): void {
    this.stream.stop();
    this.stopPolling();
  }

  private acceptCandle(candle: Candle): void {
    if (!candle.closed) return;
    this.latestClosedTime = Math.max(this.latestClosedTime, candle.closeTime);
    this.options.onCandle(candle);
  }

  private startPolling(): void {
    if (this.pollingTimer) return;
    const interval = this.options.pollingIntervalMs ?? 10_000;
    this.pollingTimer = setInterval(() => {
      void this.poll();
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    this.pollingTimer = undefined;
  }

  private async poll(): Promise<void> {
    const request: {
      symbol: string;
      timeframe: MarketTimeframe;
      limit: number;
      startTime?: number;
    } = {
      symbol: this.options.symbol,
      timeframe: this.options.timeframe,
      limit: 100
    };
    if (this.latestClosedTime > 0) {
      request.startTime = this.latestClosedTime + 1;
    }
    const candles = await this.rest.getHistoricalKlines(request);
    for (const candle of candles) this.acceptCandle(candle);
  }
}
