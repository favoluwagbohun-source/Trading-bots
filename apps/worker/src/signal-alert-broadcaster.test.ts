import { describe, expect, it, vi } from "vitest";
import type { MarketTimeframe } from "@crypto-signal/market-data";
import type { Candle } from "@crypto-signal/shared";
import { TelegramUserStateStore } from "@crypto-signal/telegram";
import { SignalAlertBroadcaster } from "./signal-alert-broadcaster.js";
import type { SignalCandidate } from "./signal-scanner.js";

function makeTrendCandles(
  count: number,
  stepMs: number,
  startTime: number,
  withFinalExpansion = false
): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const openTime = startTime + index * stepMs;
    const isFinal = withFinalExpansion && index === count - 1;
    const base = 100 + index * 0.5;
    const open = base;
    const close = isFinal ? base + 6 : base + 0.4;
    const low = base - 0.3;
    const high = isFinal ? close + 0.2 : base + 0.6;
    return {
      openTime,
      closeTime: openTime + stepMs - 1,
      open: String(open),
      high: String(high),
      low: String(low),
      close: String(close),
      volume: String(isFinal ? 35 : 10),
      closed: true
    };
  });
}

function makeCandidate(): SignalCandidate {
  const candles = makeTrendCandles(24, 300_000, 1_800_000, false);
  const signalCandle = candles.at(-1)!;
  const snapshotId = `BTCUSDT:5m:${signalCandle.openTime}`;
  return {
    signalId: "BTCUSDT:top_down_trendline:bounce:8700000",
    snapshotId,
    symbol: "BTCUSDT",
    strategy: "top_down_trendline",
    side: "buy",
    signalCandle,
    entryCandleOpenTime: signalCandle.closeTime + 1,
    entryPrice: Number(signalCandle.close),
    stopLoss: Number(signalCandle.close) - 4,
    target1: Number(signalCandle.close) + 6,
    target2: Number(signalCandle.close) + 12,
    target3: "trailing_runner",
    minimumRiskReward: 3,
    higherTimeframeBias: "1M:bullish, 1W:bullish, 1D:bullish, 4H:bullish, 1H:bullish",
    chartCandles: candles,
    chartAnnotations: {
      trendline: {
        id: "ascending-1-2",
        qualifyingTouchCount: 4,
        anchorA: { openTime: 1_800_000, price: 99 },
        anchorB: { openTime: 2_100_000, price: 100 }
      },
      levels: [],
      zones: []
    },
    analysisSnapshot: {
      snapshotId,
      symbol: "BTCUSDT",
      analysisTime: signalCandle.closeTime,
      signalCandle,
      nextExecutionCandle: null,
      timeframes: {
        "5m": { candles }
      } as unknown as SignalCandidate["analysisSnapshot"]["timeframes"]
    }
  };
}

describe("SignalAlertBroadcaster", () => {
  it("broadcasts approved live signals to registered users without duplicating paper-claimed chats", async () => {
    const users = new TelegramUserStateStore();
    users.ensureRegistered(101);
    users.ensureRegistered(102);
    users.ensureRegistered(103);
    users.setPaused(103, true);

    const candidate = makeCandidate();
    users.claimNotificationEvent(102, `signal:${candidate.signalId}`);

    const sendPhoto = vi.fn(async () => undefined);
    const broadcaster = new SignalAlertBroadcaster({
      api: { sendPhoto },
      users,
      evidence: {
        top_down_trendline: {
          maximumSupportedGrade: "A",
          source: "deterministic-engine-v1"
        }
      }
    });

    const sent = await broadcaster.processCandidate(candidate);

    expect(sent).toBe(1);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendPhoto.mock.calls[0]?.[0]).toBe(101);
    const caption = sendPhoto.mock.calls[0]?.[2];
    expect(caption).toContain("LIVE SIGNAL · BTCUSDT — BUY");
    expect(caption).toContain("SL (Stop Loss):");
    expect(caption).toContain("Take Profit TP1:");
    expect(caption).toContain("Take Profit TP2:");
    expect(caption).toContain("Take Profit TP3:");
    expect(broadcaster.getLatestLiveSignals()).toHaveLength(1);
  });

  it("evaluates quantitative consistency signals across timeframes, sends chart alerts once, and updates /quant feed", async () => {
    const users = new TelegramUserStateStore();
    users.ensureRegistered(501);

    const candles1h = makeTrendCandles(30, 3_600_000, 1_700_000_000_000, true);
    const latestClose = candles1h.at(-1)!.closeTime;
    const datasets = new Map<MarketTimeframe, readonly Candle[]>([
      ["5m", makeTrendCandles(30, 300_000, latestClose - 30 * 300_000 + 1, false)],
      ["1h", candles1h],
      ["4h", makeTrendCandles(20, 14_400_000, latestClose - 20 * 14_400_000 + 1, false)]
    ]);

    const sendPhoto = vi.fn(async () => undefined);
    const broadcaster = new SignalAlertBroadcaster({
      api: { sendPhoto },
      users,
      evidence: {},
      now: () => latestClose + 60_000
    });

    const firstSent = await broadcaster.processDatasets("BTCUSDT", datasets);
    const secondSent = await broadcaster.processDatasets("BTCUSDT", datasets);

    expect(firstSent).toBeGreaterThanOrEqual(1);
    expect(secondSent).toBe(0);
    expect(sendPhoto.mock.calls[0]?.[0]).toBe(501);
    expect(sendPhoto.mock.calls[0]?.[1]).toBeInstanceOf(Blob);
    expect(sendPhoto.mock.calls[0]?.[2]).toContain("QUANT SIGNAL · BTCUSDT (1H) — BUY");
    expect(broadcaster.getLatestQuantSignals().length).toBeGreaterThanOrEqual(1);
  });

  it("sends deduplicated Telegram breakout expectation notices when price tests near a key level", async () => {
    const users = new TelegramUserStateStore();
    users.ensureRegistered(6886426545);

    const stepMs = 300_000;
    const start = 1_700_000_000_000;
    // Build candles with an established swing high around 104, then price pressing up to 103.85 (within 0.45%)
    const closes = [100, 101, 103, 104, 102, 100.5, 100, 101, 102, 103, 103.5, 103.85];
    const execCandles: Candle[] = closes.map((close, idx) => {
      const openTime = start + idx * stepMs;
      const prevClose = idx === 0 ? 99.5 : closes[idx - 1]!;
      const high = idx === 3 ? 104 : Math.max(prevClose, close) + 0.1;
      const low = Math.min(prevClose, close) - 0.1;
      return {
        openTime,
        closeTime: openTime + stepMs - 1,
        open: String(prevClose),
        high: String(high),
        low: String(low),
        close: String(close),
        volume: "15",
        closed: true
      };
    });
    const latestClose = execCandles.at(-1)!.closeTime;
    const datasets = new Map<MarketTimeframe, readonly Candle[]>([
      ["5m", execCandles],
      ["1h", makeTrendCandles(15, 3_600_000, latestClose - 15 * 3_600_000 + 1, false)],
      ["4h", makeTrendCandles(15, 14_400_000, latestClose - 15 * 14_400_000 + 1, false)],
      ["1d", makeTrendCandles(15, 86_400_000, latestClose - 15 * 86_400_000 + 1, false)]
    ]);

    const sendPhoto = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => undefined);
    const broadcaster = new SignalAlertBroadcaster({
      api: { sendPhoto, sendMessage },
      users,
      evidence: {},
      executionTimeframe: "5m",
      now: () => latestClose + 10_000
    });

    const firstCount = await broadcaster.processDatasets("BTCUSDT", datasets);
    const secondCount = await broadcaster.processDatasets("BTCUSDT", datasets);

    expect(firstCount).toBeGreaterThanOrEqual(1);
    expect(secondCount).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(6886426545);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("BREAKOUT NOTICE · BTCUSDT (1D → 5M)");
    expect(sendMessage.mock.calls[0]?.[1]).toContain("Expecting possible BUY breakout position.");
    expect(broadcaster.getLatestBreakoutNotices()).toHaveLength(1);
  });
});
