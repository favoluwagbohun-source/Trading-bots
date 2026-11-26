import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { PaperTradeLedger } from "./paper-trade-ledger.js";

const temporaryDirectories: string[] = [];

function createLedgerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "paper-trade-ledger-"));
  temporaryDirectories.push(directory);
  return join(directory, "trades.json");
}

function candle(
  index: number,
  values: { open: number; high: number; low: number; close: number }
): Candle {
  const openTime = index * 300_000;
  return {
    openTime,
    closeTime: openTime + 299_999,
    open: String(values.open),
    high: String(values.high),
    low: String(values.low),
    close: String(values.close),
    volume: "10",
    closed: true
  };
}

function openInput(entryCandleOpenTime = 600_000) {
  return {
    signalId: "signal-1",
    snapshotId: "BTCUSDT:5m:300000",
    chatId: 7,
    symbol: "btcusdt",
    strategy: "break_and_retest" as const,
    side: "buy" as const,
    entryPrice: 100,
    stopLoss: 90,
    target1: 115,
    target2: 130,
    quantity: 1,
    notional: 100,
    plannedRisk: 10,
    correlationGroup: "crypto",
    contractMultiplier: 1,
    feeRatePerSide: 0,
    slippageRatePerSide: 0,
    entryCandleOpenTime,
    trailingSwingLeftBars: 1,
    trailingSwingRightBars: 1
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PaperTradeLedger", () => {
  it("persists active trades and idempotent TP, trailing-stop, and close events across restarts", () => {
    const filePath = createLedgerPath();
    const ledger = new PaperTradeLedger({ filePath });
    ledger.openTrade(openInput());

    const history = [
      candle(0, { open: 100, high: 102, low: 95, close: 100 }),
      candle(1, { open: 100, high: 103, low: 97, close: 102 }),
      candle(2, { open: 102, high: 108, low: 98, close: 105 }),
      candle(3, { open: 105, high: 112, low: 105, close: 110 }),
      candle(4, { open: 110, high: 116, low: 104, close: 115 }),
      candle(5, { open: 115, high: 131, low: 108, close: 130 })
    ];
    const created = ledger.processClosedCandles("BTCUSDT", history);

    expect(created.map(({ type }) => type)).toContain("trailing_stop_moved");
    expect(created.map(({ type }) => type)).toContain("tp1_reached");
    expect(created.map(({ type }) => type)).toContain("tp2_reached");
    expect(ledger.getActiveTrades(7)[0]).toMatchObject({
      status: "active",
      target1Reached: true,
      target2Reached: true,
      remainingQuantity: expect.closeTo(1 / 3),
      stopPrice: 104,
      realizedPnl: 15
    });

    const restarted = new PaperTradeLedger({ filePath });
    expect(restarted.processClosedCandles("BTCUSDT", history)).toEqual([]);
    const exitCandle = candle(6, { open: 125, high: 133, low: 103, close: 120 });
    const exitEvents = restarted.processClosedCandles("BTCUSDT", [exitCandle]);
    expect(exitEvents.map(({ type }) => type)).toEqual([
      "tp3_reached",
      "stop_loss_reached",
      "trade_closed"
    ]);
    expect(restarted.getActiveTrades()).toEqual([]);
    expect(restarted.getTrade(7, "signal-1")?.realizedPnl).toBeGreaterThan(0);
    expect(restarted.processClosedCandles("BTCUSDT", [exitCandle])).toEqual([]);

    const tp1Event = restarted.getEvents().find(({ type }) => type === "tp1_reached")!;
    expect(restarted.claimEventDelivery(tp1Event.eventId)).toBe(true);
    const secondRestart = new PaperTradeLedger({ filePath });
    expect(secondRestart.claimEventDelivery(tp1Event.eventId)).toBe(false);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("uses conservative stop-first ordering when a candle touches both stop and target", () => {
    const ledger = new PaperTradeLedger({ filePath: createLedgerPath() });
    ledger.openTrade(openInput(0));
    const events = ledger.processClosedCandles("BTCUSDT", [
      candle(0, { open: 100, high: 102, low: 95, close: 100 }),
      candle(1, { open: 100, high: 132, low: 89, close: 125 })
    ]);

    expect(events.map(({ type }) => type)).toEqual([
      "stop_loss_reached",
      "trade_closed"
    ]);
    expect(ledger.getTrade(7, "signal-1")?.realizedPnl).toBe(-10);
    expect(ledger.getEvents().some(({ type }) => type === "tp1_reached")).toBe(false);
  });

  it("rejects candle gaps and persists explicit setup invalidations without inventing a price", () => {
    const ledger = new PaperTradeLedger({ filePath: createLedgerPath() });
    ledger.processClosedCandles("BTCUSDT", [
      candle(0, { open: 100, high: 102, low: 95, close: 100 })
    ]);

    expect(() => ledger.processClosedCandles("BTCUSDT", [
      candle(2, { open: 100, high: 102, low: 95, close: 100 })
    ])).toThrow("Missing 5-minute candles");
    expect(ledger.invalidateSetup({
      signalId: "invalidated-signal",
      chatId: 7,
      symbol: "BTCUSDT",
      occurredAt: 900_000,
      snapshotId: "BTCUSDT:5m:600000",
      details: "The setup was invalidated before entry."
    })).toBe(true);

    const event = ledger.getEvents().find(({ type }) => type === "setup_invalidated");
    expect(event?.price).toBeUndefined();
    expect(ledger.invalidateSetup({
      signalId: "invalidated-signal",
      chatId: 7,
      symbol: "BTCUSDT",
      occurredAt: 900_000,
      snapshotId: "BTCUSDT:5m:600000",
      details: "The setup was invalidated before entry."
    })).toBe(false);
    expect(() => ledger.openTrade({
      ...openInput(1_200_000),
      signalId: "invalidated-signal"
    })).toThrow("already been opened or invalidated");
  });
});
