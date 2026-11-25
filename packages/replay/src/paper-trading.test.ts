import { describe, expect, it } from "vitest";
import type { Candle } from "@crypto-signal/shared";
import { ManualPaperTradingLedger } from "./paper-trading.js";
import { CandleReplaySession } from "./replay-session.js";

function candle(index: number, values: {
  open: number;
  high: number;
  low: number;
  close: number;
}): Candle {
  const openTime = 6_000_000 + index * 300_000;
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

const instrument = {
  quantityStep: 0.01,
  minimumQuantity: 0.01,
  maximumQuantity: 1000,
  minimumNotional: 1,
  contractMultiplier: 1
};
const costs = { feeRatePerSide: 0, slippageRatePerSide: 0 };
const tradeRequest = {
  signalId: "manual-1",
  symbol: "BTCUSDT",
  side: "buy" as const,
  stopPrice: 95,
  target2Price: 115,
  instrument,
  costs
};

describe("manual paper trading", () => {
  it("opens from the visible replay close and processes stop before targets", () => {
    const replay = new CandleReplaySession({
      symbol: "BTCUSDT",
      timeframe: "5m",
      candles: [
        candle(0, { open: 100, high: 101, low: 99, close: 100 }),
        candle(1, { open: 100, high: 120, low: 94, close: 110 }),
        candle(2, { open: 110, high: 111, low: 109, close: 110 })
      ]
    });
    const ledger = new ManualPaperTradingLedger("BTCUSDT", 1000);
    const initial = replay.snapshot();
    const opened = ledger.openManualTrade(initial, tradeRequest);
    expect(opened).toMatchObject({
      status: "open",
      entryTime: initial.currentCandle.closeTime,
      entryPrice: 100,
      riskAmount: 10
    });
    expect(ledger.advance(initial)[0]!.events).toHaveLength(1);

    const next = replay.stepForward();
    const closed = ledger.advance(next)[0]!;
    expect(closed.status).toBe("closed");
    expect(closed.events.at(-1)).toMatchObject({
      kind: "closed",
      reason: "stop_loss",
      price: 95
    });
    expect(ledger.advance(next)[0]!.events).toHaveLength(closed.events.length);
    expect(ledger.balance).toBeLessThan(1000);
  });

  it("prevents duplicate and simultaneous same-symbol paper trades", () => {
    const replay = new CandleReplaySession({
      symbol: "BTCUSDT",
      timeframe: "5m",
      candles: [candle(0, { open: 100, high: 101, low: 99, close: 100 })]
    });
    const ledger = new ManualPaperTradingLedger("BTCUSDT", 1000);
    ledger.openManualTrade(replay.snapshot(), tradeRequest);

    expect(() => ledger.openManualTrade(replay.snapshot(), {
      ...tradeRequest,
      signalId: "manual-2"
    })).toThrow("Only one open");
    expect(() => ledger.openManualTrade(replay.snapshot(), tradeRequest))
      .toThrow("Duplicate");
    expect(() => ledger.setBalance(2000)).toThrow("while paper trades are open");
  });

  it("supports manual close and account balance updates after closure", () => {
    const replay = new CandleReplaySession({
      symbol: "BTCUSDT",
      timeframe: "5m",
      candles: [
        candle(0, { open: 100, high: 101, low: 99, close: 100 }),
        candle(1, { open: 101, high: 104, low: 100, close: 103 })
      ]
    });
    const ledger = new ManualPaperTradingLedger("BTCUSDT", 1000);
    ledger.openManualTrade(replay.snapshot(), tradeRequest);
    const next = replay.stepForward();
    const closed = ledger.closeManualTrade("manual-1", next);

    expect(closed.status).toBe("closed");
    expect(closed.events.at(-1)?.reason).toBe("manual_close");
    ledger.setBalance(250);
    expect(ledger.balance).toBe(250);
  });
});
