import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type {
  HealthState,
  MarketDataHealthSnapshot,
  SignalEngineHealthSnapshot,
  TelegramHealthSnapshot,
  WorkerHealthSnapshot
} from "@crypto-signal/shared";

export interface WorkerHealthStoreOptions {
  readonly filePath: string;
  readonly watchlist: readonly string[];
  readonly scanIntervalMs: number;
  readonly telegramConfigured: boolean;
  readonly hostingEnvironment?: string;
  readonly secrets?: readonly string[];
  readonly now?: () => number;
}

export interface ScanCompletedUpdate {
  readonly lastProcessedOpenTimeBySymbol: Readonly<Record<string, number>>;
  readonly activePaperTradeCount: number;
  readonly pendingEventCount: number;
  readonly hadSymbolErrors: boolean;
  readonly lastError?: string | null;
  readonly timestamp?: number;
}

export interface RecoveryCompletedUpdate {
  readonly lastProcessedOpenTimeBySymbol: Readonly<Record<string, number>>;
  readonly activePaperTradeCount: number;
  readonly pendingEventCount: number;
  readonly hadError?: boolean;
  readonly lastError?: string | null;
  readonly timestamp?: number;
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

function nullableTimestamp(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function redactSecrets(message: string, secrets: readonly string[]): string {
  let sanitized = message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]");
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed) sanitized = sanitized.split(trimmed).join("[REDACTED]");
  }
  return sanitized.slice(0, 500);
}

function formatError(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw, secrets);
}

function inferHostingEnvironment(): string {
  if (process.env.RENDER === "true" || process.env.RENDER_SERVICE_ID) {
    return process.env.RENDER_INSTANCE_ID ? "render-managed" : "render";
  }
  if (process.env.COMPOSE_PROJECT_NAME) return "docker-compose";
  return process.env.HOSTING_ENVIRONMENT?.trim() || "node";
}

export function isWorkerHealthSnapshot(value: unknown): value is WorkerHealthSnapshot {
  if (!isRecord(value) || value.version !== 1) return false;
  if (
    typeof value.startedAt !== "number" ||
    !Number.isFinite(value.startedAt) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    typeof value.hostingEnvironment !== "string"
  ) {
    return false;
  }
  const { marketData, signalEngine, telegram } = value;
  if (!isRecord(marketData) || !isRecord(signalEngine) || !isRecord(telegram)) return false;
  return isHealthState(marketData.state) &&
    typeof marketData.consecutiveFailures === "number" &&
    typeof marketData.skippedNoTradeCandleCount === "number" &&
    isHealthState(signalEngine.state) &&
    typeof signalEngine.scanIntervalMs === "number" &&
    Array.isArray(signalEngine.watchlist) &&
    isRecord(signalEngine.lastProcessedOpenTimeBySymbol) &&
    typeof signalEngine.activePaperTradeCount === "number" &&
    typeof signalEngine.pendingEventCount === "number" &&
    isHealthState(telegram.state) &&
    typeof telegram.configured === "boolean" &&
    typeof telegram.pollingActive === "boolean" &&
    typeof telegram.pendingNotifications === "number" &&
    typeof telegram.failedDeliveries === "number";
}

export class WorkerHealthStore {
  private readonly filePath: string;
  private readonly secrets: readonly string[];
  private readonly now: () => number;
  private marketDataConsecutiveFailures = 0;
  private telegramConsecutivePollFailures = 0;
  private snapshot: WorkerHealthSnapshot;

  constructor(options: WorkerHealthStoreOptions) {
    if (!options.filePath.trim()) throw new Error("Worker health file path is required");
    this.filePath = options.filePath;
    this.secrets = options.secrets ?? [];
    this.now = options.now ?? (() => Date.now());
    const timestamp = this.now();
    const prior = this.tryReadExisting();

    const marketData: MarketDataHealthSnapshot = {
      state: "RECOVERING",
      lastSuccessfulUpdateAt: prior ? nullableTimestamp(prior.marketData.lastSuccessfulUpdateAt) : null,
      consecutiveFailures: 0,
      skippedNoTradeCandleCount: 0,
      lastError: null
    };
    const signalEngine: SignalEngineHealthSnapshot = {
      state: "RECOVERING",
      lastScanStartedAt: prior ? nullableTimestamp(prior.signalEngine.lastScanStartedAt) : null,
      lastScanCompletedAt: prior ? nullableTimestamp(prior.signalEngine.lastScanCompletedAt) : null,
      scanIntervalMs: options.scanIntervalMs,
      watchlist: [...options.watchlist],
      lastProcessedOpenTimeBySymbol: prior
        ? { ...prior.signalEngine.lastProcessedOpenTimeBySymbol }
        : {},
      activePaperTradeCount: prior?.signalEngine.activePaperTradeCount ?? 0,
      pendingEventCount: prior?.signalEngine.pendingEventCount ?? 0,
      lastError: null
    };
    const telegram: TelegramHealthSnapshot = {
      state: options.telegramConfigured ? "RECOVERING" : "DISCONNECTED",
      configured: options.telegramConfigured,
      pollingActive: false,
      lastPollAt: prior ? nullableTimestamp(prior.telegram.lastPollAt) : null,
      lastDeliveryAt: prior ? nullableTimestamp(prior.telegram.lastDeliveryAt) : null,
      pendingNotifications: prior?.telegram.pendingNotifications ?? 0,
      failedDeliveries: prior?.telegram.failedDeliveries ?? 0,
      lastError: null
    };

    this.snapshot = {
      version: 1,
      startedAt: timestamp,
      updatedAt: timestamp,
      hostingEnvironment: options.hostingEnvironment ?? inferHostingEnvironment(),
      marketData,
      signalEngine,
      telegram
    };
    this.persist();
  }

  getSnapshot(): WorkerHealthSnapshot {
    return this.snapshot;
  }

  recordMarketDataSuccess(
    skippedNoTradeCandleCount: number,
    timestamp = this.now()
  ): void {
    this.marketDataConsecutiveFailures = 0;
    this.updateSnapshot(timestamp, {
      marketData: {
        state: "HEALTHY",
        lastSuccessfulUpdateAt: timestamp,
        consecutiveFailures: 0,
        skippedNoTradeCandleCount,
        lastError: null
      }
    });
  }

  recordMarketDataError(
    error: unknown,
    skippedNoTradeCandleCount: number,
    timestamp = this.now()
  ): void {
    this.marketDataConsecutiveFailures += 1;
    const state: HealthState =
      this.marketDataConsecutiveFailures >= 3 ? "DISCONNECTED" : "DEGRADED";
    this.updateSnapshot(timestamp, {
      marketData: {
        ...this.snapshot.marketData,
        state,
        consecutiveFailures: this.marketDataConsecutiveFailures,
        skippedNoTradeCandleCount,
        lastError: formatError(error, this.secrets)
      }
    });
  }

  recordScanStarted(timestamp = this.now()): void {
    this.updateSnapshot(timestamp, {
      signalEngine: {
        ...this.snapshot.signalEngine,
        lastScanStartedAt: timestamp
      }
    });
  }

  recordRecoveryComplete(update: RecoveryCompletedUpdate): void {
    const timestamp = update.timestamp ?? this.now();
    this.updateSnapshot(timestamp, {
      signalEngine: {
        ...this.snapshot.signalEngine,
        state: update.hadError ? "DEGRADED" : "HEALTHY",
        lastProcessedOpenTimeBySymbol: { ...update.lastProcessedOpenTimeBySymbol },
        activePaperTradeCount: update.activePaperTradeCount,
        pendingEventCount: update.pendingEventCount,
        lastError: update.lastError ? redactSecrets(update.lastError, this.secrets) : null
      }
    });
  }

  recordScanCompleted(update: ScanCompletedUpdate): void {
    const timestamp = update.timestamp ?? this.now();
    const state: HealthState = update.hadSymbolErrors
      ? this.marketDataConsecutiveFailures >= 3 ? "DISCONNECTED" : "DEGRADED"
      : "HEALTHY";
    this.updateSnapshot(timestamp, {
      signalEngine: {
        ...this.snapshot.signalEngine,
        state,
        lastScanCompletedAt: timestamp,
        lastProcessedOpenTimeBySymbol: { ...update.lastProcessedOpenTimeBySymbol },
        activePaperTradeCount: update.activePaperTradeCount,
        pendingEventCount: update.pendingEventCount,
        lastError: update.lastError
          ? redactSecrets(update.lastError, this.secrets)
          : update.hadSymbolErrors
            ? this.snapshot.signalEngine.lastError
            : null
      },
      telegram: {
        ...this.snapshot.telegram,
        pendingNotifications: update.pendingEventCount
      }
    });
  }

  recordTelegramPollSuccess(
    pendingNotifications: number,
    timestamp = this.now()
  ): void {
    if (!this.snapshot.telegram.configured) return;
    this.telegramConsecutivePollFailures = 0;
    this.updateSnapshot(timestamp, {
      telegram: {
        ...this.snapshot.telegram,
        state: "HEALTHY",
        pollingActive: true,
        lastPollAt: timestamp,
        pendingNotifications,
        lastError: null
      }
    });
  }

  recordTelegramPollError(
    error: unknown,
    pendingNotifications: number,
    timestamp = this.now()
  ): void {
    if (!this.snapshot.telegram.configured) return;
    this.telegramConsecutivePollFailures += 1;
    const state: HealthState =
      this.telegramConsecutivePollFailures >= 3 ? "DISCONNECTED" : "DEGRADED";
    this.updateSnapshot(timestamp, {
      telegram: {
        ...this.snapshot.telegram,
        state,
        pollingActive: false,
        pendingNotifications,
        lastError: formatError(error, this.secrets)
      }
    });
  }

  recordTelegramDeliverySuccess(
    pendingNotifications: number,
    timestamp = this.now()
  ): void {
    if (!this.snapshot.telegram.configured) return;
    this.updateSnapshot(timestamp, {
      telegram: {
        ...this.snapshot.telegram,
        state: this.snapshot.telegram.pollingActive ? "HEALTHY" : this.snapshot.telegram.state,
        lastDeliveryAt: timestamp,
        pendingNotifications,
        lastError: null
      }
    });
  }

  recordTelegramDeliveryError(
    error: unknown,
    pendingNotifications: number,
    timestamp = this.now()
  ): void {
    if (!this.snapshot.telegram.configured) return;
    this.updateSnapshot(timestamp, {
      telegram: {
        ...this.snapshot.telegram,
        state: "DEGRADED",
        pendingNotifications,
        failedDeliveries: this.snapshot.telegram.failedDeliveries + 1,
        lastError: formatError(error, this.secrets)
      }
    });
  }

  markSleeping(timestamp = this.now()): void {
    this.updateSnapshot(timestamp, {
      marketData: {
        ...this.snapshot.marketData,
        state: "SLEEPING"
      },
      signalEngine: {
        ...this.snapshot.signalEngine,
        state: "SLEEPING"
      },
      telegram: {
        ...this.snapshot.telegram,
        state: this.snapshot.telegram.configured ? "SLEEPING" : "DISCONNECTED",
        pollingActive: false
      }
    });
  }

  private updateSnapshot(
    timestamp: number,
    patch: Partial<Pick<WorkerHealthSnapshot, "marketData" | "signalEngine" | "telegram">>
  ): void {
    this.snapshot = {
      ...this.snapshot,
      updatedAt: timestamp,
      ...patch
    };
    this.persist();
  }

  private tryReadExisting(): WorkerHealthSnapshot | undefined {
    try {
      const content = readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(content);
      return isWorkerHealthSnapshot(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private persist(): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const descriptor = openSync(temporaryPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(this.snapshot), "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.filePath);
      renamed = true;
    } finally {
      if (!renamed && existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}
