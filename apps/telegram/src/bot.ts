import type { TelegramCommandService } from "./commands.js";
import {
  type TelegramApiClient,
  type TelegramBotCommand,
  type TelegramUpdate
} from "./telegram-api.js";

const BOT_COMMANDS: readonly TelegramBotCommand[] = [
  { command: "start", description: "Set up your simulated account" },
  { command: "account", description: "Set or update simulated account size" },
  { command: "balance", description: "View balance and fixed 1% risk budget" },
  { command: "signals", description: "View active paper signals" },
  { command: "performance", description: "View recorded paper-trade results" },
  { command: "strategies", description: "View independent strategy status" },
  { command: "settings", description: "Configure per-chat strategy preferences" },
  { command: "pause", description: "Pause signal delivery to this chat" },
  { command: "resume", description: "Resume signal delivery to this chat" }
];

export interface TelegramPollingBotOptions {
  readonly webAppUrl?: string;
  readonly onError?: (error: unknown) => void;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class TelegramPollingBot {
  private controller: AbortController | undefined;
  private offset: number | undefined;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly api: Pick<
      TelegramApiClient,
      "deleteWebhook" | "setMyCommands" | "setChatMenuButton" | "getUpdates"
    >,
    private readonly commands: TelegramCommandService,
    private readonly options: TelegramPollingBotOptions = {}
  ) {
    this.onError = options.onError ?? ((error) => console.error("Telegram bot error", error));
  }

  async run(): Promise<void> {
    if (this.controller) throw new Error("Telegram polling bot is already running");
    const controller = new AbortController();
    this.controller = controller;
    try {
      await this.api.deleteWebhook(controller.signal);
      await this.api.setMyCommands(BOT_COMMANDS, controller.signal);
      if (this.options.webAppUrl) {
        await this.api.setChatMenuButton(this.options.webAppUrl, controller.signal);
      }

      let delay = 1000;
      while (!controller.signal.aborted) {
        try {
          const updates = await this.api.getUpdates(this.offset, controller.signal);
          delay = 1000;
          if (updates.length === 0) {
            await abortableDelay(250, controller.signal);
            continue;
          }
          for (const update of updates) {
            if (controller.signal.aborted) break;
            await this.processUpdate(update);
            this.offset = update.update_id + 1;
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          this.onError(error);
          await abortableDelay(delay, controller.signal);
          delay = Math.min(delay * 2, 30_000);
        }
      }
    } finally {
      this.controller = undefined;
    }
  }

  stop(): void {
    this.controller?.abort();
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) await this.commands.handleMessage(update.message);
  }
}

export { BOT_COMMANDS };
