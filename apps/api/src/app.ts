import Fastify, { type FastifyInstance } from "fastify";
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

interface ApiDependencies {
  readonly restClient?: Pick<BinanceRestClient, "getHistoricalKlines">;
  readonly streamFactory?: (options: StreamOptions) => Pick<BinanceKlineStream, "start" | "stop">;
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

  await app.register(websocket);

  app.get("/health", async () => ({ status: "ok" }));

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

  return app;
}
