export interface TelegramMessage {
  readonly chat: { readonly id: number };
  readonly text?: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

export interface TelegramInlineButton {
  readonly text: string;
  readonly web_app?: { readonly url: string };
  readonly url?: string;
}

export interface TelegramReplyMarkup {
  readonly inline_keyboard: readonly (readonly TelegramInlineButton[])[];
}

export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseUpdate(value: unknown): TelegramUpdate {
  if (!isRecord(value) || !Number.isSafeInteger(value.update_id)) {
    throw new Error("Telegram returned a malformed update");
  }
  const message = value.message;
  if (message === undefined) return { update_id: Number(value.update_id) };
  if (!isRecord(message) || !isRecord(message.chat) ||
      !Number.isSafeInteger(message.chat.id)) {
    throw new Error("Telegram returned a malformed message update");
  }
  return {
    update_id: Number(value.update_id),
    message: {
      chat: { id: Number(message.chat.id) },
      ...(typeof message.text === "string" ? { text: message.text } : {})
    }
  };
}

export class TelegramApiClient {
  private readonly baseUrl: string;

  constructor(
    token: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {
    const normalizedToken = token.trim();
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(normalizedToken)) {
      throw new Error("TELEGRAM_BOT_TOKEN is missing or malformed");
    }
    this.baseUrl = `https://api.telegram.org/bot${normalizedToken}`;
  }

  async deleteWebhook(signal?: AbortSignal): Promise<void> {
    await this.call("deleteWebhook", { drop_pending_updates: false }, signal);
  }

  async setMyCommands(
    commands: readonly TelegramBotCommand[],
    signal?: AbortSignal
  ): Promise<void> {
    await this.call("setMyCommands", { commands }, signal);
  }

  async setChatMenuButton(url: string, signal?: AbortSignal): Promise<void> {
    await this.call("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Open chart",
        web_app: { url }
      }
    }, signal);
  }

  async getUpdates(offset: number | undefined, signal: AbortSignal): Promise<TelegramUpdate[]> {
    const result = await this.call("getUpdates", {
      timeout: 25,
      allowed_updates: ["message"],
      ...(offset === undefined ? {} : { offset })
    }, signal);
    if (!Array.isArray(result)) throw new Error("Telegram returned a malformed updates response");
    return result.map(parseUpdate);
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramReplyMarkup,
    signal?: AbortSignal
  ): Promise<void> {
    if (!Number.isSafeInteger(chatId)) throw new Error("Telegram chat ID must be an integer");
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup })
    }, signal);
  }

  async sendPhoto(
    chatId: number,
    photo: Blob,
    caption: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (!Number.isSafeInteger(chatId)) throw new Error("Telegram chat ID must be an integer");
    if (
      photo.size === 0 ||
      photo.size > 10 * 1024 * 1024 ||
      !["image/png", "image/jpeg"].includes(photo.type)
    ) {
      throw new Error("Telegram chart attachment must be a PNG/JPEG image no larger than 10 MB");
    }
    if (caption.length > 1024) {
      throw new Error("Telegram photo captions cannot exceed 1024 characters");
    }
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("photo", photo, "signal-chart.png");
    form.set("caption", caption);
    await this.call("sendPhoto", form, signal);
  }

  private async call(
    method: string,
    payload: Record<string, unknown> | FormData,
    signal?: AbortSignal
  ): Promise<unknown> {
    const headers = payload instanceof FormData
      ? undefined
      : { "content-type": "application/json" };
    const body = payload instanceof FormData ? payload : JSON.stringify(payload);
    const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: "POST",
      ...(headers === undefined ? {} : { headers }),
      body,
      ...(signal === undefined ? {} : { signal })
    });
    let result: unknown;
    try {
      result = await response.json();
    } catch (error) {
      throw new Error(`Telegram API ${method} returned invalid JSON: ${String(error)}`);
    }
    if (!response.ok || !isRecord(result) || result.ok !== true) {
      const description = isRecord(result) && typeof result.description === "string"
        ? result.description
        : "unknown Telegram API error";
      throw new Error(`Telegram API ${method} failed (HTTP ${response.status}): ${description}`);
    }
    return result.result;
  }
}
