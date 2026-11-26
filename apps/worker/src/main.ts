import { BinanceRestClient } from "@crypto-signal/market-data";
import {
  TelegramApiClient,
  TelegramCommandService,
  TelegramPollingBot,
  TelegramUserStateStore
} from "@crypto-signal/telegram";
import type { PortfolioLimits, TradingCosts } from "@crypto-signal/risk-engine";
import { ApprovedPaperSignalCoordinator } from "./approved-paper-signal-coordinator.js";
import { recoverMissingCandles } from "./candle-recovery.js";
import {
  HeartbeatPinger,
  parseHeartbeatIntervalMs,
  resolveHeartbeatUrl
} from "./heartbeat-pinger.js";
import { PaperTradeLedger } from "./paper-trade-ledger.js";
import { SignalAlertBroadcaster } from "./signal-alert-broadcaster.js";
import { scoreSignalQuality, type SignalGrade, type StrategyQualityEvidence } from "./signal-quality.js";
import { SignalScanner, type SignalCandidate } from "./signal-scanner.js";
import { WorkerHealthStore } from "./worker-health.js";

const DEFAULT_QUALITY_EVIDENCE: Partial<Record<SignalCandidate["strategy"], StrategyQualityEvidence>> = {
  top_down_trendline: { maximumSupportedGrade: "A", source: "deterministic-engine-v1" },
  break_and_retest: { maximumSupportedGrade: "A", source: "deterministic-engine-v1" },
  liquidity_sweep_reversal: { maximumSupportedGrade: "A", source: "deterministic-engine-v1" },
  order_block_retest: { maximumSupportedGrade: "A", source: "deterministic-engine-v1" }
};

function parseWatchlist(value: string | undefined): string[] {
  if (!value) throw new Error("Set WATCHLIST_SYMBOLS to a comma-separated Binance symbol list");
  return value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
}

function parseScanInterval(value: string | undefined): number {
  if (value === undefined) return 30_000;
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval < 5_000) {
    throw new Error("SCAN_INTERVAL_MS must be an integer of at least 5000");
  }
  return interval;
}

function configuredNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return parsed;
}

function configuredInteger(name: string, defaultValue: number): number {
  const parsed = configuredNumber(name, defaultValue);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function requiredRate(name: string): number {
  const value = process.env[name];
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1) {
    throw new Error(`${name} must be configured as a rate from 0 inclusive to 1 exclusive`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrategyId(value: string): value is SignalCandidate["strategy"] {
  return [
    "top_down_trendline",
    "break_and_retest",
    "liquidity_sweep_reversal",
    "order_block_retest"
  ].includes(value);
}

function isSignalGrade(value: unknown): value is SignalGrade {
  return value === "A" || value === "B" || value === "C" || value === "D";
}

function parseDefaultChatIds(value: string | undefined): number[] {
  if (!value || !value.trim()) return [];
  const ids: number[] = [];
  for (const raw of value.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const chatId = Number(trimmed);
    if (!Number.isSafeInteger(chatId)) {
      throw new Error(`Invalid chat ID in TELEGRAM_DEFAULT_CHAT_ID: ${trimmed}`);
    }
    ids.push(chatId);
  }
  return ids;
}

function parseQualityEvidence(
  value: string | undefined
): Partial<Record<SignalCandidate["strategy"], StrategyQualityEvidence>> {
  if (!value || !value.trim()) return { ...DEFAULT_QUALITY_EVIDENCE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`STRATEGY_QUALITY_EVIDENCE must be valid JSON: ${String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("STRATEGY_QUALITY_EVIDENCE must be an object keyed by strategy ID");
  }
  const result: Partial<Record<SignalCandidate["strategy"], StrategyQualityEvidence>> = {};
  for (const [strategy, evidence] of Object.entries(parsed)) {
    if (!isStrategyId(strategy)) {
      throw new Error(`Unknown strategy in STRATEGY_QUALITY_EVIDENCE: ${strategy}`);
    }
    if (!isRecord(evidence)) {
      throw new Error(`Malformed quality evidence for ${strategy}`);
    }
    if (
      !isSignalGrade(evidence.maximumSupportedGrade) ||
      typeof evidence.source !== "string" ||
      !evidence.source.trim()
    ) {
      throw new Error(`Malformed quality evidence for ${strategy}`);
    }
    result[strategy] = {
      maximumSupportedGrade: evidence.maximumSupportedGrade,
      source: evidence.source
    };
  }
  return result;
}

function snapshotLastProcessedOpenTimes(
  symbols: readonly string[],
  ledger: PaperTradeLedger
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const symbol of symbols) {
    const openTime = ledger.getLastProcessedOpenTime(symbol);
    if (openTime !== undefined) result[symbol] = openTime;
  }
  return result;
}

const controller = new AbortController();
const watchlist = parseWatchlist(process.env.WATCHLIST_SYMBOLS);
const scanIntervalMs = parseScanInterval(process.env.SCAN_INTERVAL_MS);
const marketData = new BinanceRestClient();
const tradeLedger = new PaperTradeLedger({
  filePath: process.env.PAPER_TRADES_PATH?.trim() || "./data/paper-trades.json"
});
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const statePath = process.env.TELEGRAM_STATE_PATH?.trim() || "./data/telegram-state.json";
const workerHealthPath = process.env.WORKER_HEALTH_PATH?.trim() || "./data/worker-health.json";
const states = token ? new TelegramUserStateStore({ filePath: statePath }) : undefined;
const api = token ? new TelegramApiClient(token) : undefined;
const workerHealth = new WorkerHealthStore({
  filePath: workerHealthPath,
  watchlist,
  scanIntervalMs,
  telegramConfigured: Boolean(token),
  secrets: token ? [token] : []
});
const qualityEvidence = parseQualityEvidence(process.env.STRATEGY_QUALITY_EVIDENCE);
const portfolioLimits: PortfolioLimits = {
  maximumOpenTrades: configuredInteger("PAPER_MAX_OPEN_TRADES", 3),
  maximumDailyLossPercent: configuredNumber("PAPER_MAX_DAILY_LOSS_PERCENT", 2),
  maximumWeeklyLossPercent: configuredNumber("PAPER_MAX_WEEKLY_LOSS_PERCENT", 6),
  maximumGrossExposurePercent: configuredNumber("PAPER_MAX_GROSS_EXPOSURE_PERCENT", 100),
  maximumOpenTradesPerCorrelationGroup: configuredInteger("PAPER_MAX_OPEN_PER_GROUP", 1)
};
let coordinator: ApprovedPaperSignalCoordinator | undefined;
let broadcaster: SignalAlertBroadcaster | undefined;
let bot: TelegramPollingBot | undefined;

const pendingNotificationCount = (): number =>
  tradeLedger.getEvents({ deliveryStatus: "pending" }).length;

if (states && api) {
  for (const defaultChatId of parseDefaultChatIds(process.env.TELEGRAM_DEFAULT_CHAT_ID)) {
    states.ensureRegistered(defaultChatId);
    console.info(`Pre-registered Telegram chat ${defaultChatId} for live signal alerts.`);
  }
  const costs: TradingCosts = {
    feeRatePerSide: requiredRate("PAPER_FEE_RATE_PER_SIDE"),
    slippageRatePerSide: requiredRate("PAPER_SLIPPAGE_RATE_PER_SIDE")
  };
  coordinator = new ApprovedPaperSignalCoordinator({
    api,
    users: states,
    ledger: tradeLedger,
    marketData,
    costs,
    limits: portfolioLimits,
    evidence: qualityEvidence,
    correlationGroupForSymbol: () => "crypto",
    onRejected: (chatId, candidate, reason) => {
      const owner = chatId === undefined ? "all opted-in users" : `chat ${chatId}`;
      console.info(`Paper entry rejected for ${owner}: ${candidate.signalId}: ${reason}.`);
    },
    onDeliverySuccess: () => {
      workerHealth.recordTelegramDeliverySuccess(pendingNotificationCount());
    },
    onDeliveryError: (eventId, error) => {
      const message = error instanceof Error ? error.message : String(error);
      const safeMessage = token ? message.split(token).join("[REDACTED]") : message;
      console.error(`Telegram delivery failed for ${eventId}: ${safeMessage}`);
      workerHealth.recordTelegramDeliveryError(error, pendingNotificationCount());
    }
  });
  broadcaster = new SignalAlertBroadcaster({
    api,
    users: states,
    evidence: qualityEvidence,
    onDeliverySuccess: () => {
      workerHealth.recordTelegramDeliverySuccess(pendingNotificationCount());
    },
    onDeliveryError: (eventId, error) => {
      const message = error instanceof Error ? error.message : String(error);
      const safeMessage = token ? message.split(token).join("[REDACTED]") : message;
      console.error(`Telegram live alert failed for ${eventId}: ${safeMessage}`);
      workerHealth.recordTelegramDeliveryError(error, pendingNotificationCount());
    }
  });
  const commands = new TelegramCommandService(api, {
    ...(process.env.TELEGRAM_WEB_APP_URL === undefined
      ? {}
      : { webAppUrl: process.env.TELEGRAM_WEB_APP_URL }),
    states,
    hasPaperTradeHistory: (chatId) => coordinator!.hasTradeHistory(chatId),
    getPaperEquity: (chatId, startingEquity) =>
      coordinator!.getEquity(chatId, startingEquity),
    getActivePaperTrades: (chatId) => coordinator!.getActiveTrades(chatId),
    getPaperPerformance: (chatId, startingEquity) =>
      coordinator!.getPerformance(chatId, startingEquity),
    getQuantSignals: () => broadcaster!.getLatestQuantSignals(),
    getLiveSignals: () => broadcaster!.getLatestLiveSignals()
  });
  bot = new TelegramPollingBot(api, commands, {
    ...(process.env.TELEGRAM_WEB_APP_URL === undefined
      ? {}
      : { webAppUrl: process.env.TELEGRAM_WEB_APP_URL }),
    onPollSuccess: () => {
      workerHealth.recordTelegramPollSuccess(pendingNotificationCount());
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const safeMessage = token ? message.split(token).join("[REDACTED]") : message;
      console.error("Telegram polling error:", safeMessage);
      workerHealth.recordTelegramPollError(error, pendingNotificationCount());
    }
  });
} else {
  console.info("Telegram is not configured; scanner candidates will only be logged.");
}
if (Object.keys(qualityEvidence).length === 0) {
  console.warn("No strategy validation evidence configured; automatic paper entries will be quality-gated.");
}

async function processClosedCandles(
  symbol: string,
  candles: readonly import("@crypto-signal/shared").Candle[]
): Promise<void> {
  if (coordinator) {
    await coordinator.processClosedCandles(symbol, candles);
    return;
  }
  for (const event of tradeLedger.processClosedCandles(symbol, candles)) {
    console.info(
      `Paper-trade event pending: ${event.symbol} ${event.type} for signal ${event.signalId}.`
    );
  }
}

const scanner = new SignalScanner({
  symbols: watchlist,
  client: marketData,
  scanIntervalMs,
  onScanStart: () => {
    workerHealth.recordScanStarted();
  },
  onMarketDataSuccess: () => {
    workerHealth.recordMarketDataSuccess(marketData.skippedNoTradeCandleCount);
  },
  onCandidate: async (candidate) => {
    const quality = scoreSignalQuality(candidate, qualityEvidence[candidate.strategy]);
    console.info(
      `Candidate detected: ${candidate.symbol} ${candidate.strategy} ${candidate.side} at ${candidate.signalCandle.closeTime}; setup score ${quality.score}/100, grade ${quality.strategyGrade}; Telegram eligible: ${quality.publishEligible}.`
    );
    if (coordinator) await coordinator.processCandidate(candidate);
    if (broadcaster) await broadcaster.processCandidate(candidate);
  },
  onCandles: processClosedCandles,
  onDatasets: async (symbol, datasets) => {
    if (broadcaster) await broadcaster.processDatasets(symbol, datasets);
  },
  onError: (symbol, error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Scan failed for ${symbol}: ${message}`);
    workerHealth.recordMarketDataError(error, marketData.skippedNoTradeCandleCount);
  },
  onScanComplete: ({ hadError, lastError }) => {
    workerHealth.recordScanCompleted({
      lastProcessedOpenTimeBySymbol: snapshotLastProcessedOpenTimes(watchlist, tradeLedger),
      activePaperTradeCount: tradeLedger.getActiveTrades().length,
      pendingEventCount: pendingNotificationCount(),
      hadSymbolErrors: hadError,
      lastError
    });
  }
});

function shutdown(): void {
  workerHealth.markSleeping();
  controller.abort();
  bot?.stop();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

const recovery = await recoverMissingCandles({
  symbols: watchlist,
  marketData,
  getLastProcessedOpenTime: (symbol) => tradeLedger.getLastProcessedOpenTime(symbol),
  onCandles: processClosedCandles,
  onInfo: (message) => console.info(message),
  onError: (symbol, error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Startup candle recovery failed for ${symbol}: ${message}`);
    workerHealth.recordMarketDataError(error, marketData.skippedNoTradeCandleCount);
  }
});
workerHealth.recordRecoveryComplete({
  lastProcessedOpenTimeBySymbol: snapshotLastProcessedOpenTimes(watchlist, tradeLedger),
  activePaperTradeCount: tradeLedger.getActiveTrades().length,
  pendingEventCount: pendingNotificationCount(),
  hadError: recovery.hadError,
  lastError: recovery.lastError
});

const heartbeatUrl = resolveHeartbeatUrl(process.env);
const heartbeatIntervalMs = parseHeartbeatIntervalMs(process.env.HEARTBEAT_INTERVAL_MS);
const heartbeatPinger = heartbeatUrl
  ? new HeartbeatPinger({
      targetUrl: heartbeatUrl,
      intervalMs: heartbeatIntervalMs,
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const safeMessage = token ? message.split(token).join("[REDACTED]") : message;
        console.warn(`Heartbeat ping failed (${heartbeatUrl}): ${safeMessage}`);
      }
    })
  : undefined;

if (heartbeatPinger && heartbeatUrl) {
  console.info(`Worker heartbeat pinger enabled for ${heartbeatUrl} every ${heartbeatIntervalMs}ms.`);
}

const tasks: Promise<void>[] = [scanner.run(controller.signal)];
if (bot) tasks.push(bot.run());
if (heartbeatPinger) tasks.push(heartbeatPinger.run(controller.signal));
await Promise.all(tasks);
