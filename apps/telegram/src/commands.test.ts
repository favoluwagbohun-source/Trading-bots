import { describe, expect, it, vi } from "vitest";
import type { TelegramReplyMarkup } from "./telegram-api.js";
import { TelegramCommandService } from "./commands.js";

describe("Telegram chat commands", () => {
  it("collects account size, reports the fixed risk budget, and offers the Mini App", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const commands = new TelegramCommandService({ sendMessage }, {
      webAppUrl: "https://charts.example/app"
    });

    await commands.handleMessage({ chat: { id: 42 }, text: "/start" });
    expect(sendMessage.mock.calls[0]?.[1]).toContain("simulated account size");
    expect(sendMessage.mock.calls[0]?.[2]).toEqual({
      inline_keyboard: [
        [{
          text: "Open market chart",
          web_app: { url: "https://charts.example/app" }
        }],
        [{
          text: "Open in Browser ↗",
          url: "https://charts.example/app"
        }]
      ]
    } satisfies TelegramReplyMarkup);

    await commands.handleMessage({ chat: { id: 42 }, text: "$1,000" });
    await commands.handleMessage({ chat: { id: 42 }, text: "/balance" });

    expect(sendMessage.mock.calls[1]?.[1]).toContain("$1,000");
    expect(sendMessage.mock.calls[1]?.[1]).toContain("$10");
    expect(sendMessage.mock.calls[2]?.[1]).toContain("Fixed 1% risk budget");
  });

  it("rejects invalid account amounts and keeps the account prompt active", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const commands = new TelegramCommandService({ sendMessage });

    await commands.handleMessage({ chat: { id: 3 }, text: "/account" });
    await commands.handleMessage({ chat: { id: 3 }, text: "9" });

    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("from $10");
    expect(commands.states.get(3).awaitingAccount).toBe(true);
    expect(commands.states.get(3).accountEquity).toBeUndefined();
  });

  it("keeps strategy preferences and pause state isolated per chat", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const commands = new TelegramCommandService({ sendMessage });

    await commands.handleMessage({
      chat: { id: 1 },
      text: "/settings break_and_retest off"
    });
    await commands.handleMessage({ chat: { id: 1 }, text: "/pause" });
    await commands.handleMessage({ chat: { id: 1 }, text: "/signals" });
    await commands.handleMessage({ chat: { id: 2 }, text: "/signals" });

    expect(commands.states.isStrategyEnabled(1, "break_and_retest")).toBe(false);
    expect(commands.states.isStrategyEnabled(2, "break_and_retest")).toBe(true);
    expect(sendMessage.mock.calls.at(-2)?.[1]).toContain("delivery is paused");
    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("No active paper signals");
  });

  it("requires a balance before opting in and respects explicit paper on/off choices", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const commands = new TelegramCommandService({ sendMessage });

    await commands.handleMessage({ chat: { id: 8 }, text: "/paper on" });
    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("Set your simulated account balance");
    expect(commands.states.get(8).paperTradingEnabled).toBe(false);

    await commands.handleMessage({ chat: { id: 8 }, text: "/account 2500" });
    await commands.handleMessage({ chat: { id: 8 }, text: "/paper on" });
    expect(commands.states.get(8).paperTradingEnabled).toBe(true);
    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("turned on");

    await commands.handleMessage({ chat: { id: 8 }, text: "/paper off" });
    expect(commands.states.get(8).paperTradingEnabled).toBe(false);
    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("Existing paper trades will continue");
  });

  it("reports recorded simulated performance without estimating unobserved results", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const commands = new TelegramCommandService({ sendMessage }, {
      getPaperPerformance: () => ({
        currentEquity: 1015,
        completedTrades: 4,
        activeTrades: 1,
        realizedPnl: 15,
        winRatePercent: 50
      })
    });
    await commands.handleMessage({ chat: { id: 8 }, text: "/account 1000" });
    await commands.handleMessage({ chat: { id: 8 }, text: "/performance" });

    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("Completed trades: 4");
    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("Realized PnL: $15.00");
    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("Win rate: 50.0%");
  });

  it("reports quantitative consistency signals on /quant and respects pause state", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const commands = new TelegramCommandService({ sendMessage }, {
      getQuantSignals: () => [
        {
          id: "BTCUSDT:1h:1700000000000:buy",
          timestamp: 1_700_003_599_999,
          symbol: "BTCUSDT",
          timeframe: "1h",
          strategy: "break_and_retest",
          side: "buy",
          entryPrice: 95000,
          stopLoss: 94200,
          target1: 96200,
          target2: 97000,
          riskRewardRatio: 2.0,
          consistencyScore: 84,
          expectancyScore: 1.52,
          confidence: "moderate",
          rationale: "Deterministic quantitative momentum confirmation on 1h."
        }
      ]
    });

    await commands.handleMessage({ chat: { id: 12 }, text: "/quant" });
    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("BTCUSDT (1H) — BUY");
    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("Consistency: 84%");

    await commands.handleMessage({ chat: { id: 12 }, text: "/pause" });
    await commands.handleMessage({ chat: { id: 12 }, text: "/quant" });
    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("delivery is paused");
  });

  it("rejects insecure Telegram Mini App URLs", () => {
    const sendMessage = vi.fn(async () => undefined);
    expect(() => new TelegramCommandService({ sendMessage }, {
      webAppUrl: "http://charts.example"
    })).toThrow("absolute HTTPS URL");
  });
});
