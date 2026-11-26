import { describe, expect, it, vi } from "vitest";
import type { TelegramUpdate } from "./telegram-api.js";
import { TelegramCommandService } from "./commands.js";
import { TelegramPollingBot } from "./bot.js";

describe("Telegram polling bot", () => {
  it("configures Telegram commands, processes updates, and advances the offset", async () => {
    let bot: TelegramPollingBot;
    const update: TelegramUpdate = {
      update_id: 77,
      message: { chat: { id: 9 }, text: "/balance" }
    };
    const sendMessage = vi.fn(async () => {
      bot.stop();
    });
    const getUpdates = vi.fn(async () => [update]);
    const api = {
      deleteWebhook: vi.fn(async () => undefined),
      setMyCommands: vi.fn(async () => undefined),
      setChatMenuButton: vi.fn(async () => undefined),
      getUpdates,
      sendMessage
    };
    const commands = new TelegramCommandService(api);
    bot = new TelegramPollingBot(api, commands, {
      webAppUrl: "https://charts.example/app"
    });

    await bot.run();

    expect(api.deleteWebhook).toHaveBeenCalledOnce();
    expect(api.setMyCommands).toHaveBeenCalledOnce();
    expect(api.setChatMenuButton).toHaveBeenCalledWith(
      "https://charts.example/app",
      expect.any(AbortSignal)
    );
    expect(sendMessage).toHaveBeenCalledWith(
      9,
      "Set your simulated account first with /account.",
      undefined
    );
    expect(getUpdates).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
  });

  it("retries transient startup network failures instead of crashing", async () => {
    let bot: TelegramPollingBot;
    const onError = vi.fn();
    let deleteAttempts = 0;
    const deleteWebhook = vi.fn(async () => {
      deleteAttempts += 1;
      if (deleteAttempts === 1) {
        throw new Error("connect ETIMEDOUT 149.154.166.110:443");
      }
    });
    const getUpdates = vi.fn(async () => {
      bot.stop();
      return [];
    });
    const api = {
      deleteWebhook,
      setMyCommands: vi.fn(async () => undefined),
      setChatMenuButton: vi.fn(async () => undefined),
      getUpdates,
      sendMessage: vi.fn(async () => undefined)
    };
    const commands = new TelegramCommandService(api);
    bot = new TelegramPollingBot(api, commands, { onError });

    await bot.run();

    expect(deleteWebhook).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(api.setMyCommands).toHaveBeenCalledOnce();
    expect(getUpdates).toHaveBeenCalledOnce();
  });
});
