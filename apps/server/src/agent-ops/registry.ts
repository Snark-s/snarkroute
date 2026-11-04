import { AgentOpsError } from "./tasks";
import type { AgentOpsStore } from "./store";
import type { AgentIdentity } from "./types";

/**
 * D4: one picture of work kept elsewhere. Systems with their own stores (Tove goals, Factory lines and
 * obstacles, …) are projected here: SnarkRoute reads them through their local APIs, and a system may
 * also push its items itself. Projections are read-only views; the source system stays the owner of
 * its work, so nothing here changes it.
 */
export type ProjectionState = "active" | "waiting" | "needs_owner" | "stalled" | "done" | "failed";
export type ProjectedItem = {
  system: string; externalId: string; title: string; state: ProjectionState; detail?: string;
  progress?: string; goalId?: string; taskId?: string; url?: string; updatedAt: string; source: "pull" | "push";
};
export type ProjectionSource = { system: string; label: string; fetch: () => Promise<Array<Omit<ProjectedItem, "system" | "source">>> };
type SourceStatus = { ok: boolean; at: string; error?: string; count: number };

const STATES: ProjectionState[] = ["active", "waiting", "needs_owner", "stalled", "done", "failed"];
const PULL_TTL_MS = 60_000;

export class WorkRegistry {
  private pulled = new Map<string, { at: number; items: ProjectedItem[]; status: SourceStatus }>();
  private pushed = new Map<string, ProjectedItem>();
  private inflight = new Map<string, Promise<void>>();

  constructor(private readonly deps: { store: AgentOpsStore; sources: ProjectionSource[]; includeRegistered?: boolean; now?: () => number }) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  async init(): Promise<void> {
    for (const item of (await this.deps.store.readState<{ items?: ProjectedItem[] }>("registry-pushed", {})).items ?? []) this.pushed.set(`${item.system}/${item.externalId}`, item);
  }

  /** A system reports its own item; only that system's agent (or the owner) may write under its name. */
  async push(identity: AgentIdentity, system: string, externalId: string, input: Record<string, unknown>): Promise<ProjectedItem> {
    if (!/^[a-z][\w-]{1,40}$/.test(system) || !/^[\w.:-]{1,120}$/.test(externalId)) throw new AgentOpsError("BAD_ITEM", "system и id: латиница, цифры, -_.:", {}, 400);
    if (identity.kind !== "owner" && identity.id !== `app:${system}`) throw new AgentOpsError("NOT_YOUR_SYSTEM", `Писать проекции ${system} может только app:${system}.`, {}, 403);
    const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
    if (!title || !STATES.includes(input.state as ProjectionState)) throw new AgentOpsError("BAD_ITEM", `Нужны title и state (${STATES.join(", ")}).`, {}, 400);
    const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
    const item: ProjectedItem = { system, externalId, title, state: input.state as ProjectionState, detail: text(input.detail, 1000), progress: text(input.progress, 120),
      goalId: text(input.goalId, 40), taskId: text(input.taskId, 40), url: text(input.url, 500), updatedAt: new Date(this.now()).toISOString(), source: "push" };
    this.pushed.set(`${system}/${externalId}`, item);
    await this.deps.store.writeState("registry-pushed", { items: [...this.pushed.values()].slice(-2000) });
    return item;
  }

  private async pull(source: ProjectionSource, force = false): Promise<void> {
    const cached = this.pulled.get(source.system);
    if (!force && cached && this.now() - cached.at < PULL_TTL_MS) return;
    const running = this.inflight.get(source.system);
    if (running) return running;
    const run = (async () => {
      const at = new Date(this.now()).toISOString();
      try {
        const items = (await source.fetch()).map(item => ({ ...item, system: source.system, source: "pull" as const }));
        this.pulled.set(source.system, { at: this.now(), items, status: { ok: true, at, count: items.length } });
      } catch (error) {
        // A source that is down keeps its last known items, marked as stale by its status.
        this.pulled.set(source.system, { at: this.now(), items: cached?.items ?? [], status: { ok: false, at, error: error instanceof Error ? error.message : String(error), count: cached?.items.length ?? 0 } });
      }
    })().finally(() => this.inflight.delete(source.system));
    this.inflight.set(source.system, run);
    return run;
  }

  private sources(): ProjectionSource[] {
    const own = new Set(this.deps.sources.map(source => source.system));
    return [...this.deps.sources, ...(this.deps.includeRegistered ? registeredProjectionSources().filter(source => !own.has(source.system)) : [])];
  }

  async list(options: { refresh?: boolean } = {}) {
    const sources = this.sources();
    await Promise.all(sources.map(source => this.pull(source, options.refresh)));
    const pulled = [...this.pulled.values()].flatMap(entry => entry.items);
    const keys = new Set(pulled.map(item => `${item.system}/${item.externalId}`));
    const items = [...pulled, ...[...this.pushed.values()].filter(item => !keys.has(`${item.system}/${item.externalId}`))];
    const order: Record<ProjectionState, number> = { needs_owner: 0, stalled: 1, active: 2, waiting: 3, failed: 4, done: 5 };
    items.sort((a, b) => order[a.state] - order[b.state] || a.system.localeCompare(b.system) || b.updatedAt.localeCompare(a.updatedAt));
    return { items, sources: Object.fromEntries(sources.map(source => [source.system, { label: source.label, ...(this.pulled.get(source.system)?.status ?? { ok: false, at: "", count: 0 }) }])) };
  }
}

/** Sources that live in other modules (Jabberwock memory is opened by the app) register themselves here. */
const extraSources: ProjectionSource[] = [];
export function registerProjectionSource(source: ProjectionSource): void {
  const index = extraSources.findIndex(item => item.system === source.system);
  if (index >= 0) extraSources[index] = source; else extraSources.push(source);
}
export function registeredProjectionSources(): ProjectionSource[] { return [...extraSources]; }

/** Jabberwock Supervisor routes: blocked routes wait for a decision, running ones are in work. */
export function jabberwockSource(list: (limit: number) => Array<{ id: string; objective: string; status: string; summary: string | null; blocked: string | null; updatedAt: string; steps: number; done: number }>): ProjectionSource {
  return { system: "jabberwock", label: "Jabberwock", fetch: async () => list(50).map(route => {
    const state: ProjectionState = route.status === "completed" ? "done" : route.status === "failed" || route.status === "cancelled" ? "failed" : route.status === "blocked" ? "stalled" : route.status === "pending" ? "waiting" : "active";
    let blocked = route.blocked ?? "";
    try { const parsed = JSON.parse(blocked); blocked = parsed?.message ?? parsed?.reason ?? blocked; } catch { /* plain text */ }
    return { externalId: route.id, title: route.objective, state, progress: `шагов ${route.done} из ${route.steps}`, detail: (blocked || route.summary || "").slice(0, 400) || undefined, updatedAt: route.updatedAt };
  }) };
}

async function json(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** Tove goals: status and stall counter map onto the shared states. */
export function toveSource(base = "http://127.0.0.1:4890"): ProjectionSource {
  return { system: "tove", label: "Шорёк (Tove)", fetch: async () => {
    const [data, obstacles] = await Promise.all([json(`${base}/api/goals`), json(`${base}/api/obstacles`).catch(() => ({ obstacles: [] }))]);
    // Open obstacles are Tove's questions to the owner; the answer goes back as a letter to app:tove.
    const questions = (obstacles.obstacles ?? []).filter((obstacle: any) => obstacle.status === "open").map((obstacle: any) => ({
      externalId: `obstacle:${obstacle.id}`, title: String(obstacle.title ?? obstacle.kind ?? obstacle.id).slice(0, 200), state: "needs_owner" as ProjectionState,
      detail: String(obstacle.detail ?? "").slice(0, 1000) || undefined, goalId: undefined, progress: obstacle.kind ? String(obstacle.kind) : undefined,
      updatedAt: String(obstacle.created_at ?? new Date().toISOString()), url: base.replace(/\/$/, "") + "/" }));
    return [...questions, ...(data.goals ?? []).map((goal: any) => {
      const status = String(goal.status ?? "");
      const state: ProjectionState = status === "needs_review" ? "needs_owner" : status === "done" || status === "achieved" ? "done" : status === "failed" || status === "abandoned" ? "failed"
        : status === "paused" ? "waiting" : Number(goal.stalled) >= 3 ? "stalled" : "active";
      const progress = goal.target != null ? `${goal.last_value ?? 0} из ${goal.target}` : goal.verified_units != null ? `подтверждено ${goal.verified_units}` : undefined;
      // needs_review is Tove's own question to the owner: say what is asked, not just the objective.
      const detail = state === "needs_owner"
        ? `Шорёк просит решить судьбу цели: ${goal.stalled ?? "?"} проверок подряд без прогресса. Варианты: продолжить, изменить или закрыть цель в Шорьке. Цель: ${String(goal.objective ?? "").slice(0, 300)}`
        : String(goal.objective ?? "").slice(0, 400);
      return { externalId: String(goal.id), title: String(goal.title ?? goal.id), state, detail, progress, updatedAt: String(goal.updated_at ?? new Date().toISOString()), url: base.replace(/\/$/, "") + "/" };
    })];
  } };
}

/** PersonaCore runtime tasks (Jabberwock / persona agent): open ones and those finished in the last 3 days. */
export function personaSource(apiUrl = "http://127.0.0.1:4317", now = () => Date.now()): ProjectionSource {
  return { system: "persona", label: "PersonaCore", fetch: async () => {
    const response = await fetch(`${apiUrl}/api/persona/tasks`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`persona tasks: HTTP ${response.status}`);
    const data = await response.json() as { tasks?: any[] };
    return (data.tasks ?? []).map(task => {
      const status = String(task.status ?? "").toLowerCase();
      const state: ProjectionState = /complete|done|success/.test(status) ? "done" : /fail|error|cancel/.test(status) ? "failed"
        : /block|need|await(ing)?_(user|owner)|input/.test(status) ? "needs_owner" : /run|progress|active/.test(status) ? "active" : "waiting";
      const updatedAt = String(task.updated_at ?? task.created_at ?? new Date(now()).toISOString());
      return { externalId: String(task.task_id ?? task.id), title: String(task.display_title || task.objective || task.task_id).slice(0, 200), state,
        progress: task.phase ? String(task.phase) : undefined, detail: String(task.current_request ?? "").slice(0, 300) || undefined, updatedAt };
    }).filter(item => !["done", "failed"].includes(item.state) || now() - Date.parse(item.updatedAt) < 3 * 86_400_000);
  } };
}

/** Factory: each sales line is a standing piece of work; open obstacles are things that block it. */
export function factorySource(base = "http://127.0.0.1:4891"): ProjectionSource {
  return { system: "factory", label: "Фабрика", fetch: async () => {
    const [status, obstacles] = await Promise.all([json(`${base}/api/status`), json(`${base}/api/obstacles`).catch(() => ({ obstacles: [] }))]);
    const now = new Date().toISOString();
    const lines = (status.lines ?? []).map((line: any) => ({ externalId: `line:${line.id}`, title: `Линия «${line.name ?? line.id}»`,
      state: (["paused", "stopped"].includes(line.status) ? "waiting" : "active") as ProjectionState, progress: line.status_label, detail: line.sales?.note, updatedAt: now, url: "http://127.0.0.1:4891/" }));
    const open = (obstacles.obstacles ?? []).filter((item: any) => item.status === "open").map((item: any) => ({ externalId: `obstacle:${item.id}`, title: `Препятствие: ${item.title}`,
      state: (item.needs === "owner" ? "needs_owner" : "stalled") as ProjectionState, detail: `${item.line_id ?? ""} · ${String(item.detail ?? "").slice(0, 300)}`, updatedAt: String(item.created_at ?? now), url: "http://127.0.0.1:4891/" }));
    return [...lines, ...open];
  } };
}
