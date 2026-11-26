import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  HeartbeatPinger,
  parseHeartbeatIntervalMs,
  resolveHeartbeatUrl
} from "./heartbeat-pinger.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("heartbeat pinger configuration", () => {
  it("resolves explicit HEARTBEAT_URL, Render external URL, or local fallback when enabled", () => {
    expect(resolveHeartbeatUrl({})).toBeUndefined();
    expect(resolveHeartbeatUrl({ HEARTBEAT_ENABLED: "false", RENDER_EXTERNAL_URL: "https://bot.onrender.com" })).toBeUndefined();
    expect(resolveHeartbeatUrl({
      HEARTBEAT_URL: "https://example.com/ping",
      RENDER_EXTERNAL_URL: "https://bot.onrender.com"
    })).toBe("https://example.com/ping");
    expect(resolveHeartbeatUrl({
      RENDER_EXTERNAL_URL: "https://bot.onrender.com/"
    })).toBe("https://bot.onrender.com/ping");
    expect(resolveHeartbeatUrl({
      HEARTBEAT_ENABLED: "true",
      PORT: "10000"
    })).toBe("http://127.0.0.1:10000/ping");
  });

  it("validates heartbeat interval bounds", () => {
    expect(parseHeartbeatIntervalMs(undefined)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(parseHeartbeatIntervalMs("300000")).toBe(300_000);
    expect(() => parseHeartbeatIntervalMs("5000")).toThrow("HEARTBEAT_INTERVAL_MS");
    expect(() => parseHeartbeatIntervalMs("900000")).toThrow("HEARTBEAT_INTERVAL_MS");
  });
});

describe("HeartbeatPinger", () => {
  it("sends periodic GET requests on interval and recovers cleanly from transient errors", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const pinger = new HeartbeatPinger({
      targetUrl: "https://bot.onrender.com/ping",
      intervalMs: 10_000,
      fetchImpl: fetchMock,
      onSuccess,
      onError
    });

    const controller = new AbortController();
    const runner = pinger.run(controller.signal);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(200);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(onSuccess).toHaveBeenCalledTimes(2);

    controller.abort();
    await runner;
  });
});
