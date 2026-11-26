import type { StrategyId } from "@crypto-signal/shared";
import type {
  TelegramApiClient,
  TelegramMessage,
  TelegramReplyMarkup
} from "./telegram-api.js";
import { TelegramUserStateStore } from "./user-state.js";

const STRATEGIES: readonly {
  readonly id: StrategyId;
  readonly name: string;
  readonly note: string;
}[] = [
  {
    id: "top_down_trendline",
    name: "Top-Down Trendline",
    note: "Prototype; methodology details remain unverified"
  },
  { id: "break_and_retest", name: "Break and Retest", note: "Independent prototype" },
  {
    id: "liquidity_sweep_reversal",
    name: "Liquidity Sweep Reversal",
    note: "Independent prototype"
  },
  { id: "order_block_retest", name: "Order Block Retest", note: "Independent prototype" }
];

export interface TelegramCommandOptions {
  readonly webAppUrl?: string;
  readonly states?: TelegramUserStateStore;
}

function parseAccountAmount(value: string): number | undefined {
  const normalized = value.replace(/[$,]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 10 && amount <= 1_000_000_000_000
    ? amount
    : undefined;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

export class TelegramCommandService {
  readonly states: TelegramUserStateStore;
  private readonly webAppUrl: string | undefined;

  constructor(
    private readonly api: Pick<TelegramApiClient, "sendMessage">,
    options: TelegramCommandOptions = {}
  ) {
    this.states = options.states ?? new TelegramUserStateStore();
    this.webAppUrl = options.webAppUrl;
    if (this.webAppUrl !== undefined) {
      let url: URL;
      try {
        url = new URL(this.webAppUrl);
      } catch {
        throw new Error("TELEGRAM_WEB_APP_URL must be an absolute HTTPS URL");
      }
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("TELEGRAM_WEB_APP_URL must be an absolute HTTPS URL");
      }
    }
  }

  async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = message.chat.id;
    const text = message.text?.trim();
    if (!text) return;

    const [rawCommand, ...args] = text.split(/\s+/);
    if (!rawCommand?.startsWith("/")) {
      if (this.states.get(chatId).awaitingAccount) {
        await this.setAccount(chatId, text);
      }
      return;
    }

    const command = rawCommand.split("@")[0]?.toLowerCase();
    switch (command) {
      case "/start":
        await this.start(chatId);
        break;
      case "/account":
        await this.account(chatId, args.join(" "));
        break;
      case "/balance":
        await this.balance(chatId);
        break;
      case "/signals":
        await this.signals(chatId);
        break;
      case "/performance":
        await this.performance(chatId);
        break;
      case "/strategies":
        await this.strategies(chatId);
        break;
      case "/settings":
        await this.settings(chatId, args);
        break;
      case "/pause":
        await this.pause(chatId);
        break;
      case "/resume":
        await this.resume(chatId);
        break;
      default:
        await this.send(chatId, "Unknown command. Use /start to see the available bot commands.");
    }
  }

  private async start(chatId: number): Promise<void> {
    const state = this.states.get(chatId);
    if (state.accountEquity === undefined) {
      this.states.setAwaitingAccount(chatId, true);
      await this.send(
        chatId,
        "Welcome. Reply with your simulated account size in USD (for example, 1000). Minimum $10. No real orders are placed.",
        this.webAppKeyboard()
      );
      return;
    }
    await this.send(
      chatId,
      `Welcome back. Simulated account: ${formatCurrency(state.accountEquity)}. Commands: /account, /balance, /signals, /performance, /strategies, /settings, /pause, /resume.`,
      this.webAppKeyboard()
    );
  }

  private async account(chatId: number, amountText: string): Promise<void> {
    if (!amountText) {
      this.states.setAwaitingAccount(chatId, true);
      await this.send(chatId, "Send your simulated account size in USD (minimum $10).");
      return;
    }
    await this.setAccount(chatId, amountText);
  }

  private async setAccount(chatId: number, amountText: string): Promise<void> {
    const amount = parseAccountAmount(amountText);
    if (amount === undefined) {
      await this.send(chatId, "Enter a valid USD amount from $10 to $1,000,000,000,000.");
      return;
    }
    this.states.setAccountEquity(chatId, amount);
    await this.send(
      chatId,
      `Simulated account set to ${formatCurrency(amount)}. Fixed risk budget: ${formatCurrency(amount * 0.01)} per trade (1%).`
    );
  }

  private async balance(chatId: number): Promise<void> {
    const equity = this.states.get(chatId).accountEquity;
    if (equity === undefined) {
      await this.send(chatId, "Set your simulated account first with /account.");
      return;
    }
    await this.send(
      chatId,
      `Simulated balance: ${formatCurrency(equity)}\nFixed 1% risk budget: ${formatCurrency(equity * 0.01)}.`
    );
  }

  private async signals(chatId: number): Promise<void> {
    const state = this.states.get(chatId);
    if (state.paused) {
      await this.send(chatId, "Signal delivery is paused for this chat. Use /resume to re-enable it.");
      return;
    }
    await this.send(
      chatId,
      "No active paper signals are tracked yet. The scanner produces setup candidates and chart images separately; Telegram publication stays disabled until portfolio-risk checks, quality grading, durable trade tracking, and end-to-end chart delivery are connected."
    );
  }

  private async performance(chatId: number): Promise<void> {
    await this.send(
      chatId,
      "No completed paper trades have been recorded for this chat. Performance figures will appear after trades are tracked; no results are estimated or fabricated."
    );
  }

  private async strategies(chatId: number): Promise<void> {
    const state = this.states.get(chatId);
    const descriptions = STRATEGIES.map((strategy) => {
      const enabled = state.enabledStrategies.includes(strategy.id);
      return `${enabled ? "ON" : "OFF"} · ${strategy.name} — ${strategy.note}`;
    });
    await this.send(chatId, `Independent strategy prototypes:\n${descriptions.join("\n")}`);
  }

  private async settings(chatId: number, args: readonly string[]): Promise<void> {
    if (args.length === 0) {
      const state = this.states.get(chatId);
      const settings = STRATEGIES.map(({ id, name }) =>
        `${name}: ${state.enabledStrategies.includes(id) ? "on" : "off"}`
      );
      await this.send(
        chatId,
        `Per-chat signal delivery: ${state.paused ? "paused" : "active"}\n${settings.join("\n")}\nToggle with /settings <strategy_id> on|off.`
      );
      return;
    }

    const strategy = STRATEGIES.find(({ id }) =>
      id === args[0] || id.replaceAll("_", "-") === args[0]
    );
    const enabled = args[1]?.toLowerCase();
    if (!strategy || (enabled !== "on" && enabled !== "off") || args.length !== 2) {
      await this.send(
        chatId,
        `Usage: /settings <strategy_id> on|off\nStrategies: ${STRATEGIES.map(({ id }) => id).join(", ")}`
      );
      return;
    }
    this.states.setStrategyEnabled(chatId, strategy.id, enabled === "on");
    await this.send(chatId, `${strategy.name} signal preference set to ${enabled}.`);
  }

  private async pause(chatId: number): Promise<void> {
    this.states.setPaused(chatId, true);
    await this.send(chatId, "Signal delivery paused for this chat. Existing paper trades are not closed.");
  }

  private async resume(chatId: number): Promise<void> {
    this.states.setPaused(chatId, false);
    await this.send(chatId, "Signal delivery resumed for this chat.");
  }

  private async send(
    chatId: number,
    text: string,
    replyMarkup?: TelegramReplyMarkup
  ): Promise<void> {
    await this.api.sendMessage(chatId, text, replyMarkup);
  }

  private webAppKeyboard(): TelegramReplyMarkup | undefined {
    if (!this.webAppUrl) return undefined;
    return {
      inline_keyboard: [[{
        text: "Open market chart",
        web_app: { url: this.webAppUrl }
      }]]
    };
  }
}
