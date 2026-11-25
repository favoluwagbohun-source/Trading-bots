import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { CandleReplaySession } from "./replay-session.js";

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const openTime = 4_000_000 + index * 300_000;
    return {
      openTime,
      closeTime: openTime + 299_999,
      open: "100",
      high: "102",
      low: "98",
      close: "101",
      volume: "10",
      closed: true
    };
  });
}

describe("candle replay session", () => {
  afterEach(() => vi.useRealTimers());

  it("limits snapshots to the selected date window and visible prefix", () => {
    const source = candles(5);
    const replay = new CandleReplaySession({
      symbol: "btcusdt",
      timeframe: "5m",
      candles: source,
      startTime: source[1]!.openTime,
      endTime: source[3]!.openTime
    });

    expect(replay.snapshot()).toMatchObject({
      symbol: "BTCUSDT",
      timeframe: "5m",
      totalCandles: 3,
      currentCandle: source[1],
      visibleCandles: [source[1]]
    });
    expect(replay.stepForward().visibleCandles).toHaveLength(2);
    expect(replay.stepForward().visibleCandles).toHaveLength(3);
    expect(replay.snapshot().status).toBe("completed");
  });

  it("supports timed play, pause, stepping, and resume", () => {
    vi.useFakeTimers();
    const replay = new CandleReplaySession({
      symbol: "BTCUSDT",
      timeframe: "1m",
      candles: candles(4),
      baseIntervalMs: 100
    });
    const updates: number[] = [];
    const errors: unknown[] = [];
    const onUpdate = (snapshot: { index: number }) => updates.push(snapshot.index);
    const onError = (error: unknown) => errors.push(error);

    replay.play(onUpdate, onError);
    vi.advanceTimersByTime(100);
    expect(replay.snapshot().index).toBe(1);
    replay.pause();
    vi.advanceTimersByTime(500);
    expect(replay.snapshot().index).toBe(1);
    expect(replay.stepForward().index).toBe(2);
    replay.resume();
    vi.advanceTimersByTime(100);

    expect(replay.snapshot().status).toBe("completed");
    expect(replay.snapshot().index).toBe(3);
    expect(updates).toEqual([1, 3]);
    expect(errors).toEqual([]);
  });

  it("rejects stepping while playing and unsupported speeds", () => {
    vi.useFakeTimers();
    const replay = new CandleReplaySession({
      symbol: "BTCUSDT",
      timeframe: "5m",
      candles: candles(2)
    });
    replay.play(() => undefined, () => undefined);
    expect(() => replay.stepForward()).toThrow("Pause replay");
    expect(() => replay.setSpeed(0)).toThrow("between 0.1x and 100x");
    replay.pause();
  });

  it("reports playback callback errors and pauses the session", () => {
    vi.useFakeTimers();
    const replay = new CandleReplaySession({
      symbol: "BTCUSDT",
      timeframe: "5m",
      candles: candles(3),
      baseIntervalMs: 100
    });
    const failure = new Error("listener failed");
    const onError = vi.fn();

    replay.play(() => {
      throw failure;
    }, onError);
    vi.advanceTimersByTime(100);

    expect(replay.snapshot().status).toBe("paused");
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("rejects invalid date ranges and empty replay windows", () => {
    const data = candles(2);
    expect(() => new CandleReplaySession({
      symbol: "BTCUSDT",
      timeframe: "5m",
      candles: data,
      startTime: data[1]!.openTime,
      endTime: data[0]!.openTime
    })).toThrow("endTime cannot be before");
    expect(() => new CandleReplaySession({
      symbol: "BTCUSDT",
      timeframe: "5m",
      candles: data,
      startTime: data[1]!.closeTime + 1
    })).toThrow("No closed candles");
  });
});
