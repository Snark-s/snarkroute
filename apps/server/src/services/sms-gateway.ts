import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The owner's Android phone with «SMS Gateway for Android» (sms-gate.app) in Local Server mode:
 * the phone answers on the home network at http://<ip>:8080 with the login and password shown in the app.
 * SnarkRoute only READS received messages (GET /inbox); it never sends SMS. The login and password are
 * stored encrypted in the agent-ops data folder and never returned to the UI, agents or logs.
 * Docs: https://docs.sms-gate.app/features/reading-messages/
 */
export type SmsMessage = { id: string; sender: string; text: string; receivedAt: string; sim?: number };
type Stored = { url: string; username: string; iv: string; tag: string; data: string; savedAt: string };
export type SmsStatus = { configured: boolean; url?: string; username?: string; savedAt?: string; lastOkAt?: string; lastError?: string | null; lastCount?: number };

/** Only addresses on this computer, the home network or Tailscale: the phone's password never leaves the LAN. */
export function privateGatewayUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim().includes("://") ? value.trim() : `http://${value.trim()}`); } catch { throw new Error("Адрес вида 192.168.1.23:8080 — как в приложении на телефоне."); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Нужен адрес http:// или https://.");
  const host = url.hostname;
  const privateHost = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || host === "localhost" || host.endsWith(".local") || host.endsWith(".ts.net");
  if (!privateHost) throw new Error("Телефон должен быть в домашней сети (192.168.x.x, 10.x.x.x) или в Tailscale: пароль от шлюза наружу не уходит.");
  return `${url.protocol}//${url.host}`;
}

export class SmsGateway {
  private lastOkAt?: string;
  private lastError: string | null = null;
  private lastCount?: number;
  constructor(private readonly deps: { directory: string; fetchImpl?: typeof fetch; now?: () => number }) {}

  private file() { return join(this.deps.directory, "sms-gateway.json"); }
  private keyFile() { return join(this.deps.directory, "sms-gateway.key"); }
  private async key(): Promise<Buffer> {
    await mkdir(this.deps.directory, { recursive: true });
    if (existsSync(this.keyFile())) return Buffer.from((await readFile(this.keyFile(), "utf8")).trim(), "base64");
    const key = randomBytes(32);
    await writeFile(this.keyFile(), key.toString("base64"), { encoding: "utf8", mode: 0o600 });
    return key;
  }
  private async load(): Promise<(Stored & { password: string }) | undefined> {
    if (!existsSync(this.file())) return undefined;
    const stored = JSON.parse(await readFile(this.file(), "utf8")) as Stored;
    const decipher = createDecipheriv("aes-256-gcm", await this.key(), Buffer.from(stored.iv, "base64"));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    const password = Buffer.concat([decipher.update(Buffer.from(stored.data, "base64")), decipher.final()]).toString("utf8");
    return { ...stored, password };
  }

  async status(): Promise<SmsStatus> {
    const stored = existsSync(this.file()) ? JSON.parse(await readFile(this.file(), "utf8")) as Stored : undefined;
    return stored ? { configured: true, url: stored.url, username: stored.username, savedAt: stored.savedAt, lastOkAt: this.lastOkAt, lastError: this.lastError, lastCount: this.lastCount } : { configured: false };
  }

  /** Saves only after the phone answered with these credentials. */
  async configure(input: { url?: unknown; username?: unknown; password?: unknown }): Promise<SmsStatus> {
    const url = privateGatewayUrl(String(input.url ?? ""));
    const username = typeof input.username === "string" ? input.username.trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (!username || !password || username.length > 200 || password.length > 500) throw new Error("Нужны логин и пароль из приложения (вкладка «Главная»).");
    await this.request({ url, username, password }, "/inbox?type=SMS&limit=1");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.key(), iv);
    const data = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
    const stored: Stored = { url, username, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64"), savedAt: new Date(this.now()).toISOString() };
    await writeFile(this.file(), JSON.stringify(stored, null, 1), { encoding: "utf8", mode: 0o600 });
    return this.status();
  }

  async disconnect(): Promise<SmsStatus> {
    await rm(this.file(), { force: true });
    this.lastOkAt = undefined; this.lastError = null; this.lastCount = undefined;
    return this.status();
  }

  private now() { return this.deps.now?.() ?? Date.now(); }

  private async request(config: { url: string; username: string; password: string }, path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await (this.deps.fetchImpl ?? fetch)(`${config.url}${path}`, { headers: { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` }, signal: AbortSignal.timeout(10_000) });
    } catch {
      this.lastError = "Телефон не отвечает: проверь, что он в той же сети, приложение открыто и включён «Локальный сервер».";
      throw new Error(this.lastError);
    }
    if (response.status === 401 || response.status === 403) { this.lastError = "Телефон отклонил логин или пароль."; throw new Error(this.lastError); }
    if (response.status === 404) { this.lastError = "В этой версии приложения нет чтения входящих (/inbox): обнови SMS Gateway."; throw new Error(this.lastError); }
    if (!response.ok) { this.lastError = `Телефон ответил HTTP ${response.status}.`; throw new Error(this.lastError); }
    this.lastError = null; this.lastOkAt = new Date(this.now()).toISOString();
    return response.json();
  }

  /** Received SMS, newest first; filters stay on our side as well, since older app versions ignore some. */
  async inbox(options: { since?: string; sender?: string; limit?: number } = {}): Promise<{ messages: SmsMessage[]; source: string; observedAt: string }> {
    const config = await this.load();
    if (!config) throw new Error("SMS-шлюз не подключён: владелец вводит адрес телефона в Мастерской (вкладка «Секретарь» → «SMS телефона Бужи»).");
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const since = options.since && Number.isFinite(Date.parse(options.since)) ? new Date(options.since).toISOString() : undefined;
    const query = new URLSearchParams({ type: "SMS", limit: String(limit), offset: "0", ...(since ? { from: since } : {}) });
    const raw = await this.request(config, `/inbox?${query}`);
    const list = (Array.isArray(raw) ? raw : (raw as { messages?: unknown[] })?.messages ?? []) as Array<Record<string, unknown>>;
    const sender = options.sender?.trim().toLowerCase();
    const messages = list.map(item => ({ id: String(item.id ?? ""), sender: String(item.sender ?? ""), text: String(item.contentPreview ?? item.message ?? item.text ?? ""),
      receivedAt: String(item.createdAt ?? item.receivedAt ?? ""), ...(typeof item.simNumber === "number" ? { sim: item.simNumber } : {}) }))
      .filter(message => (!since || Date.parse(message.receivedAt) >= Date.parse(since)) && (!sender || message.sender.toLowerCase().includes(sender)))
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)).slice(0, limit);
    this.lastCount = messages.length;
    return { messages, source: `SMS Gateway (Local Server) ${config.url}`, observedAt: new Date(this.now()).toISOString() };
  }
}

let shared: SmsGateway | undefined;
export function smsGateway(directory: string): SmsGateway { return shared ??= new SmsGateway({ directory }); }
