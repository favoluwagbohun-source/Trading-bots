import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const STRATEGIES = [
  "top_down_trendline",
  "break_and_retest",
  "liquidity_sweep_reversal",
  "order_block_retest"
] as const;
type Strategy = typeof STRATEGIES[number];

export interface PaperDashboardOptions {
  readonly botToken: string;
  readonly telegramStatePath: string;
  readonly paperTradesPath: string;
  readonly now?: () => number;
}

export interface PaperDashboardData {
  readonly account: {
    readonly startingEquity: number | null;
    readonly currentEquity: number | null;
    readonly realizedPnl: number;
    readonly activeTradeCount: number;
  };
  readonly settings: {
    readonly paused: boolean;
    readonly paperTradingEnabled: boolean;
    readonly enabledStrategies: readonly Strategy[];
  };
  readonly activeTrades: readonly PaperDashboardTrade[];
  readonly history: readonly PaperDashboardTrade[];
  readonly strategyPerformance: readonly {
    readonly strategy: Strategy;
    readonly closedTrades: number;
    readonly wins: number;
    readonly realizedPnl: number;
  }[];
}

export interface PaperDashboardTrade {
  readonly signalId: string;
  readonly symbol: string;
  readonly strategy: Strategy;
  readonly side: "buy" | "sell";
  readonly status: "active" | "closed";
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly target1: number;
  readonly target2: number;
  readonly realizedPnl: number;
  readonly openedAt: number;
  readonly closedAt: number | null;
}

interface TelegramIdentity {
  readonly chatId: number;
}

export class TelegramAuthorizationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStrategy(value: unknown): value is Strategy {
  return STRATEGIES.some((strategy) => strategy === value);
}

function verifyTelegramInitData(
  initData: string,
  botToken: string,
  now: number
): TelegramIdentity {
  if (!initData || initData.length > 8192) {
    throw new TelegramAuthorizationError("Invalid Telegram authorization");
  }
  const params = new URLSearchParams(initData);
  const hashes = params.getAll("hash");
  const authDates = params.getAll("auth_date");
  const users = params.getAll("user");
  if (hashes.length !== 1 || authDates.length !== 1 || users.length !== 1) {
    throw new TelegramAuthorizationError("Invalid Telegram authorization");
  }
  const receivedHash = hashes[0]!;
  if (!/^[\da-f]{64}$/i.test(receivedHash)) {
    throw new TelegramAuthorizationError("Invalid Telegram authorization");
  }

  const authDate = Number(authDates[0]);
  const currentSeconds = Math.floor(now / 1000);
  if (
    !Number.isSafeInteger(authDate) ||
    authDate > currentSeconds + 60 ||
    currentSeconds - authDate > 86_400
  ) {
    throw new TelegramAuthorizationError("Expired Telegram authorization");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest();
  const providedHash = Buffer.from(receivedHash, "hex");
  if (!timingSafeEqual(expectedHash, providedHash)) {
    throw new TelegramAuthorizationError("Invalid Telegram authorization");
  }

  let user: unknown;
  try {
    user = JSON.parse(users[0]!);
  } catch {
    throw new TelegramAuthorizationError("Invalid Telegram authorization");
  }
  if (
    !isRecord(user) ||
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0
  ) {
    throw new TelegramAuthorizationError("Invalid Telegram authorization");
  }
  return { chatId: user.id };
}

async function readJson(path: string, allowMissing: boolean): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (allowMissing && isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Dashboard data file contains invalid JSON: ${String(error)}`);
  }
}

function getUserState(value: unknown, chatId: number): {
  accountEquity: number | null;
  paused: boolean;
  paperTradingEnabled: boolean;
  enabledStrategies: Strategy[];
} {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !isRecord(value.users)
  ) {
    throw new Error("Telegram state file has an unsupported or malformed schema");
  }
  const persisted = value.users[String(chatId)];
  if (persisted === undefined) {
    return {
      accountEquity: null,
      paused: false,
      paperTradingEnabled: false,
      enabledStrategies: [...STRATEGIES]
    };
  }
  if (
    !isRecord(persisted) ||
    typeof persisted.awaitingAccount !== "boolean" ||
    typeof persisted.paused !== "boolean" ||
    (persisted.paperTradingEnabled !== undefined &&
      typeof persisted.paperTradingEnabled !== "boolean") ||
    !Array.isArray(persisted.enabledStrategies) ||
    !persisted.enabledStrategies.every(isStrategy) ||
    (persisted.accountEquity !== undefined &&
      (!finite(persisted.accountEquity) ||
        persisted.accountEquity < 10 ||
        persisted.accountEquity > 1_000_000_000_000))
  ) {
    throw new Error("Telegram user state is malformed");
  }
  return {
    accountEquity: finite(persisted.accountEquity) ? persisted.accountEquity : null,
    paused: persisted.paused,
    paperTradingEnabled: persisted.paperTradingEnabled === true,
    enabledStrategies: persisted.enabledStrategies
  };
}

function parseTrades(value: unknown, chatId: number): PaperDashboardTrade[] {
  if (value === undefined) return [];
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.trades)) {
    throw new Error("Paper-trade ledger has an unsupported or malformed schema");
  }
  const trades: PaperDashboardTrade[] = [];
  for (const trade of value.trades) {
    if (!isRecord(trade) || trade.chatId !== chatId) continue;
    if (
      typeof trade.signalId !== "string" ||
      typeof trade.symbol !== "string" ||
      !isStrategy(trade.strategy) ||
      (trade.side !== "buy" && trade.side !== "sell") ||
      (trade.status !== "active" && trade.status !== "closed") ||
      !finite(trade.entryPrice) ||
      !finite(trade.stopPrice) ||
      !finite(trade.target1) ||
      !finite(trade.target2) ||
      !finite(trade.realizedPnl) ||
      !finite(trade.entryCandleOpenTime) ||
      (trade.closedAt !== undefined && !finite(trade.closedAt))
    ) {
      throw new Error("Paper-trade ledger contains a malformed user trade");
    }
    trades.push({
      signalId: trade.signalId,
      symbol: trade.symbol,
      strategy: trade.strategy,
      side: trade.side,
      status: trade.status,
      entryPrice: trade.entryPrice,
      stopPrice: trade.stopPrice,
      target1: trade.target1,
      target2: trade.target2,
      realizedPnl: trade.realizedPnl,
      openedAt: trade.entryCandleOpenTime,
      closedAt: finite(trade.closedAt) ? trade.closedAt : null
    });
  }
  return trades;
}

export async function getPaperDashboard(
  options: PaperDashboardOptions,
  initData: string
): Promise<PaperDashboardData> {
  const identity = verifyTelegramInitData(
    initData,
    options.botToken,
    options.now?.() ?? Date.now()
  );
  const [stateFile, ledgerFile] = await Promise.all([
    readJson(options.telegramStatePath, false),
    readJson(options.paperTradesPath, true)
  ]);
  const state = getUserState(stateFile, identity.chatId);
  const trades = parseTrades(ledgerFile, identity.chatId)
    .sort((left, right) => (right.closedAt ?? right.openedAt) - (left.closedAt ?? left.openedAt));
  const realizedPnl = trades.reduce((total, trade) => total + trade.realizedPnl, 0);
  if (!Number.isFinite(realizedPnl)) throw new Error("Paper-trade PnL is outside the supported range");
  const activeTrades = trades.filter((trade) => trade.status === "active");
  const strategyPerformance = STRATEGIES.map((strategy) => {
    const closedTrades = trades.filter((trade) =>
      trade.strategy === strategy && trade.status === "closed"
    );
    return {
      strategy,
      closedTrades: closedTrades.length,
      wins: closedTrades.filter((trade) => trade.realizedPnl > 0).length,
      realizedPnl: closedTrades.reduce((total, trade) => total + trade.realizedPnl, 0)
    };
  });
  const currentEquity = state.accountEquity === null ? null : state.accountEquity + realizedPnl;
  if (currentEquity !== null && !Number.isFinite(currentEquity)) {
    throw new Error("Paper-trading equity is outside the supported range");
  }
  return {
    account: {
      startingEquity: state.accountEquity,
      currentEquity,
      realizedPnl,
      activeTradeCount: activeTrades.length
    },
    settings: {
      paused: state.paused,
      paperTradingEnabled: state.paperTradingEnabled,
      enabledStrategies: state.enabledStrategies
    },
    activeTrades,
    history: trades.slice(0, 100),
    strategyPerformance
  };
}
