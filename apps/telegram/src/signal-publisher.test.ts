import { describe, expect, it, vi } from "vitest";
import { TelegramSignalPublisher, type PreparedPaperSignal } from "./signal-publisher.js";
import { TelegramUserStateStore } from "./user-state.js";

const signal: PreparedPaperSignal = {
  signalId: "signal-1",
  snapshotId: "market-snapshot-1",
  symbol: "BTCUSDT",
  side: "buy",
  strategy: "top_down_trendline",
  higherTimeframeBias: "BULLISH",
  entryPrice: 100,
  stopLoss: 90,
  target1: 115,
  target2: 130,
  target3: "trailing_runner",
  quantity: 0.1,
  estimatedMaximumLoss: 9.5,
  minimumRiskReward: 3,
  qualityScore: 82,
  strategyGrade: "B"
};
const chart = {
  snapshotId: "market-snapshot-1",
  image: new Blob(["png"], { type: "image/png" })
};

describe("Telegram photo signal publisher", () => {
  it("sends a fully-qualified paper signal with its matching chart image once", async () => {
    const users = new TelegramUserStateStore();
    users.setAccountEquity(9, 1000);
    const sendPhoto = vi.fn(async () => undefined);
    const publisher = new TelegramSignalPublisher({ sendPhoto }, users);

    await expect(publisher.publishSignal(9, signal, chart)).resolves.toBe(true);
    await expect(publisher.publishSignal(9, signal, chart)).resolves.toBe(false);

    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendPhoto.mock.calls[0]?.[2]).toContain("Status: PAPER TRADE ACTIVE");
    expect(sendPhoto.mock.calls[0]?.[2]).toContain("Signal quality: 82/100");
    expect(sendPhoto.mock.calls[0]?.[1]).toBe(chart.image);
  });

  it("rejects mismatched charts, low grades, and risk beyond one percent", async () => {
    const users = new TelegramUserStateStore();
    users.setAccountEquity(9, 1000);
    const sendPhoto = vi.fn(async () => undefined);
    const publisher = new TelegramSignalPublisher({ sendPhoto }, users);

    await expect(publisher.publishSignal(9, signal, {
      ...chart,
      snapshotId: "different-snapshot"
    })).rejects.toThrow("same market snapshot");
    await expect(publisher.publishSignal(9, {
      ...signal,
      strategyGrade: "C"
    }, chart)).rejects.toThrow("quality, risk, or position validation");
    await expect(publisher.publishSignal(9, {
      ...signal,
      estimatedMaximumLoss: 10.01
    }, chart)).rejects.toThrow("quality, risk, or position validation");
    expect(sendPhoto).not.toHaveBeenCalled();
  });

  it("honours per-chat preferences and does not retry an event with uncertain delivery", async () => {
    const users = new TelegramUserStateStore();
    users.setAccountEquity(9, 1000);
    const sendPhoto = vi.fn()
      .mockRejectedValueOnce(new Error("Telegram is unavailable"))
      .mockResolvedValue(undefined);
    const publisher = new TelegramSignalPublisher({ sendPhoto }, users);

    await expect(publisher.publishSignal(9, signal, chart))
      .rejects.toThrow("Telegram is unavailable");
    await expect(publisher.publishSignal(9, signal, chart)).resolves.toBe(false);
    await expect(publisher.publishSignal(9, signal, chart)).resolves.toBe(false);

    users.setStrategyEnabled(9, "top_down_trendline", false);
    await expect(publisher.publishSignal(9, {
      ...signal,
      signalId: "signal-2"
    }, chart)).resolves.toBe(false);
    users.setStrategyEnabled(9, "top_down_trendline", true);
    users.setPaused(9, true);
    await expect(publisher.publishSignal(9, {
      ...signal,
      signalId: "signal-3"
    }, chart)).resolves.toBe(false);
    expect(sendPhoto).toHaveBeenCalledOnce();
  });
});
