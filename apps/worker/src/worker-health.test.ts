import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { recoverMissingCandles, latestClosedFiveMinuteOpenTime } from "./candle-recovery.js";
import { WorkerHealthStore } from "./worker-health.js";

const tempDirs: string[] = [];

function createTempPath(filename: string): string {
  const dir = mkdtempSync(join(tmpdir(), "worker-health-test-"));
  tempDirs.push(dir);
  return join(dir, filename);
}

function makeClosedCandle(openTime: number, price = 100): Candle {
  return {
    openTime,
    closeTime: openTime + 299_999,
    open: String(price),
    high: String(price + 2),
    low: String(price - 1),
    close: String(price + 1),
    volume: "10",
    closed: true
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("WorkerHealthStore", () => {
  it("persists subsystem state transitions, redacts secrets, and marks SLEEPING on shutdown", () => {
    const filePath = createTempPath("worker-health.json");
    let nowMs = 1_700_000_000_000;
    const store = new WorkerHealthStore({
      filePath,
      watchlist: ["BTCUSDT"],
      scanIntervalMs: 60_000,
      telegramConfigured: true,
      hostingEnvironment: "render",
      secrets: ["super-secret-bot-token"],
      now: () => nowMs
    });

    expect(store.getSnapshot().signalEngine.state).toBe("RECOVERING");
    expect(store.getSnapshot().marketData.state).toBe("RECOVERING");
    expect(store.getSnapshot().telegram.state).toBe("RECOVERING");

    nowMs += 5_000;
    store.recordMarketDataError(new Error("Binance 503 with token super-secret-bot-token"), 1);
    expect(store.getSnapshot().marketData.state).toBe("DEGRADED");
    expect(store.getSnapshot().marketData.lastError).not.toContain("super-secret-bot-token");
    expect(store.getSnapshot().marketData.lastError).toContain("[REDACTED]");

    store.recordMarketDataError(new Error("timeout 2"), 1);
    store.recordMarketDataError(new Error("timeout 3"), 1);
    expect(store.getSnapshot().marketData.state).toBe("DISCONNECTED");

    nowMs += 5_000;
    store.recordMarketDataSuccess(2);
    store.recordScanCompleted({
      lastProcessedOpenTimeBySymbol: { BTCUSDT: 1_700_000_000_000 },
      activePaperTradeCount: 2,
      pendingEventCount: 1,
      hadSymbolErrors: false
    });
    store.recordTelegramPollSuccess(1);
    store.recordTelegramDeliverySuccess(0);

    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    expect(persisted.marketData.state).toBe("HEALTHY");
    expect(persisted.signalEngine.activePaperTradeCount).toBe(2);
    expect(persisted.telegram.state).toBe("HEALTHY");

    store.markSleeping(nowMs + 1_000);
    expect(store.getSnapshot().signalEngine.state).toBe("SLEEPING");
    expect(store.getSnapshot().marketData.state).toBe("SLEEPING");
    expect(store.getSnapshot().telegram.state).toBe("SLEEPING");
  });
});

describe("recoverMissingCandles", () => {
  it("backfills missed closed 5-minute candles after checkpoint up to latest closed candle", async () => {
    const fiveMin = 300_000;
    const checkpoint = 1_700_000_100_000;
    const nowMs = checkpoint + 3 * fiveMin + 10_000; // 2 missed closed candles (+1, +2), +3 is still open
    const latestClosed = latestClosedFiveMinuteOpenTime(nowMs);
    expect(latestClosed).toBe(checkpoint + 2 * fiveMin);

    const missedCandles = [
      makeClosedCandle(checkpoint + fiveMin, 101),
      makeClosedCandle(checkpoint + 2 * fiveMin, 102)
    ];
    const iterateHistoricalKlines = vi.fn(async function* () {
      yield missedCandles;
    });
    const onCandles = vi.fn(async () => undefined);

    const result = await recoverMissingCandles({
      symbols: ["btcusdt", "ethusdt"],
      marketData: { iterateHistoricalKlines },
      getLastProcessedOpenTime: (symbol) => (symbol === "BTCUSDT" ? checkpoint : undefined),
      onCandles,
      now: () => nowMs
    });

    expect(result).toEqual({
      recoveredSymbols: 1,
      recoveredCandles: 2,
      hadError: false,
      lastError: null
    });
    expect(iterateHistoricalKlines).toHaveBeenCalledOnce();
    expect(onCandles).toHaveBeenCalledWith("BTCUSDT", missedCandles);
  });

  it("reports recovery errors without throwing and continues remaining symbols", async () => {
    const fiveMin = 300_000;
    const checkpoint = 1_700_000_100_000;
    const nowMs = checkpoint + 3 * fiveMin + 10_000;
    const onError = vi.fn();

    const result = await recoverMissingCandles({
      symbols: ["BTCUSDT", "ETHUSDT"],
      marketData: {
        iterateHistoricalKlines: async function* () {
          throw new Error("Binance rate limit");
        }
      },
      getLastProcessedOpenTime: () => checkpoint,
      onCandles: vi.fn(),
      onError,
      now: () => nowMs
    });

    expect(result.hadError).toBe(true);
    expect(result.lastError).toBe("Binance rate limit");
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
