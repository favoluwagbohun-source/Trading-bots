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
});
