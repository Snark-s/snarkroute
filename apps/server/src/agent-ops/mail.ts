import { randomUUID } from "node:crypto";
import { AgentOpsError } from "./tasks";
import type { AgentOpsStore } from "./store";
import type { AgentIdentity } from "./types";

/**
 * D3: mail between agents. A letter is about work, so it may point at a task or a goal; the receiver
 * acknowledges it (that is the delivery receipt), and an agent waiting on its inbox wakes up the moment
 * a letter arrives instead of polling. The owner reads every mailbox; an agent reads only its own.
 */
export type Letter = {
  id: string; from: string; to: string; subject: string; body: string; at: string;
  taskId?: string; goalId?: string; replyTo?: string;
  readAt?: string; ackAt?: string; ackNote?: string;
};

const ADDRESS = /^(owner|anonymous|[a-z]+:[\w.-]{1,80})$/i;
const MAX_LETTERS = 5000;

export class AgentMail {
  private letters: Letter[] = [];
  private waiters = new Map<string, Set<() => void>>();

  constructor(private readonly deps: { store: AgentOpsStore; now?: () => number; onLetter?: (letter: Letter) => void }) {}

  private iso(): string { return new Date(this.deps.now?.() ?? Date.now()).toISOString(); }
  private save(): Promise<void> { return this.deps.store.writeState("mail", { letters: this.letters }); }

  async init(): Promise<void> {
    this.letters = (await this.deps.store.readState<{ letters?: Letter[] }>("mail", {})).letters ?? [];
  }

  async send(sender: AgentIdentity, input: { to?: unknown; subject?: unknown; body?: unknown; taskId?: unknown; goalId?: unknown; replyTo?: unknown }): Promise<Letter> {
    if (sender.kind === "anonymous") throw new AgentOpsError("IDENTITY_REQUIRED", "Письма отправляют владелец или агент с токеном.", {}, 401);
    const to = typeof input.to === "string" ? input.to.trim() : "";
    if (!ADDRESS.test(to) || to === "anonymous") throw new AgentOpsError("BAD_LETTER", "Адресат: owner или идентификатор агента (app:tove, app:secretary, mcp:…).", {}, 400);
    const subject = typeof input.subject === "string" ? input.subject.trim().slice(0, 200) : "";
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!subject || !body || body.length > 20_000) throw new AgentOpsError("BAD_LETTER", "Нужны тема и текст письма (до 20 000 символов).", {}, 400);
    const ref = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value) ? value : undefined;
    const replyTo = ref(input.replyTo, /^l-[\w-]{6,40}$/);
    if (replyTo && !this.letters.some(letter => letter.id === replyTo && (letter.to === sender.id || letter.from === sender.id || sender.kind === "owner"))) throw new AgentOpsError("BAD_LETTER", "Ответить можно только на своё письмо.", {}, 400);
    const at = this.iso();
    const letter: Letter = { id: `l-${at.slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`, from: sender.kind === "owner" ? "owner" : sender.id, to, subject, body, at,
      ...(ref(input.taskId, /^t-\d{8}-[0-9a-f]{8}$/) ? { taskId: input.taskId as string } : {}), ...(ref(input.goalId, /^g-\d{8}-[0-9a-f]{8}$/) ? { goalId: input.goalId as string } : {}), ...(replyTo ? { replyTo } : {}) };
    this.letters.push(letter);
    if (this.letters.length > MAX_LETTERS) this.prune();
    await this.save();
    this.deps.onLetter?.(letter);
    for (const wake of this.waiters.get(to) ?? []) wake();
    return letter;
  }

  private mailbox(identity: AgentIdentity, box?: string): string {
    const own = identity.kind === "owner" ? "owner" : identity.id;
    if (box && box !== own && identity.kind !== "owner") throw new AgentOpsError("NOT_YOUR_MAILBOX", "Агент читает только свой ящик.", {}, 403);
    return box ?? own;
  }

  inbox(identity: AgentIdentity, options: { box?: string; unacknowledged?: boolean; since?: string; limit?: number } = {}): Letter[] {
    if (identity.kind === "anonymous") throw new AgentOpsError("IDENTITY_REQUIRED", "Ящик есть только у владельца и агентов с токеном.", {}, 401);
    const box = this.mailbox(identity, options.box);
    const letters = this.letters.filter(letter => letter.to === box && (!options.unacknowledged || !letter.ackAt) && (!options.since || letter.at > options.since))
      .slice(-Math.min(500, options.limit ?? 100)).reverse();
    // Only the addressee's own reading counts as read; the owner looking into an agent's box does not.
    const own = identity.kind === "owner" ? "owner" : identity.id;
    const unread = box === own ? letters.filter(letter => !letter.readAt) : [];
    if (unread.length) { const at = this.iso(); for (const letter of unread) letter.readAt = at; void this.save().catch(() => undefined); }
    return letters;
  }

  sent(identity: AgentIdentity, limit = 50): Letter[] {
    const own = identity.kind === "owner" ? "owner" : identity.id;
    return this.letters.filter(letter => letter.from === own).slice(-Math.min(500, limit)).reverse();
  }

  /** Long poll: resolves as soon as an unacknowledged letter is in the box, or after timeoutMs with none. */
  async wait(identity: AgentIdentity, timeoutMs = 25_000, box?: string): Promise<Letter[]> {
    const pending = () => this.inbox(identity, { box, unacknowledged: true });
    if (pending().length) return pending();
    const address = this.mailbox(identity, box);
    await new Promise<void>(resolve => {
      const set = this.waiters.get(address) ?? new Set();
      const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
      const timer = setTimeout(done, Math.max(100, Math.min(timeoutMs, 60_000)));
      set.add(done); this.waiters.set(address, set);
    });
    return pending();
  }

  /** The receiver's receipt; reading alone is recorded too, so the sender sees the difference. */
  async ack(identity: AgentIdentity, id: string, note?: string): Promise<Letter> {
    const letter = this.letters.find(item => item.id === id);
    const own = identity.kind === "owner" ? "owner" : identity.id;
    if (!letter) throw new AgentOpsError("LETTER_NOT_FOUND", `Письмо ${id} не найдено.`, {}, 404);
    if (letter.to !== own && identity.kind !== "owner") throw new AgentOpsError("NOT_YOUR_MAILBOX", "Подтвердить получение может только адресат.", {}, 403);
    const at = this.iso();
    letter.readAt ??= at;
    if (!letter.ackAt) { letter.ackAt = at; if (note) letter.ackNote = note.slice(0, 2000); await this.save(); }
    return letter;
  }

  /** The oldest acknowledged letters go first; unacknowledged ones are never dropped. */
  private prune(): void {
    let excess = this.letters.length - MAX_LETTERS;
    this.letters = this.letters.filter(letter => excess <= 0 || !letter.ackAt || (excess -= 1, false));
  }
}
