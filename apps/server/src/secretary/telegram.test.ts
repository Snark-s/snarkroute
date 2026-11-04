import { describe, expect, it, vi } from "vitest";
import { TelegramChannel, telegramConfigFromEnv } from "./telegram";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWX";

describe("D2: Telegram door to the Secretary", () => {
  it("stays off without a well-formed token and the owner's chat id", () => {
    expect(telegramConfigFromEnv({})).toBeUndefined();
    expect(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: "x", TELEGRAM_OWNER_CHAT_ID: "42" })).toBeUndefined();
    expect(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_CHAT_ID: "42" })).toEqual({ token: TOKEN, chatId: "42" });
  });

  it("takes goals only from the owner's chat, replies there and never echoes the token", async () => {
    const sent: Array<{ chat_id: string; text: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/getUpdates")) return new Response(JSON.stringify({ ok: true, result: [
        { update_id: 7, message: { message_id: 1, chat: { id: 42 }, text: "/goal Найти заказ на анимацию" } },
        { update_id: 8, message: { message_id: 2, chat: { id: 99 }, text: "чужой" } },
        { update_id: 9, message: { message_id: 3, chat: { id: 42 }, text: "/start" } }] }));
      sent.push(body);
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as unknown as typeof fetch;
    const channel = new TelegramChannel({ token: TOKEN, chatId: "42" }, fetchImpl);
    const goals: Array<[string, string]> = [];
    expect(await channel.pollOnce(async (text, key) => { goals.push([text, key]); return "Цель принята"; }, 0)).toBe(1);
    expect(goals).toEqual([["Найти заказ на анимацию", "tg:7"]]);
    expect(sent).toEqual([{ chat_id: "42", text: "Цель принята", disable_web_page_preview: true }]);

    const failing = new TelegramChannel({ token: TOKEN, chatId: "42" }, (async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch);
    await expect(failing.send("x")).rejects.toThrow("Telegram sendMessage: Unauthorized");
    await expect(failing.send("x")).rejects.not.toThrow(TOKEN);
  });
});
