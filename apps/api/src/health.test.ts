import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WorkerHealthSnapshot } from "@crypto-signal/shared";
import { createApiServer } from "./app.js";

describe("separated subsystem health endpoints and API rate limiting", () => {
  const servers: FastifyInstance[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createHealthPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "api-health-test-"));
    tempDirs.push(dir);
    return join(dir, "worker-health.json");
  }

  it("reports SLEEPING honestly when no worker heartbeat file exists", async () => {
    const workerHealthPath = await createHealthPath();
    const server = await createApiServer({
      health: {
        workerHealthPath,
        now: () => 1_700_000_000_000,
        hostingEnvironment: "render"
      }
    });
    servers.push(server);

    const overall = await server.inject({ method: "GET", url: "/health" });
    const marketData = await server.inject({ method: "GET", url: "/health/market-data" });
    const signalEngine = await server.inject({ method: "GET", url: "/health/signal-engine" });
    const telegram = await server.inject({ method: "GET", url: "/health/telegram" });

    expect(overall.statusCode).toBe(200);
    expect(overall.json()).toMatchObject({
      status: "ok",
      api: "HEALTHY",
      state: "SLEEPING",
      workerState: "SLEEPING",
      stale: true,
      hostingEnvironment: "render"
    });
    expect(marketData.json()).toMatchObject({ state: "SLEEPING", stale: true });
    expect(signalEngine.json()).toMatchObject({ state: "SLEEPING", stale: true });
    expect(telegram.json()).toMatchObject({ stale: true });
  });

  it("reports live HEALTHY subsystems and redacts secrets", async () => {
    const workerHealthPath = await createHealthPath();
    const nowMs = 1_700_000_100_000;
    const snapshot: WorkerHealthSnapshot = {
      version: 1,
      startedAt: nowMs - 60_000,
      updatedAt: nowMs - 5_000,
      hostingEnvironment: "render-managed",
      marketData: {
        state: "HEALTHY",
        lastSuccessfulUpdateAt: nowMs - 5_000,
        consecutiveFailures: 0,
        skippedNoTradeCandleCount: 2,
        lastError: null
      },
      signalEngine: {
        state: "HEALTHY",
        lastScanStartedAt: nowMs - 6_000,
        lastScanCompletedAt: nowMs - 5_000,
        scanIntervalMs: 30_000,
        watchlist: ["BTCUSDT", "BTCUSDC"],
        lastProcessedOpenTimeBySymbol: { BTCUSDT: 1_700_000_000_000 },
        activePaperTradeCount: 1,
        pendingEventCount: 0,
        lastError: null
      },
      telegram: {
        state: "DEGRADED",
        configured: true,
        pollingActive: true,
        lastPollAt: nowMs - 4_000,
        lastDeliveryAt: nowMs - 30_000,
        pendingNotifications: 1,
        failedDeliveries: 1,
        lastError: "Failed request to https://api.telegram.org/bot123456:SECRET_ABC/sendPhoto"
      }
    };
    await writeFile(workerHealthPath, JSON.stringify(snapshot), "utf8");

    const server = await createApiServer({
      health: {
        workerHealthPath,
        now: () => nowMs
      }
    });
    servers.push(server);

    const overall = await server.inject({ method: "GET", url: "/health" });
    const marketData = await server.inject({ method: "GET", url: "/health/market-data" });
    const signalEngine = await server.inject({ method: "GET", url: "/health/signal-engine" });
    const telegram = await server.inject({ method: "GET", url: "/health/telegram" });

    expect(overall.json()).toMatchObject({
      status: "ok",
      api: "HEALTHY",
      state: "DEGRADED",
      workerState: "DEGRADED",
      stale: false,
      subsystems: {
        marketData: "HEALTHY",
        signalEngine: "HEALTHY",
        telegram: "DEGRADED"
      }
    });
    expect(marketData.json()).toMatchObject({
      state: "HEALTHY",
      skippedNoTradeCandleCount: 2,
      stale: false
    });
    expect(signalEngine.json()).toMatchObject({
      state: "HEALTHY",
      watchlist: ["BTCUSDT", "BTCUSDC"],
      activePaperTradeCount: 1,
      stale: false
    });
    expect(telegram.json().lastError).not.toContain("SECRET_ABC");
    expect(telegram.json().lastError).toContain("bot[REDACTED]");
  });

  it("marks stale worker heartbeats as SLEEPING rather than claiming HEALTHY", async () => {
    const workerHealthPath = await createHealthPath();
    const updatedAt = 1_700_000_000_000;
    const snapshot: WorkerHealthSnapshot = {
      version: 1,
      startedAt: updatedAt - 10_000,
      updatedAt,
      hostingEnvironment: "render",
      marketData: {
        state: "HEALTHY",
        lastSuccessfulUpdateAt: updatedAt,
        consecutiveFailures: 0,
        skippedNoTradeCandleCount: 0,
        lastError: null
      },
      signalEngine: {
        state: "HEALTHY",
        lastScanStartedAt: updatedAt - 1000,
        lastScanCompletedAt: updatedAt,
        scanIntervalMs: 30_000,
        watchlist: ["BTCUSDT"],
        lastProcessedOpenTimeBySymbol: {},
        activePaperTradeCount: 0,
        pendingEventCount: 0,
        lastError: null
      },
      telegram: {
        state: "HEALTHY",
        configured: true,
        pollingActive: true,
        lastPollAt: updatedAt,
        lastDeliveryAt: null,
        pendingNotifications: 0,
        failedDeliveries: 0,
        lastError: null
      }
    };
    await writeFile(workerHealthPath, JSON.stringify(snapshot), "utf8");

    const server = await createApiServer({
      health: {
        workerHealthPath,
        now: () => updatedAt + 300_000
      }
    });
    servers.push(server);

    const overall = await server.inject({ method: "GET", url: "/health" });
    expect(overall.json()).toMatchObject({
      state: "SLEEPING",
      workerState: "SLEEPING",
      stale: true,
      subsystems: {
        marketData: "SLEEPING",
        signalEngine: "SLEEPING",
        telegram: "SLEEPING"
      }
    });
  });

  it("rate limits excessive /api requests without blocking /health checks", async () => {
    const workerHealthPath = await createHealthPath();
    const server = await createApiServer({
      restClient: { getHistoricalKlines: vi.fn(async () => []) },
      health: { workerHealthPath },
      rateLimit: { max: 2, windowMs: 60_000 }
    });
    servers.push(server);

    const first = await server.inject({ method: "GET", url: "/api/market/klines?symbol=BTCUSDT&timeframe=5m" });
    const second = await server.inject({ method: "GET", url: "/api/market/klines?symbol=BTCUSDT&timeframe=5m" });
    const third = await server.inject({ method: "GET", url: "/api/market/klines?symbol=BTCUSDT&timeframe=5m" });
    const health = await server.inject({ method: "GET", url: "/health" });
    const ping = await server.inject({ method: "GET", url: "/ping" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
    expect(health.statusCode).toBe(200);
    expect(ping.statusCode).toBe(200);
    expect(ping.headers["cache-control"]).toBe("no-store");
    expect(ping.json()).toMatchObject({ status: "ok", timestamp: expect.any(Number) });
  });
});
