import { describe, expect, it, vi } from "vitest";
import { TelegramApiClient } from "./telegram-api.js";

describe("Telegram Bot API client", () => {
  it("parses long-poll updates and sends the requested offset", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: [{
        update_id: 15,
        message: { chat: { id: 123 }, text: "/start" }
      }]
    })));
    const client = new TelegramApiClient("12345:bot_token", fetchImpl);
    const controller = new AbortController();

    await expect(client.getUpdates(16, controller.signal)).resolves.toEqual([{
      update_id: 15,
      message: { chat: { id: 123 }, text: "/start" }
    }]);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      offset: 16,
      timeout: 25,
      allowed_updates: ["message"]
    });
  });

  it("uploads chart images as multipart photos", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })));
    const client = new TelegramApiClient("12345:bot_token", fetchImpl);

    await client.sendPhoto(123, new Blob(["png"], { type: "image/png" }), "Paper signal");

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("chat_id")).toBe("123");
    expect((init?.body as FormData).get("caption")).toBe("Paper signal");
    expect((init?.body as FormData).get("photo")).toBeInstanceOf(File);
  });

  it("surfaces Bot API rejections without exposing the bot token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      description: "chat not found"
    }), { status: 400 }));
    const client = new TelegramApiClient("12345:bot_token", fetchImpl);

    await expect(client.sendMessage(123, "test")).rejects.toThrow(
      "Telegram API sendMessage failed (HTTP 400): chat not found"
    );
    expect(() => new TelegramApiClient("")).toThrow("TELEGRAM_BOT_TOKEN");
  });
});
