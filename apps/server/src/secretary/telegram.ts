/**
 * D2: Telegram as a door to the Secretary. Off until the owner sets TELEGRAM_BOT_TOKEN and
 * TELEGRAM_OWNER_CHAT_ID (root .env). Only messages from the owner's chat are taken as goals; the
 * token never leaves this module (it is not logged and not returned anywhere).
 */
export type TelegramConfig = { token: string; chatId: string };
type Update = { update_id: number; message?: { message_id: number; chat: { id: number | string }; text?: string } };

export function telegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | undefined {
  const token = env.TELEGRAM_BOT_TOKEN?.trim(), chatId = env.TELEGRAM_OWNER_CHAT_ID?.trim();
  return token && chatId && /^\d+:[\w-]{20,}$/.test(token) && /^-?\d+$/.test(chatId) ? { token, chatId } : undefined;
}

export class TelegramChannel {
  private offset = 0;
  private stopped = false;
  private lastError = "";

  constructor(private readonly config: TelegramConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private async api<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await response.json() as { ok: boolean; result?: T; description?: string };
    // The URL holds the token: report the method and Telegram's description only.
    if (!response.ok || !data.ok) throw new Error(`Telegram ${method}: ${data.description ?? `HTTP ${response.status}`}`);
    return data.result as T;
  }

  status() { return { enabled: true, error: this.lastError || null }; }

  async send(text: string): Promise<void> {
    await this.api("sendMessage", { chat_id: this.config.chatId, text: text.slice(0, 3900), disable_web_page_preview: true });
  }

  /** One long-poll round; the owner's text messages become goals, everything else is ignored. */
  async pollOnce(onGoal: (text: string, requestKey: string) => Promise<string>, timeoutSeconds = 25): Promise<number> {
    const updates = await this.api<Update[]>("getUpdates", { offset: this.offset, timeout: timeoutSeconds, allowed_updates: ["message"] }, (timeoutSeconds + 10) * 1000);
    let taken = 0;
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      const message = update.message;
      if (!message?.text || String(message.chat.id) !== this.config.chatId) continue;
      const text = message.text.replace(/^\/(goal|цель)(@\w+)?\s*/i, "").trim();
      if (!text || text.startsWith("/")) continue;
      const reply = await onGoal(text, `tg:${update.update_id}`).catch(error => `Не приняла: ${error instanceof Error ? error.message : String(error)}`);
      await this.send(reply).catch(() => undefined);
      taken += 1;
    }
    return taken;
  }

  start(onGoal: (text: string, requestKey: string) => Promise<string>): void {
    const loop = async () => {
      while (!this.stopped) {
        try { await this.pollOnce(onGoal); this.lastError = ""; }
        catch (error) { this.lastError = error instanceof Error ? error.message : String(error); await new Promise(resolve => setTimeout(resolve, 30_000)); }
      }
    };
    void loop();
  }

  stop(): void { this.stopped = true; }
}
