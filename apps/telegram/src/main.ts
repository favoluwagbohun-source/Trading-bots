import { TelegramPollingBot } from "./bot.js";
import { TelegramCommandService } from "./commands.js";
import { TelegramApiClient } from "./telegram-api.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN in the environment before starting the bot");

const webAppUrl = process.env.TELEGRAM_WEB_APP_URL;
const api = new TelegramApiClient(token);
const commands = new TelegramCommandService(api, {
  ...(webAppUrl === undefined ? {} : { webAppUrl })
});
const bot = new TelegramPollingBot(api, commands, {
  ...(webAppUrl === undefined ? {} : { webAppUrl }),
  onError: (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Telegram polling error:", message.split(token).join("[REDACTED]"));
  }
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
await bot.run();
