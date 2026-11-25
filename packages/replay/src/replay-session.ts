import type { Candle } from "@crypto-signal/shared";
import {
  validateTimeframe,
  type MarketTimeframe
} from "@crypto-signal/market-data";

export type ReplayStatus = "paused" | "playing" | "completed";

export interface ReplaySessionOptions {
  readonly symbol: string;
  readonly timeframe: MarketTimeframe;
  readonly candles: readonly Candle[];
  readonly startTime?: number;
  readonly endTime?: number;
  readonly baseIntervalMs?: number;
  readonly speed?: number;
}

export interface ReplaySnapshot {
  readonly symbol: string;
  readonly timeframe: MarketTimeframe;
  readonly status: ReplayStatus;
  readonly speed: number;
  readonly index: number;
  readonly totalCandles: number;
  readonly currentCandle: Candle;
  readonly visibleCandles: readonly Candle[];
}

export type ReplayUpdate = (snapshot: ReplaySnapshot) => void;
export type ReplayErrorHandler = (error: unknown) => void;

function cloneCandle(candle: Candle): Candle {
  return Object.freeze({ ...candle });
}

function validateCandle(candle: Candle, previous?: Candle): void {
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  if (
    !candle.closed ||
    !Number.isSafeInteger(candle.openTime) ||
    !Number.isSafeInteger(candle.closeTime) ||
    candle.closeTime <= candle.openTime ||
    ![open, high, low, close].every((price) => Number.isFinite(price) && price > 0) ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    high < low ||
    !Number.isFinite(Number(candle.volume)) ||
    Number(candle.volume) < 0
  ) {
    throw new Error(`Invalid closed replay candle at ${candle.openTime}`);
  }
  if (previous && candle.openTime <= previous.closeTime) {
    throw new Error("Replay candles must be strictly chronological and non-overlapping");
  }
}

export class CandleReplaySession {
  readonly symbol: string;
  readonly timeframe: MarketTimeframe;
  readonly #candles: readonly Candle[];
  readonly #baseIntervalMs: number;
  #index = 0;
  #speed: number;
  #status: ReplayStatus = "paused";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #onUpdate: ReplayUpdate | undefined;
  #onError: ReplayErrorHandler | undefined;

  constructor(options: ReplaySessionOptions) {
    this.symbol = options.symbol.trim().toUpperCase();
    this.timeframe = options.timeframe;
    validateTimeframe(options.timeframe);
    if (!/^[A-Z0-9]{6,20}$/.test(this.symbol)) {
      throw new Error(`Invalid replay symbol: ${options.symbol}`);
    }
    this.#baseIntervalMs = options.baseIntervalMs ?? 1000;
    if (!Number.isFinite(this.#baseIntervalMs) || this.#baseIntervalMs <= 0) {
      throw new Error("baseIntervalMs must be positive");
    }
    this.#speed = options.speed ?? 1;
    this.validateSpeed(this.#speed);
    if (options.startTime !== undefined && !Number.isFinite(options.startTime)) {
      throw new Error("startTime must be a finite timestamp");
    }
    if (options.endTime !== undefined && !Number.isFinite(options.endTime)) {
      throw new Error("endTime must be a finite timestamp");
    }
    if (
      options.startTime !== undefined &&
      options.endTime !== undefined &&
      options.endTime < options.startTime
    ) {
      throw new Error("endTime cannot be before startTime");
    }

    const closedCandles = options.candles.filter((candle) => candle.closed);
    for (let index = 0; index < closedCandles.length; index += 1) {
      validateCandle(closedCandles[index]!, closedCandles[index - 1]);
    }
    this.#candles = Object.freeze(closedCandles
      .filter((candle) =>
        (options.startTime === undefined || candle.openTime >= options.startTime) &&
        (options.endTime === undefined || candle.openTime <= options.endTime)
      )
      .map(cloneCandle));
    if (this.#candles.length === 0) {
      throw new Error("No closed candles exist in the requested replay window");
    }
  }

  snapshot(): ReplaySnapshot {
    const currentCandle = this.#candles[this.#index];
    if (!currentCandle) throw new Error("Replay cursor is outside the selected candle window");
    return Object.freeze({
      symbol: this.symbol,
      timeframe: this.timeframe,
      status: this.#status,
      speed: this.#speed,
      index: this.#index,
      totalCandles: this.#candles.length,
      currentCandle,
      visibleCandles: Object.freeze(this.#candles.slice(0, this.#index + 1))
    });
  }

  stepForward(): ReplaySnapshot {
    if (this.#status === "playing") {
      throw new Error("Pause replay before stepping");
    }
    if (this.#index >= this.#candles.length - 1) {
      this.#status = "completed";
      return this.snapshot();
    }
    this.#index += 1;
    if (this.#index === this.#candles.length - 1) this.#status = "completed";
    return this.snapshot();
  }

  play(onUpdate: ReplayUpdate, onError: ReplayErrorHandler): void {
    if (this.#status === "completed") {
      throw new Error("Replay has reached the end of its selected candle window");
    }
    if (this.#status === "playing") return;
    this.#onUpdate = onUpdate;
    this.#onError = onError;
    this.#status = "playing";
    this.scheduleNext();
  }

  pause(): ReplaySnapshot {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#status === "playing") this.#status = "paused";
    return this.snapshot();
  }

  resume(): void {
    if (!this.#onUpdate || !this.#onError) {
      throw new Error("Call play before resuming replay");
    }
    this.play(this.#onUpdate, this.#onError);
  }

  setSpeed(speed: number): ReplaySnapshot {
    this.validateSpeed(speed);
    this.#speed = speed;
    if (this.#status === "playing") {
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
      this.scheduleNext();
    }
    return this.snapshot();
  }

  private validateSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed < 0.1 || speed > 100) {
      throw new Error("Replay speed must be between 0.1x and 100x");
    }
  }

  private scheduleNext(): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#status !== "playing") return;
      if (this.#index >= this.#candles.length - 1) {
        this.#status = "completed";
        this.notifyUpdate();
        return;
      }

      this.#index += 1;
      if (this.#index >= this.#candles.length - 1) this.#status = "completed";
      this.notifyUpdate();
      if (this.#status === "playing") this.scheduleNext();
    }, this.#baseIntervalMs / this.#speed);
  }

  private notifyUpdate(): void {
    try {
      this.#onUpdate?.(this.snapshot());
    } catch (error) {
      this.pause();
      this.#onError?.(error);
    }
  }
}
