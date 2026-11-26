import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Candle } from "@crypto-signal/shared";
import type { StreamOptions } from "@crypto-signal/market-data";
import WebSocket from "ws";
import { createApiServer } from "./app.js";

const sampleCandle: Candle = {
  openTime: 1_700_000_000_000,
  closeTime: 1_700_000_059_999,
  open: "100",
  high: "102",
  low: "99",
  close: "101",
  volume: "10",
  closed: true
};

describe("market API", () => {
  const servers: FastifyInstance[] = [];
  const staticDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(staticDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it("serves the SPA and built assets without turning API 404s into HTML", async () => {
    const staticDirectory = await mkdtemp(join(tmpdir(), "trading-bots-web-"));
    staticDirectories.push(staticDirectory);
    await writeFile(join(staticDirectory, "index.html"), "<main>Trading bots</main>");
    await mkdir(join(staticDirectory, "assets"));
    await writeFile(join(staticDirectory, "assets", "app.js"), "export {};");
    const server = await createApiServer({ staticDirectory });
    servers.push(server);

    const home = await server.inject({ method: "GET", url: "/" });
    const spaRoute = await server.inject({ method: "GET", url: "/dashboard" });
    const asset = await server.inject({ method: "GET", url: "/assets/app.js" });
    const apiNotFound = await server.inject({ method: "GET", url: "/api/not-found" });

    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("Trading bots");
    expect(spaRoute.statusCode).toBe(200);
    expect(spaRoute.body).toContain("Trading bots");
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe("export {};");
    expect(apiNotFound.statusCode).toBe(404);
    expect(apiNotFound.json()).toEqual({ error: "Not Found" });
  });

  it("serves historical candles through the market-data client", async () => {
    const getHistoricalKlines = vi.fn(async () => [sampleCandle]);
    const server = await createApiServer({
      restClient: { getHistoricalKlines }
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/market/klines?symbol=btcusdt&timeframe=5m&limit=250"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ candles: [sampleCandle] });
    expect(getHistoricalKlines).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      timeframe: "5m",
      limit: 250
    });
  });

  it("rejects invalid market query parameters without requesting data", async () => {
    const getHistoricalKlines = vi.fn(async () => [sampleCandle]);
    const server = await createApiServer({
      restClient: { getHistoricalKlines }
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/market/klines?symbol=BTCUSDT&timeframe=1M&limit=1001"
    });

    expect(response.statusCode).toBe(400);
    expect(getHistoricalKlines).not.toHaveBeenCalled();
  });

  it("surfaces upstream data failures as an explicit gateway error", async () => {
    const getHistoricalKlines = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const server = await createApiServer({
      restClient: { getHistoricalKlines }
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/market/klines?symbol=BTCUSDT&timeframe=5m"
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: "Historical market data is unavailable"
    });
  });

  it("streams backend market updates to WebSocket clients and stops on disconnect", async () => {
    let streamOptions: StreamOptions | undefined;
    const stop = vi.fn();
    const server = await createApiServer({
      streamFactory: (options) => {
        streamOptions = options;
        return {
          start: () => undefined,
          stop
        };
      }
    });
    servers.push(server);
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(
      `${address.replace("http://", "ws://")}/api/market/stream?symbol=BTCUSDT&timeframe=5m`
    );
    await once(socket, "open");
    const message = once(socket, "message");
    if (!streamOptions) throw new Error("Market stream was not created");
    streamOptions?.onCandle(sampleCandle);

    const [data] = await message;
    expect(JSON.parse(data.toString())).toEqual({
      type: "candle",
      candle: sampleCandle
    });

    const closed = once(socket, "close");
    socket.close();
    await closed;
    expect(stop).toHaveBeenCalledOnce();
  });

  it("closes invalid WebSocket stream requests with a clear error", async () => {
    const server = await createApiServer();
    servers.push(server);
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(
      `${address.replace("http://", "ws://")}/api/market/stream?symbol=BTCUSDT&timeframe=nope`
    );
    const message = once(socket, "message");
    const closed = once(socket, "close");
    const [data] = await message;
    expect(JSON.parse(data.toString())).toMatchObject({
      type: "error",
      message: expect.stringContaining("Unsupported timeframe")
    });
    await closed;
  });
});
