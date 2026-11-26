import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "./app.js";

const BOT_TOKEN = "test-bot-token";
const CHAT_ID = 123456;
const NOW = Date.now();

function createInitData(chatId = CHAT_ID, now = NOW): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(now / 1000)),
    query_id: "test-query",
    user: JSON.stringify({ id: chatId, first_name: "Test" })
  });
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

function trade(chatId: number, signalId: string, pnl: number, status: "active" | "closed") {
  return {
    chatId,
    signalId,
    symbol: "BTCUSDT",
    strategy: "break_and_retest",
    side: "buy",
    status,
    entryPrice: 100,
    stopPrice: 95,
    target1: 110,
    target2: 120,
    realizedPnl: pnl,
    entryCandleOpenTime: NOW - 10_000,
    ...(status === "closed" ? { closedAt: NOW - 1_000 } : {})
  };
}

describe("paper dashboard API", () => {
  const servers: FastifyInstance[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it("authenticates Telegram WebApp data and isolates dashboard records by chat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paper-dashboard-"));
    directories.push(directory);
    const telegramStatePath = join(directory, "telegram-state.json");
    const paperTradesPath = join(directory, "paper-trades.json");
    await writeFile(telegramStatePath, JSON.stringify({
      version: 2,
      users: {
        [CHAT_ID]: {
          accountEquity: 1000,
          awaitingAccount: false,
          paused: false,
          paperTradingEnabled: true,
          enabledStrategies: ["break_and_retest"]
        },
        "789": {
          accountEquity: 9999,
          awaitingAccount: false,
          paused: false,
          paperTradingEnabled: true,
          enabledStrategies: ["order_block_retest"]
        }
      },
      notificationClaims: []
    }));
    await writeFile(paperTradesPath, JSON.stringify({
      version: 2,
      trades: [
        trade(CHAT_ID, "own-closed", 20, "closed"),
        trade(CHAT_ID, "own-active", 0, "active"),
        trade(789, "other-account", 500, "closed")
      ],
      events: [],
      lastProcessedOpenTimeBySymbol: {},
      invalidatedSignalIds: []
    }));

    const server = await createApiServer({
      paperDashboard: { botToken: BOT_TOKEN, telegramStatePath, paperTradesPath }
    });
    servers.push(server);
    const response = await server.inject({
      method: "GET",
      url: "/api/paper/dashboard",
      headers: { authorization: `tma ${createInitData()}` }
    });

    expect(response.statusCode).toBe(200);
    const dashboard = response.json();
    expect(dashboard.account).toEqual({
      startingEquity: 1000,
      currentEquity: 1020,
      realizedPnl: 20,
      activeTradeCount: 1
    });
    expect(dashboard.settings.paperTradingEnabled).toBe(true);
    expect(dashboard.activeTrades.map(({ signalId }: { signalId: string }) => signalId))
      .toEqual(["own-active"]);
    expect(dashboard.history.map(({ signalId }: { signalId: string }) => signalId))
      .toEqual(["own-closed", "own-active"]);
    expect(dashboard.strategyPerformance).toContainEqual({
      strategy: "break_and_retest",
      closedTrades: 1,
      wins: 1,
      realizedPnl: 20
    });
    expect(response.body).not.toContain("other-account");
    expect(response.body).not.toContain("9999");
    expect(await readFile(telegramStatePath, "utf8")).toContain("9999");
  });

  it("rejects missing and tampered Telegram authorization", async () => {
    const server = await createApiServer({
      paperDashboard: {
        botToken: BOT_TOKEN,
        telegramStatePath: "./unused-telegram-state.json",
        paperTradesPath: "./unused-paper-trades.json"
      }
    });
    servers.push(server);

    const missing = await server.inject({ method: "GET", url: "/api/paper/dashboard" });
    expect(missing.statusCode).toBe(401);

    const tampered = new URLSearchParams(createInitData());
    tampered.set("user", JSON.stringify({ id: 789 }));
    const invalid = await server.inject({
      method: "GET",
      url: "/api/paper/dashboard",
      headers: { authorization: `tma ${tampered.toString()}` }
    });
    expect(invalid.statusCode).toBe(401);
  });

  it("rejects expired Telegram authorization", async () => {
    const server = await createApiServer({
      paperDashboard: {
        botToken: BOT_TOKEN,
        telegramStatePath: "./unused-telegram-state.json",
        paperTradesPath: "./unused-paper-trades.json"
      }
    });
    servers.push(server);
    const stale = createInitData(CHAT_ID, NOW - 86_401_000);
    const response = await server.inject({
      method: "GET",
      url: "/api/paper/dashboard",
      headers: { authorization: `tma ${stale}` }
    });
    expect(response.statusCode).toBe(401);
  });
});
