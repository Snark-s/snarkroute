import { randomInt } from "node:crypto";
import type { AgentOpsStore } from "../agent-ops/store";

/**
 * D2: the Secretary's own Telegram bot. The owner pastes the bot token in the Workshop; the bot is then
 * bound to his chat by a one-time code he sends it. Only that chat may give goals. Messages to the owner
 * are batched (at most one message per interval) so the bot does not chatter. The token is never
 * logged or returned by any API.
 */
export type TelegramSettings = { token: string; botName?: string; chatId?: string; pairingCode?: string; minIntervalMinutes?: number };
type Update = { update_id: number; message?: { message_id: number; chat: { id: number | string }; text?: string } };
type Fetch = typeof fetch;

const TOKEN = /^\d+:[\w-]{20,}$/;

export function telegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { token: string; chatId: string } | undefined {
  const token = env.TELEGRAM_BOT_TOKEN?.trim(), chatId = env.TELEGRAM_OWNER_CHAT_ID?.trim();
  return token && chatId && TOKEN.test(token) && /^-?\d+$/.test(chatId) ? { token, chatId } : undefined;
}

export class TelegramChannel {
  private offset = 0;
  private stopped = true;
  private lastError = "";
  private pending: string[] = [];
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private flushTimer?: NodeJS.Timeout;

  constructor(private settings: TelegramSettings, private readonly deps: { fetch?: Fetch; save?: (settings: TelegramSettings | undefined) => Promise<void>; now?: () => number } = {}) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private async api<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const response = await (this.deps.fetch ?? fetch)(`https://api.telegram.org/bot${this.settings.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await response.json() as { ok: boolean; result?: T; description?: string };
    // The URL holds the token: report the method and Telegram's description only.
    if (!response.ok || !data.ok) throw new Error(`Telegram ${method}: ${data.description ?? `HTTP ${response.status}`}`);
    return data.result as T;
  }

  /** Checks the token with Telegram and starts a pairing: the owner sends the code to the bot. */
  static async connect(token: string, deps: { fetch?: Fetch; save?: (settings: TelegramSettings | undefined) => Promise<void>; now?: () => number } = {}): Promise<TelegramChannel> {
    const trimmed = token.trim();
    if (!TOKEN.test(trimmed)) throw new Error("Это не похоже на токен бота: он выглядит как 123456789:AA… (выдаёт BotFather).");
    const channel = new TelegramChannel({ token: trimmed, pairingCode: String(randomInt(100000, 999999)) }, deps);
    const me = await channel.api<{ username?: string }>("getMe", {});
    channel.settings.botName = me.username;
    await deps.save?.(channel.settings);
    return channel;
  }

  status() {
    return { configured: true, botName: this.settings.botName ?? null, paired: Boolean(this.settings.chatId), pairingCode: this.settings.chatId ? null : this.settings.pairingCode ?? null,
      minIntervalMinutes: this.interval() / 60_000, queued: this.pending.length, error: this.lastError || null };
  }

  private interval(): number { return Math.max(1, Math.min(24 * 60, this.settings.minIntervalMinutes ?? 15)) * 60_000; }

  async setInterval(minutes: number): Promise<void> {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error("Интервал: от 1 минуты до суток.");
    this.settings.minIntervalMinutes = Math.round(minutes);
    await this.deps.save?.(this.settings);
  }

  private async sendNow(text: string): Promise<void> {
    if (!this.settings.chatId) return;
    await this.api("sendMessage", { chat_id: this.settings.chatId, text: text.slice(0, 3900), disable_web_page_preview: true });
  }

  /** Queues a note to the owner; notes are merged and sent at most once per interval. */
  notify(text: string): void {
    if (!this.settings.chatId) return;
    this.pending.push(text);
    const wait = Math.max(0, this.lastSentAt + this.interval() - this.now());
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), wait);
      this.flushTimer.unref?.();
    }
  }

  async flush(): Promise<void> {
    this.flushTimer = undefined;
    if (!this.pending.length) return;
    const batch = this.pending.splice(0, this.pending.length);
    this.lastSentAt = this.now();
    await this.sendNow(batch.join("\n\n———\n\n")).catch(error => { this.lastError = error instanceof Error ? error.message : String(error); });
  }

  /** One long-poll round: pairs the owner's chat by code, then takes his text messages as goals. */
  async pollOnce(onGoal: (text: string, requestKey: string) => Promise<string>, timeoutSeconds = 25): Promise<number> {
    const updates = await this.api<Update[]>("getUpdates", { offset: this.offset, timeout: timeoutSeconds, allowed_updates: ["message"] }, (timeoutSeconds + 10) * 1000);
    let taken = 0;
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      const message = update.message;
      if (!message?.text) continue;
      const chat = String(message.chat.id);
      if (!this.settings.chatId) {
        // Pairing: only the code shown in the Workshop binds a chat; anything else is ignored silently.
        const code = message.text.replace(/^\/start\s*/i, "").trim();
        if (this.settings.pairingCode && code === this.settings.pairingCode) {
          this.settings.chatId = chat; this.settings.pairingCode = undefined;
          await this.deps.save?.(this.settings);
          await this.sendNow("Готово: я бот Секретаря. Пиши сюда цели — я разложу их на этапы и раздам агентам. Сюда же буду присылать, когда нужен ты, и утреннюю сводку.").catch(() => undefined);
        }
        continue;
      }
      if (chat !== this.settings.chatId) continue;
      const text = message.text.replace(/^\/(goal|цель)(@\w+)?\s*/i, "").trim();
      if (!text || text.startsWith("/")) continue;
      const reply = await onGoal(text, `tg:${update.update_id}`).catch(error => `Не приняла: ${error instanceof Error ? error.message : String(error)}`);
      await this.sendNow(reply).catch(() => undefined);
      taken += 1;
    }
    return taken;
  }

  start(onGoal: (text: string, requestKey: string) => Promise<string>): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      while (!this.stopped) {
        try { await this.pollOnce(onGoal); this.lastError = ""; }
        catch (error) { this.lastError = error instanceof Error ? error.message : String(error); await new Promise(resolve => setTimeout(resolve, 30_000)); }
      }
    };
    void loop();
  }

  stop(): void { this.stopped = true; if (this.flushTimer) clearTimeout(this.flushTimer); this.flushTimer = undefined; }
}

/** Keeps the bot settings in the agent-ops store (git-ignored, like the agent token secret). */
export class SecretaryTelegram {
  channel?: TelegramChannel;
  constructor(private readonly deps: { store: AgentOpsStore; onGoal: (text: string, requestKey: string) => Promise<string>; fetch?: Fetch }) {}

  private save = (settings: TelegramSettings | undefined) => this.deps.store.writeState("telegram-bot", settings ?? {});

  async init(): Promise<void> {
    const saved = await this.deps.store.readState<Partial<TelegramSettings>>("telegram-bot", {});
    const env = telegramConfigFromEnv();
    const settings = saved.token ? saved as TelegramSettings : env ? { token: env.token, chatId: env.chatId } : undefined;
    if (settings) { this.channel = new TelegramChannel(settings, { fetch: this.deps.fetch, save: this.save }); this.channel.start(this.deps.onGoal); }
  }

  status() { return this.channel?.status() ?? { configured: false }; }

  async connect(token: string) {
    const next = await TelegramChannel.connect(token, { fetch: this.deps.fetch, save: this.save });
    this.channel?.stop();
    this.channel = next;
    next.start(this.deps.onGoal);
    return next.status();
  }

  async disconnect() { this.channel?.stop(); this.channel = undefined; await this.save(undefined); return this.status(); }
  notify(text: string) { this.channel?.notify(text); }
  stop() { this.channel?.stop(); }
}
