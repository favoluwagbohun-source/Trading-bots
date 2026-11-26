import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  BinanceKlineStream,
  BinanceRestClient,
  normalizeSymbol,
  validateTimeframe,
  type KlineSocket,
  type MarketTimeframe,
  type StreamOptions
} from "@crypto-signal/market-data";
import WebSocket from "ws";
import {
  getMarketDataHealth,
  getOverallHealth,
  getSignalEngineHealth,
  getTelegramHealth,
  type HealthReadOptions
} from "./health.js";
import {
  getPaperDashboard,
  TelegramAuthorizationError,
  type PaperDashboardOptions
} from "./paper-dashboard.js";
import { LiveMarketAnalysisService } from "./market-analysis.js";

interface MarketQuery {
  readonly symbol?: string;
  readonly timeframe?: string;
  readonly limit?: string;
  readonly startTime?: string;
  readonly endTime?: string;
}

interface MarketStreamQuery {
  readonly symbol?: string;
  readonly timeframe?: string;
}

interface RateLimitConfig {
  readonly max: number;
  readonly windowMs: number;
}

interface ApiDependencies {
  readonly restClient?: Pick<BinanceRestClient, "getHistoricalKlines">;
  readonly streamFactory?: (options: StreamOptions) => Pick<BinanceKlineStream, "start" | "stop">;
  readonly paperDashboard?: Omit<PaperDashboardOptions, "botToken"> & {
    readonly botToken?: string;
  };
  readonly health?: HealthReadOptions;
  readonly rateLimit?: RateLimitConfig | false;
  readonly staticDirectory?: string;
  readonly logger?: boolean;
}

class NodeKlineSocket implements KlineSocket {
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  close(): void {
    this.socket.close();
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string | ArrayBuffer }) => void
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: ((event: never) => void) | (() => void)
  ): void {
    if (type === "open") {
      this.socket.on("open", listener as () => void);
    } else if (type === "message") {
      this.socket.on("message", (data: WebSocket.RawData) => {
        (listener as (event: { data: string }) => void)({ data: data.toString() });
      });
    } else if (type === "close") {
      this.socket.on("close", (code: number, reason: Buffer) => {
        (listener as (event: { code: number; reason: string }) => void)({
          code,
          reason: reason.toString()
        });
      });
    } else {
      this.socket.on("error", listener as (event: Error) => void);
    }
  }
}

function parseInteger(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) throw new Error(`${field} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} must be a safe integer`);
  return parsed;
}

function parseMarketQuery(query: MarketQuery): {
  symbol: string;
  timeframe: MarketTimeframe;
  limit: number;
  startTime?: number;
  endTime?: number;
} {
  if (!query.symbol || !query.timeframe) {
    throw new Error("symbol and timeframe are required");
  }
  const symbol = normalizeSymbol(query.symbol);
  validateTimeframe(query.timeframe);
  const limit = parseInteger(query.limit, "limit") ?? 500;
  if (limit < 1 || limit > 1000) throw new Error("limit must be between 1 and 1000");
  const startTime = parseInteger(query.startTime, "startTime");
  const endTime = parseInteger(query.endTime, "endTime");
  if (startTime !== undefined && endTime !== undefined && startTime > endTime) {
    throw new Error("startTime cannot be after endTime");
  }
  return {
    symbol,
    timeframe: query.timeframe,
    limit,
    ...(startTime === undefined ? {} : { startTime }),
    ...(endTime === undefined ? {} : { endTime })
  };
}

function parseStreamQuery(query: MarketStreamQuery): {
  symbol: string;
  timeframe: MarketTimeframe;
} {
  if (!query.symbol || !query.timeframe) {
    throw new Error("symbol and timeframe are required");
  }
  const symbol = normalizeSymbol(query.symbol);
  validateTimeframe(query.timeframe);
  return { symbol, timeframe: query.timeframe };
}

export async function createApiServer(
  dependencies: ApiDependencies = {}
): Promise<FastifyInstance> {
  const app = Fastify({ logger: dependencies.logger ?? false });
  const restClient = dependencies.restClient ?? new BinanceRestClient();
  const streamFactory = dependencies.streamFactory ?? ((options: StreamOptions) =>
    new BinanceKlineStream({
      ...options,
      socketFactory: (url) => new NodeKlineSocket(url)
    }));
  const staticDirectory = dependencies.staticDirectory ??
    (process.env.SERVE_WEB_ASSETS === "true"
      ? fileURLToPath(new URL("../../web/dist", import.meta.url))
      : undefined);

  await app.register(websocket);
  if (staticDirectory) {
    await app.register(fastifyStatic, {
      root: staticDirectory,
      wildcard: false
    });
  }

  const processStartedAt = Date.now();
  const healthOptions: HealthReadOptions = {
    processStartedAt,
    ...dependencies.health
  };

  if (dependencies.rateLimit !== false) {
    const envMax = Number(process.env.API_RATE_LIMIT_MAX ?? 120);
    const max = dependencies.rateLimit?.max ??
      (Number.isInteger(envMax) && envMax > 0 ? envMax : 120);
    const windowMs = dependencies.rateLimit?.windowMs ?? 60_000;
    const buckets = new Map<string, { count: number; resetAt: number }>();
    app.addHook("onRequest", async (request, reply) => {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (!pathname.startsWith("/api/") || pathname === "/api/market/stream") return;
      const nowMs = Date.now();
      const key = request.ip || "unknown";
      const existing = buckets.get(key);
      if (!existing || nowMs >= existing.resetAt) {
        if (buckets.size > 1000) {
          for (const [bucketKey, bucket] of buckets) {
            if (nowMs >= bucket.resetAt) buckets.delete(bucketKey);
          }
        }
        buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
        return;
      }
      existing.count += 1;
      if (existing.count > max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000));
        reply.header("Retry-After", String(retryAfterSeconds));
        return reply.code(429).send({ error: "Rate limit exceeded. Try again shortly." });
      }
    });
  }

  app.get("/ping", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { status: "ok", timestamp: Date.now() };
  });
  app.get("/health", async () => getOverallHealth(healthOptions));
  app.get("/health/market-data", async () => getMarketDataHealth(healthOptions));
  app.get("/health/signal-engine", async () => getSignalEngineHealth(healthOptions));
  app.get("/health/telegram", async () => getTelegramHealth(healthOptions));

  app.get("/api/paper/dashboard", async (request, reply) => {
    const botToken = dependencies.paperDashboard?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return reply.code(503).send({ error: "Paper dashboard authentication is not configured" });
    }
    const authorization = request.headers.authorization;
    const initData = typeof authorization === "string" && authorization.startsWith("tma ")
      ? authorization.slice(4)
      : "";
    try {
      const dashboard = await getPaperDashboard(
        {
          botToken,
          telegramStatePath: dependencies.paperDashboard?.telegramStatePath ??
            process.env.TELEGRAM_STATE_PATH ?? "./data/telegram-state.json",
          paperTradesPath: dependencies.paperDashboard?.paperTradesPath ??
            process.env.PAPER_TRADES_PATH ?? "./data/paper-trades.json"
        },
        initData
      );
      return dashboard;
    } catch (error) {
      if (error instanceof TelegramAuthorizationError) {
        return reply.code(401).send({ error: "Valid Telegram WebApp authorization is required" });
      }
      request.log.error({ err: error }, "Failed to load paper-trading dashboard");
      return reply.code(500).send({ error: "Paper-trading dashboard data is unavailable" });
    }
  });

  const analysisService = new LiveMarketAnalysisService(restClient);

  app.get<{ Querystring: MarketQuery }>(
    "/api/market/klines",
    async (request, reply) => {
      let marketQuery: ReturnType<typeof parseMarketQuery>;
      try {
        marketQuery = parseMarketQuery(request.query);
      } catch (error) {
        return reply.code(400).send({ error: String(error) });
      }

      try {
        const candles = await restClient.getHistoricalKlines(marketQuery);
        return { candles };
      } catch (error) {
        request.log.error({ err: error }, "Failed to fetch historical market candles");
        return reply.code(502).send({ error: "Historical market data is unavailable" });
      }
    }
  );

  app.get<{ Querystring: { readonly symbol?: string } }>(
    "/api/market/analysis",
    async (request, reply) => {
      let symbol: string;
      try {
        if (!request.query.symbol) {
          throw new Error("symbol is required");
        }
        symbol = normalizeSymbol(request.query.symbol);
      } catch (error) {
        return reply.code(400).send({ error: String(error) });
      }

      try {
        return await analysisService.getAnalysis(symbol);
      } catch (error) {
        request.log.error({ err: error }, "Failed to compute live market analysis");
        return reply.code(502).send({ error: "Market analysis is temporarily unavailable" });
      }
    }
  );

  app.get<{ Querystring: MarketStreamQuery }>(
    "/api/market/stream",
    { websocket: true },
    (socket, request) => {
      let marketQuery: ReturnType<typeof parseStreamQuery>;
      try {
        marketQuery = parseStreamQuery(request.query);
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: String(error) }));
        socket.close(1008, "Invalid market stream request");
        return;
      }

      const stream = streamFactory({
        ...marketQuery,
        onCandle: (candle) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "candle", candle }));
          }
        },
        onStatus: (status) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "status", status }));
          }
        }
      });
      socket.on("close", () => stream.stop());
      socket.on("error", () => stream.stop());
      stream.start();
    }
  );

  if (staticDirectory) {
    app.setNotFoundHandler((request, reply) => {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (
        request.method !== "GET" ||
        pathname === "/api" ||
        pathname.startsWith("/api/")
      ) {
        return reply.code(404).send({ error: "Not Found" });
      }
      const asset = pathname.slice(1);
      return reply.sendFile(asset && extname(asset) ? asset : "index.html");
    });
  }

  return app;
}
