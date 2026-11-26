import { readFile } from "node:fs/promises";
import type {
  HealthState,
  MarketDataHealthSnapshot,
  SignalEngineHealthSnapshot,
  TelegramHealthSnapshot,
  WorkerHealthSnapshot
} from "@crypto-signal/shared";

export interface HealthReadOptions {
  readonly workerHealthPath?: string;
  readonly now?: () => number;
  readonly hostingEnvironment?: string;
  readonly processStartedAt?: number;
}

export interface OverallHealthResponse {
  readonly status: "ok";
  readonly api: "HEALTHY";
  readonly state: HealthState;
  readonly workerState: HealthState;
  readonly stale: boolean;
  readonly hostingEnvironment: string;
  readonly workerUpdatedAt: number | null;
  readonly uptimeSeconds: number;
  readonly timestamp: number;
  readonly subsystems: {
    readonly marketData: HealthState;
    readonly signalEngine: HealthState;
    readonly telegram: HealthState;
  };
}

export interface MarketDataHealthResponse extends MarketDataHealthSnapshot {
  readonly stale: boolean;
  readonly updatedAt: number | null;
  readonly hostingEnvironment: string;
}

export interface SignalEngineHealthResponse extends SignalEngineHealthSnapshot {
  readonly stale: boolean;
  readonly updatedAt: number | null;
  readonly hostingEnvironment: string;
}

export interface TelegramHealthResponse extends TelegramHealthSnapshot {
  readonly stale: boolean;
  readonly updatedAt: number | null;
  readonly hostingEnvironment: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHealthState(value: unknown): value is HealthState {
  return value === "HEALTHY" ||
    value === "DEGRADED" ||
    value === "DISCONNECTED" ||
    value === "SLEEPING" ||
    value === "RECOVERING";
}

function sanitizeError(error: unknown): string | null {
  if (typeof error !== "string" || !error.trim()) return null;
  return error.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]");
}

function defaultHostingEnvironment(): string {
  if (process.env.RENDER === "true" || process.env.RENDER_SERVICE_ID) {
    return process.env.RENDER_INSTANCE_ID ? "render-managed" : "render";
  }
  if (process.env.COMPOSE_PROJECT_NAME) return "docker-compose";
  return process.env.HOSTING_ENVIRONMENT?.trim() || "node";
}

function parseSnapshot(raw: unknown): WorkerHealthSnapshot | undefined {
  if (!isRecord(raw) || raw.version !== 1) return undefined;
  if (
    typeof raw.startedAt !== "number" ||
    !Number.isFinite(raw.startedAt) ||
    typeof raw.updatedAt !== "number" ||
    !Number.isFinite(raw.updatedAt) ||
    typeof raw.hostingEnvironment !== "string"
  ) {
    return undefined;
  }
  const { marketData, signalEngine, telegram } = raw;
  if (!isRecord(marketData) || !isRecord(signalEngine) || !isRecord(telegram)) return undefined;
  if (
    !isHealthState(marketData.state) ||
    typeof marketData.consecutiveFailures !== "number" ||
    typeof marketData.skippedNoTradeCandleCount !== "number" ||
    !isHealthState(signalEngine.state) ||
    typeof signalEngine.scanIntervalMs !== "number" ||
    !Array.isArray(signalEngine.watchlist) ||
    !isRecord(signalEngine.lastProcessedOpenTimeBySymbol) ||
    typeof signalEngine.activePaperTradeCount !== "number" ||
    typeof signalEngine.pendingEventCount !== "number" ||
    !isHealthState(telegram.state) ||
    typeof telegram.configured !== "boolean" ||
    typeof telegram.pollingActive !== "boolean" ||
    typeof telegram.pendingNotifications !== "number" ||
    typeof telegram.failedDeliveries !== "number"
  ) {
    return undefined;
  }
  return {
    version: 1,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    hostingEnvironment: raw.hostingEnvironment,
    marketData: {
      state: marketData.state,
      lastSuccessfulUpdateAt: typeof marketData.lastSuccessfulUpdateAt === "number"
        ? marketData.lastSuccessfulUpdateAt
        : null,
      consecutiveFailures: marketData.consecutiveFailures,
      skippedNoTradeCandleCount: marketData.skippedNoTradeCandleCount,
      lastError: sanitizeError(marketData.lastError)
    },
    signalEngine: {
      state: signalEngine.state,
      lastScanStartedAt: typeof signalEngine.lastScanStartedAt === "number"
        ? signalEngine.lastScanStartedAt
        : null,
      lastScanCompletedAt: typeof signalEngine.lastScanCompletedAt === "number"
        ? signalEngine.lastScanCompletedAt
        : null,
      scanIntervalMs: signalEngine.scanIntervalMs,
      watchlist: signalEngine.watchlist.filter((item): item is string => typeof item === "string"),
      lastProcessedOpenTimeBySymbol: Object.fromEntries(
        Object.entries(signalEngine.lastProcessedOpenTimeBySymbol).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])
        )
      ),
      activePaperTradeCount: signalEngine.activePaperTradeCount,
      pendingEventCount: signalEngine.pendingEventCount,
      lastError: sanitizeError(signalEngine.lastError)
    },
    telegram: {
      state: telegram.state,
      configured: telegram.configured,
      pollingActive: telegram.pollingActive,
      lastPollAt: typeof telegram.lastPollAt === "number" ? telegram.lastPollAt : null,
      lastDeliveryAt: typeof telegram.lastDeliveryAt === "number" ? telegram.lastDeliveryAt : null,
      pendingNotifications: telegram.pendingNotifications,
      failedDeliveries: telegram.failedDeliveries,
      lastError: sanitizeError(telegram.lastError)
    }
  };
}

function combineStates(states: readonly HealthState[]): HealthState {
  if (states.includes("SLEEPING")) return "SLEEPING";
  if (states.includes("RECOVERING")) return "RECOVERING";
  if (states.includes("DISCONNECTED")) return "DISCONNECTED";
  if (states.includes("DEGRADED")) return "DEGRADED";
  return "HEALTHY";
}

interface ResolvedHealth {
  readonly stale: boolean;
  readonly updatedAt: number | null;
  readonly hostingEnvironment: string;
  readonly marketData: MarketDataHealthSnapshot;
  readonly signalEngine: SignalEngineHealthSnapshot;
  readonly telegram: TelegramHealthSnapshot;
}

async function resolveWorkerHealth(options: HealthReadOptions): Promise<ResolvedHealth> {
  const nowMs = (options.now ?? (() => Date.now()))();
  const path = options.workerHealthPath ??
    process.env.WORKER_HEALTH_PATH?.trim() ??
    "./data/worker-health.json";
  const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());

  let snapshot: WorkerHealthSnapshot | undefined;
  let readError: string | null = null;
  try {
    const content = await readFile(path, "utf8");
    snapshot = parseSnapshot(JSON.parse(content));
    if (!snapshot) readError = "Worker health file has an unsupported schema";
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") {
      readError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!snapshot) {
    const fallbackError = readError ?? "No active worker heartbeat has been recorded";
    return {
      stale: true,
      updatedAt: null,
      hostingEnvironment: options.hostingEnvironment ?? defaultHostingEnvironment(),
      marketData: {
        state: "SLEEPING",
        lastSuccessfulUpdateAt: null,
        consecutiveFailures: 0,
        skippedNoTradeCandleCount: 0,
        lastError: fallbackError
      },
      signalEngine: {
        state: "SLEEPING",
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        scanIntervalMs: 30_000,
        watchlist: [],
        lastProcessedOpenTimeBySymbol: {},
        activePaperTradeCount: 0,
        pendingEventCount: 0,
        lastError: fallbackError
      },
      telegram: {
        state: telegramConfigured ? "SLEEPING" : "DISCONNECTED",
        configured: telegramConfigured,
        pollingActive: false,
        lastPollAt: null,
        lastDeliveryAt: null,
        pendingNotifications: 0,
        failedDeliveries: 0,
        lastError: telegramConfigured ? fallbackError : null
      }
    };
  }

  const staleAfterMs = Math.max(snapshot.signalEngine.scanIntervalMs * 3, 180_000);
  const stale = nowMs - snapshot.updatedAt > staleAfterMs;
  if (!stale) {
    return {
      stale: false,
      updatedAt: snapshot.updatedAt,
      hostingEnvironment: options.hostingEnvironment ?? snapshot.hostingEnvironment,
      marketData: snapshot.marketData,
      signalEngine: snapshot.signalEngine,
      telegram: snapshot.telegram
    };
  }

  return {
    stale: true,
    updatedAt: snapshot.updatedAt,
    hostingEnvironment: options.hostingEnvironment ?? snapshot.hostingEnvironment,
    marketData: {
      ...snapshot.marketData,
      state: "SLEEPING"
    },
    signalEngine: {
      ...snapshot.signalEngine,
      state: "SLEEPING"
    },
    telegram: {
      ...snapshot.telegram,
      state: snapshot.telegram.configured ? "SLEEPING" : "DISCONNECTED",
      pollingActive: false
    }
  };
}

export async function getOverallHealth(
  options: HealthReadOptions = {}
): Promise<OverallHealthResponse> {
  const nowMs = (options.now ?? (() => Date.now()))();
  const startedAt = options.processStartedAt ?? nowMs;
  const resolved = await resolveWorkerHealth(options);
  const activeStates: HealthState[] = [
    resolved.marketData.state,
    resolved.signalEngine.state,
    ...(resolved.telegram.configured ? [resolved.telegram.state] : [])
  ];
  const workerState = combineStates(activeStates);
  return {
    status: "ok",
    api: "HEALTHY",
    state: workerState,
    workerState,
    stale: resolved.stale,
    hostingEnvironment: resolved.hostingEnvironment,
    workerUpdatedAt: resolved.updatedAt,
    uptimeSeconds: Math.max(0, Math.floor((nowMs - startedAt) / 1000)),
    timestamp: nowMs,
    subsystems: {
      marketData: resolved.marketData.state,
      signalEngine: resolved.signalEngine.state,
      telegram: resolved.telegram.state
    }
  };
}

export async function getMarketDataHealth(
  options: HealthReadOptions = {}
): Promise<MarketDataHealthResponse> {
  const resolved = await resolveWorkerHealth(options);
  return {
    ...resolved.marketData,
    stale: resolved.stale,
    updatedAt: resolved.updatedAt,
    hostingEnvironment: resolved.hostingEnvironment
  };
}

export async function getSignalEngineHealth(
  options: HealthReadOptions = {}
): Promise<SignalEngineHealthResponse> {
  const resolved = await resolveWorkerHealth(options);
  return {
    ...resolved.signalEngine,
    stale: resolved.stale,
    updatedAt: resolved.updatedAt,
    hostingEnvironment: resolved.hostingEnvironment
  };
}

export async function getTelegramHealth(
  options: HealthReadOptions = {}
): Promise<TelegramHealthResponse> {
  const resolved = await resolveWorkerHealth(options);
  return {
    ...resolved.telegram,
    stale: resolved.stale,
    updatedAt: resolved.updatedAt,
    hostingEnvironment: resolved.hostingEnvironment
  };
}
