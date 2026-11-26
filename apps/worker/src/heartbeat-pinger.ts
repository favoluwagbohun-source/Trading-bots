export const DEFAULT_HEARTBEAT_INTERVAL_MS = 600_000;
export const MIN_HEARTBEAT_INTERVAL_MS = 10_000;
export const MAX_HEARTBEAT_INTERVAL_MS = 840_000;
const DEFAULT_PING_TIMEOUT_MS = 10_000;

export interface HeartbeatPingerOptions {
  readonly targetUrl: string;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly onSuccess?: (statusCode: number) => void;
  readonly onError?: (error: unknown) => void;
}

export function parseHeartbeatIntervalMs(value: string | undefined): number {
  if (value === undefined || !value.trim()) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_HEARTBEAT_INTERVAL_MS ||
    parsed > MAX_HEARTBEAT_INTERVAL_MS
  ) {
    throw new Error(
      `HEARTBEAT_INTERVAL_MS must be an integer between ${MIN_HEARTBEAT_INTERVAL_MS} and ${MAX_HEARTBEAT_INTERVAL_MS}`
    );
  }
  return parsed;
}

export function resolveHeartbeatUrl(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  const enabledFlag = env.HEARTBEAT_ENABLED?.trim().toLowerCase();
  if (enabledFlag === "false" || enabledFlag === "0") return undefined;

  const explicitUrl = env.HEARTBEAT_URL?.trim();
  if (explicitUrl) {
    const parsed = new URL(explicitUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("HEARTBEAT_URL must use http:// or https://");
    }
    return parsed.toString();
  }

  const renderExternalUrl = env.RENDER_EXTERNAL_URL?.trim();
  if (renderExternalUrl) {
    const parsed = new URL(renderExternalUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("RENDER_EXTERNAL_URL must use http:// or https://");
    }
    const base = parsed.toString().replace(/\/+$/, "");
    return `${base}/ping`;
  }

  if (enabledFlag === "true" || enabledFlag === "1") {
    const port = Number(env.PORT ?? 3000);
    const validPort = Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 3000;
    return `http://127.0.0.1:${validPort}/ping`;
  }

  return undefined;
}

function abortableWait(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, durationMs);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class HeartbeatPinger {
  private readonly targetUrl: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onSuccess?: (statusCode: number) => void;
  private readonly onError?: (error: unknown) => void;

  constructor(options: HeartbeatPingerOptions) {
    const parsed = new URL(options.targetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Heartbeat targetUrl must use http:// or https://");
    }
    this.targetUrl = parsed.toString();
    this.intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (
      !Number.isInteger(this.intervalMs) ||
      this.intervalMs < MIN_HEARTBEAT_INTERVAL_MS ||
      this.intervalMs > MAX_HEARTBEAT_INTERVAL_MS
    ) {
      throw new Error(
        `Heartbeat intervalMs must be between ${MIN_HEARTBEAT_INTERVAL_MS} and ${MAX_HEARTBEAT_INTERVAL_MS}`
      );
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (options.onSuccess) this.onSuccess = options.onSuccess;
    if (options.onError) this.onError = options.onError;
  }

  async pingOnce(signal?: AbortSignal): Promise<boolean> {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const onParentAbort = () => timeoutController.abort();
    signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      const response = await this.fetchImpl(this.targetUrl, {
        method: "GET",
        headers: { "cache-control": "no-store" },
        signal: timeoutController.signal
      });
      if (!response.ok) {
        throw new Error(`Heartbeat ping returned HTTP ${response.status}`);
      }
      this.onSuccess?.(response.status);
      return true;
    } catch (error) {
      if (signal?.aborted) return false;
      this.onError?.(error);
      return false;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onParentAbort);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await abortableWait(this.intervalMs, signal);
      if (signal.aborted) break;
      await this.pingOnce(signal);
    }
  }
}
