import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { StrategyId } from "@crypto-signal/shared";

const STRATEGY_IDS: readonly StrategyId[] = [
  "top_down_trendline",
  "break_and_retest",
  "liquidity_sweep_reversal",
  "order_block_retest"
];
const STRATEGY_ID_SET: ReadonlySet<string> = new Set(STRATEGY_IDS);

export interface TelegramUserState {
  readonly accountEquity: number | undefined;
  readonly awaitingAccount: boolean;
  readonly paused: boolean;
  readonly enabledStrategies: readonly StrategyId[];
}

interface MutableTelegramUserState {
  accountEquity: number | undefined;
  awaitingAccount: boolean;
  paused: boolean;
  enabledStrategies: Set<StrategyId>;
}

interface PersistedTelegramUserState {
  readonly accountEquity?: number;
  readonly awaitingAccount: boolean;
  readonly paused: boolean;
  readonly enabledStrategies: readonly StrategyId[];
}

interface PersistedStore {
  readonly version: 1;
  readonly users: Readonly<Record<string, PersistedTelegramUserState>>;
  readonly notificationClaims: readonly string[];
}

export interface TelegramUserStateStoreOptions {
  readonly filePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isStrategyId(value: unknown): value is StrategyId {
  return typeof value === "string" && STRATEGY_ID_SET.has(value);
}

export class TelegramUserStateStore {
  private readonly users = new Map<number, MutableTelegramUserState>();
  private readonly notificationClaims = new Set<string>();
  private readonly filePath: string | undefined;

  constructor(options: TelegramUserStateStoreOptions = {}) {
    this.filePath = options.filePath;
    if (this.filePath) this.load();
  }

  get(chatId: number): TelegramUserState {
    const user = this.getOrCreate(chatId);
    return Object.freeze({
      accountEquity: user.accountEquity,
      awaitingAccount: user.awaitingAccount,
      paused: user.paused,
      enabledStrategies: Object.freeze([...user.enabledStrategies])
    });
  }

  setAwaitingAccount(chatId: number, awaiting: boolean): void {
    this.updateUser(chatId, (user) => {
      user.awaitingAccount = awaiting;
    });
  }

  setAccountEquity(chatId: number, equity: number): void {
    if (!Number.isFinite(equity) || equity < 10 || equity > 1_000_000_000_000) {
      throw new Error("Account size must be between $10 and $1,000,000,000,000");
    }
    this.updateUser(chatId, (user) => {
      user.accountEquity = equity;
      user.awaitingAccount = false;
    });
  }

  setPaused(chatId: number, paused: boolean): void {
    this.updateUser(chatId, (user) => {
      user.paused = paused;
    });
  }

  setStrategyEnabled(chatId: number, strategy: StrategyId, enabled: boolean): void {
    this.updateUser(chatId, (user) => {
      if (enabled) user.enabledStrategies.add(strategy);
      else user.enabledStrategies.delete(strategy);
    });
  }

  isStrategyEnabled(chatId: number, strategy: StrategyId): boolean {
    return this.getOrCreate(chatId).enabledStrategies.has(strategy);
  }

  claimNotificationEvent(chatId: number, eventId: string): boolean {
    if (!eventId.trim()) throw new Error("Notification event ID is required");
    const hadUser = this.users.has(chatId);
    this.getOrCreate(chatId);
    const claim = `${chatId}:${eventId.trim()}`;
    if (this.notificationClaims.has(claim)) return false;
    this.notificationClaims.add(claim);
    try {
      this.persist();
    } catch (error) {
      this.notificationClaims.delete(claim);
      if (!hadUser) this.users.delete(chatId);
      throw error;
    }
    return true;
  }

  private load(): void {
    let content: string;
    try {
      content = readFileSync(this.filePath!, "utf8");
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`Telegram state file contains invalid JSON: ${String(error)}`);
    }
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isRecord(value.users) ||
      !Array.isArray(value.notificationClaims)
    ) {
      throw new Error("Telegram state file has an unsupported or malformed schema");
    }

    for (const [chatIdText, persisted] of Object.entries(value.users)) {
      const chatId = Number(chatIdText);
      if (!Number.isSafeInteger(chatId) || !isRecord(persisted)) {
        throw new Error("Telegram state file contains an invalid chat record");
      }
      const accountEquity = persisted.accountEquity;
      if (
        accountEquity !== undefined &&
        (typeof accountEquity !== "number" ||
          !Number.isFinite(accountEquity) ||
          accountEquity < 10 ||
          accountEquity > 1_000_000_000_000)
      ) {
        throw new Error(`Telegram state for chat ${chatId} has invalid account equity`);
      }
      if (
        typeof persisted.awaitingAccount !== "boolean" ||
        typeof persisted.paused !== "boolean" ||
        !Array.isArray(persisted.enabledStrategies) ||
        !persisted.enabledStrategies.every(isStrategyId)
      ) {
        throw new Error(`Telegram state for chat ${chatId} is malformed`);
      }
      this.users.set(chatId, {
        accountEquity,
        awaitingAccount: persisted.awaitingAccount,
        paused: persisted.paused,
        enabledStrategies: new Set(persisted.enabledStrategies)
      });
    }

    if (!value.notificationClaims.every((claim) =>
      typeof claim === "string" && claim.trim().length > 0
    )) {
      throw new Error("Telegram state file contains an invalid notification claim");
    }
    for (const claim of value.notificationClaims) {
      this.notificationClaims.add(claim);
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const users: Record<string, PersistedTelegramUserState> = {};
    for (const [chatId, user] of this.users) {
      users[String(chatId)] = {
        ...(user.accountEquity === undefined ? {} : { accountEquity: user.accountEquity }),
        awaitingAccount: user.awaitingAccount,
        paused: user.paused,
        enabledStrategies: [...user.enabledStrategies]
      };
    }
    const snapshot: PersistedStore = {
      version: 1,
      users,
      notificationClaims: [...this.notificationClaims]
    };
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const descriptor = openSync(temporaryPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(snapshot), "utf8");
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

  private updateUser(chatId: number, update: (user: MutableTelegramUserState) => void): void {
    const previous = this.users.get(chatId);
    const user = this.getOrCreate(chatId);
    const backup: MutableTelegramUserState = {
      ...user,
      enabledStrategies: new Set(user.enabledStrategies)
    };
    update(user);
    try {
      this.persist();
    } catch (error) {
      if (previous) this.users.set(chatId, backup);
      else this.users.delete(chatId);
      throw error;
    }
  }

  private getOrCreate(chatId: number): MutableTelegramUserState {
    if (!Number.isSafeInteger(chatId)) throw new Error("Telegram chat ID must be an integer");
    let user = this.users.get(chatId);
    if (!user) {
      user = {
        accountEquity: undefined,
        awaitingAccount: false,
        paused: false,
        enabledStrategies: new Set(STRATEGY_IDS)
      };
      this.users.set(chatId, user);
    }
    return user;
  }
}
