import type { StrategyId } from "@crypto-signal/shared";

const STRATEGY_IDS: readonly StrategyId[] = [
  "top_down_trendline",
  "break_and_retest",
  "liquidity_sweep_reversal",
  "order_block_retest"
];

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

export class TelegramUserStateStore {
  private readonly users = new Map<number, MutableTelegramUserState>();

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
    this.getOrCreate(chatId).awaitingAccount = awaiting;
  }

  setAccountEquity(chatId: number, equity: number): void {
    if (!Number.isFinite(equity) || equity < 10 || equity > 1_000_000_000_000) {
      throw new Error("Account size must be between $10 and $1,000,000,000,000");
    }
    const user = this.getOrCreate(chatId);
    user.accountEquity = equity;
    user.awaitingAccount = false;
  }

  setPaused(chatId: number, paused: boolean): void {
    this.getOrCreate(chatId).paused = paused;
  }

  setStrategyEnabled(chatId: number, strategy: StrategyId, enabled: boolean): void {
    const strategies = this.getOrCreate(chatId).enabledStrategies;
    if (enabled) strategies.add(strategy);
    else strategies.delete(strategy);
  }

  isStrategyEnabled(chatId: number, strategy: StrategyId): boolean {
    return this.getOrCreate(chatId).enabledStrategies.has(strategy);
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
