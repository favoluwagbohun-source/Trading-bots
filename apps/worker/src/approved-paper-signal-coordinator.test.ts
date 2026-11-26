import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { TelegramUserStateStore } from "@crypto-signal/telegram";
import { PaperTradeLedger } from "./paper-trade-ledger.js";
import {
  ApprovedPaperSignalCoordinator,
  type ApprovedPaperSignalCoordinatorOptions
} from "./approved-paper-signal-coordinator.js";
import type { SignalCandidate } from "./signal-scanner.js";
import { scoreSignalQuality } from "./signal-quality.js";

const temporaryDirectories: string[] = [];

function createLedgerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "approved-paper-signal-"));
  temporaryDirectories.push(directory);
  return join(directory, "trades.json");
}

function candidate(): SignalCandidate {
  const candles: Candle[] = Array.from({ length: 30 }, (_, index) => {
    const openTime = index * 300_000;
    const open = 100 + index;
    return {
      openTime,
      closeTime: openTime + 299_999,
      open: String(open),
      high: String(open + 2),
      low: String(open),
      close: String(open + 1.8),
      volume: index === 29 ? "50" : "10",
      closed: true
    };
  });
  const signalCandle = candles.at(-1)!;
  return {
    signalId: "BTCUSDT:break_and_retest:8700000",
    snapshotId: `BTCUSDT:5m:${signalCandle.openTime}`,
    symbol: "BTCUSDT",
    strategy: "break_and_retest",
    side: "buy",
    signalCandle,
    entryCandleOpenTime: signalCandle.closeTime + 1,
    entryPrice: 131,
    stopLoss: 120,
    target1: 145,
    target2: 160,
    target3: "trailing_runner",
    minimumRiskReward: 2,
    higherTimeframeBias: "1M:bullish, 1W:bullish, 1D:bullish, 4H:bullish, 1H:bullish",
    chartCandles: candles,
    chartAnnotations: {
      trendline: {
        id: "4h-line",
        qualifyingTouchCount: 4,
        anchorA: { openTime: 0, price: 100 },
        anchorB: { openTime: 3_000_000, price: 110 }
      },
      levels: [{ label: "Confirmed level", price: 125 }],
      zones: []
    }
  };
}

function coordinatorOptions(
  overrides: Partial<ApprovedPaperSignalCoordinatorOptions> = {}
): {
  readonly options: ApprovedPaperSignalCoordinatorOptions;
  readonly sendPhoto: ReturnType<typeof vi.fn>;
  readonly users: TelegramUserStateStore;
  readonly ledger: PaperTradeLedger;
} {
  const sendPhoto = vi.fn(async () => undefined);
  const users = new TelegramUserStateStore();
  const ledger = new PaperTradeLedger({ filePath: createLedgerPath() });
  return {
    options: {
      api: { sendPhoto },
      users,
      ledger,
      marketData: {
        getInstrumentRules: async () => ({
          quantityStep: 0.001,
          minimumQuantity: 0.001,
          maximumQuantity: 1000,
          minimumNotional: 5,
          contractMultiplier: 1
        })
      },
      costs: { feeRatePerSide: 0.0001, slippageRatePerSide: 0.0001 },
      limits: {
        maximumOpenTrades: 3,
        maximumDailyLossPercent: 2,
        maximumWeeklyLossPercent: 6,
        maximumGrossExposurePercent: 100,
        maximumOpenTradesPerCorrelationGroup: 1
      },
      evidence: {
        break_and_retest: {
          maximumSupportedGrade: "B",
          source: "verified test evidence"
        }
      },
      correlationGroupForSymbol: () => "crypto",
      onRejected: vi.fn(),
      ...overrides
    },
    sendPhoto,
    users,
    ledger
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ApprovedPaperSignalCoordinator", () => {
  it("opens and publishes a quality- and risk-approved signal for opted-in chats", async () => {
    const signal = candidate();
    const setupQuality = scoreSignalQuality(signal, {
      maximumSupportedGrade: "B",
      source: "verified test evidence"
    });
    expect(setupQuality.publishEligible).toBe(true);

    const { options, sendPhoto, users, ledger } = coordinatorOptions();
    users.setAccountEquity(42, 1000);
    users.setPaperTradingEnabled(42, true);
    users.setStrategyEnabled(43, "break_and_retest", false);
    users.setAccountEquity(43, 1000);
    users.setPaperTradingEnabled(43, true);
    const coordinator = new ApprovedPaperSignalCoordinator(options);

    await coordinator.processCandidate(signal);

    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendPhoto.mock.calls[0]?.[0]).toBe(42);
    expect(ledger.getActiveTrades(42)).toMatchObject([{
      signalId: signal.signalId,
      strategy: "break_and_retest",
      notional: expect.any(Number),
      plannedRisk: expect.any(Number)
    }]);
    expect(ledger.getActiveTrades(43)).toEqual([]);
    expect(ledger.getEvents({ chatId: 42 })[0]?.deliveryStatus).toBe("delivered");
    const restarted = new ApprovedPaperSignalCoordinator(options);
    expect(restarted.getEquity(42, 1000)).toBe(1000);
    expect(restarted.getActiveTrades(42)).toHaveLength(1);
  });

  it("does not open a candidate without validation evidence or user opt-in", async () => {
    const { options, sendPhoto, users, ledger } = coordinatorOptions({
      evidence: {}
    });
    users.setAccountEquity(42, 1000);
    users.setPaperTradingEnabled(42, true);
    const coordinator = new ApprovedPaperSignalCoordinator(options);

    await coordinator.processCandidate(candidate());
    expect(ledger.getTrades()).toEqual([]);
    expect(sendPhoto).not.toHaveBeenCalled();

    const optedOut = coordinatorOptions();
    optedOut.users.setAccountEquity(43, 1000);
    await new ApprovedPaperSignalCoordinator(optedOut.options).processCandidate(candidate());
    expect(optedOut.ledger.getTrades()).toEqual([]);
    expect(optedOut.sendPhoto).not.toHaveBeenCalled();
  });

  it("releases ledger event claim and reports delivery error when Telegram send fails", async () => {
    const onDeliveryError = vi.fn();
    const { options, users, ledger } = coordinatorOptions({
      api: {
        sendPhoto: vi.fn(async () => {
          throw new Error("Telegram temporary outage");
        })
      },
      onDeliveryError
    });
    users.setAccountEquity(42, 1000);
    users.setPaperTradingEnabled(42, true);
    const coordinator = new ApprovedPaperSignalCoordinator(options);

    await expect(coordinator.processCandidate(candidate())).resolves.toBeUndefined();

    expect(onDeliveryError).toHaveBeenCalledOnce();
    expect(ledger.getEvents({ chatId: 42 })[0]).toMatchObject({
      deliveryStatus: "pending",
      retryCount: 1
    });
  });
});
