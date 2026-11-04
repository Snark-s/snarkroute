import { describe, expect, it, vi } from "vitest";
import { TelegramChannel, telegramConfigFromEnv, type TelegramSettings } from "./telegram";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWX";

function fakeTelegram(updates: unknown[] = []) {
  const sent: Array<{ chat_id: string; text: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/getMe")) return new Response(JSON.stringify({ ok: true, result: { username: "snark_secretary_bot" } }));
    if (url.endsWith("/getUpdates")) return new Response(JSON.stringify({ ok: true, result: updates.splice(0) }));
    sent.push(body);
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

describe("D2: the Secretary's Telegram bot", () => {
  it("reads the legacy env pair only when well formed", () => {
    expect(telegramConfigFromEnv({})).toBeUndefined();
    expect(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: "x", TELEGRAM_OWNER_CHAT_ID: "42" })).toBeUndefined();
    expect(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_CHAT_ID: "42" })).toEqual({ token: TOKEN, chatId: "42" });
  });

  it("pairs only the chat that sends the code, then takes goals only from it", async () => {
    const updates: unknown[] = [];
    const { sent, fetchImpl } = fakeTelegram(updates);
    let saved: TelegramSettings | undefined;
    await expect(TelegramChannel.connect("not-a-token", { fetch: fetchImpl })).rejects.toThrow(/токен/);
    const channel = await TelegramChannel.connect(TOKEN, { fetch: fetchImpl, save: async settings => { saved = settings && { ...settings }; } });
    const code = channel.status().pairingCode!;
    expect(channel.status()).toMatchObject({ botName: "snark_secretary_bot", paired: false });
    expect(JSON.stringify(channel.status())).not.toContain(TOKEN);

    const goals: Array<[string, string]> = [];
    const onGoal = async (text: string, key: string) => { goals.push([text, key]); return "Цель принята"; };
    updates.push({ update_id: 1, message: { message_id: 1, chat: { id: 99 }, text: "/start 000000" } },
      { update_id: 2, message: { message_id: 2, chat: { id: 42 }, text: `/start ${code}` } });
    await channel.pollOnce(onGoal, 0);
    expect(channel.status()).toMatchObject({ paired: true, pairingCode: null });
    expect(saved?.chatId).toBe("42");

    updates.push({ update_id: 3, message: { message_id: 3, chat: { id: 42 }, text: "/goal Найти заказ на анимацию" } },
      { update_id: 4, message: { message_id: 4, chat: { id: 99 }, text: "чужой" } });
    expect(await channel.pollOnce(onGoal, 0)).toBe(1);
    expect(goals).toEqual([["Найти заказ на анимацию", "tg:3"]]);
    // A stranger only ever gets the request for the code, never the code itself and never goal replies.
    expect(sent.filter(message => message.chat_id !== "42").map(message => message.text)).toEqual([expect.stringMatching(/шестизначный код/)]);
    expect(sent.some(message => message.text.includes(code))).toBe(false);
  });

  it("merges notes and sends at most one message per interval", async () => {
    vi.useFakeTimers();
    try {
      const { sent, fetchImpl } = fakeTelegram();
      let now = 0;
      const channel = new TelegramChannel({ token: TOKEN, chatId: "42", minIntervalMinutes: 15 }, { fetch: fetchImpl, now: () => now });
      channel.notify("первое"); channel.notify("второе");
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain("первое");
      expect(sent[0].text).toContain("второе");
      now = 60_000; channel.notify("третье");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sent).toHaveLength(1);
      now = 15 * 60_000; await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(sent).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});
