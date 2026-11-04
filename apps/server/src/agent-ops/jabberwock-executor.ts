import { basename, resolve } from "node:path";
import type { ExecutorAdapter, ExecutorOutcome, ExecutorProbe, ExecutorProfile, ExecutorRunContext } from "./executors";
import type { AgentTask } from "./types";

/**
 * D5: the Jabberwock Supervisor as an executor. A task becomes a Jabberwock task with a one-step route
 * in the project whose root is the task's workspace; the route runs on Jabberwock's own local models
 * and its own verification. It is opt-in only: the router picks it when a task names executor
 * "jabberwock", never by itself, so subscription work keeps its usual executors.
 */
type RouteStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export type JabberwockRuntime = {
  memory: {
    list_projects(): Array<{ id: string; root_path: string }>;
    create_project(input: { name: string; description?: string; root_path: string }): { id: string };
    create_task(input: { project_id: string; title: string; original_request: string }): { id: string };
  };
  runner: {
    create_route(input: { taskId: string; autoStart?: boolean; executionConfig?: Record<string, unknown>; steps: Array<{ title: string; instruction: string; acceptanceCriteria: string[]; maxAttempts?: number }> }): { id: string; status: string };
    get_route_state(routeId: string): { status: string; summary?: string | null; blockedReason?: unknown; completedSteps: number; totalSteps: number; changedFiles: string[] };
    cancel_route(routeId: string): unknown;
  };
};

let registered: JabberwockRuntime | undefined;
/** app.ts registers the runtime once the Jabberwock memory and Supervisor bridge are open. */
export function registerJabberwockRuntime(runtime: JabberwockRuntime | undefined): void { registered = runtime; }

const sameRoot = (a: string, b: string) => resolve(a).toLowerCase().replace(/[\\/]+$/, "") === resolve(b).toLowerCase().replace(/[\\/]+$/, "");
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export class JabberwockExecutor implements ExecutorAdapter {
  readonly id = "jabberwock";
  readonly label = "Jabberwock Supervisor (локальные модели)";
  readonly profile: ExecutorProfile = { kinds: ["code_edit", "analysis", "text"], editsFiles: true, shell: false, maxContextTokens: 32_768, quality: "normal",
    pause: "stage_boundary", costTier: "local", order: 50, permissionBase: "local_route", explicitOnly: true };

  constructor(private readonly deps: { runtime?: () => JabberwockRuntime | undefined; pollMs?: number } = {}) {}

  private runtime(): JabberwockRuntime | undefined { return this.deps.runtime ? this.deps.runtime() : registered; }

  async probe(): Promise<ExecutorProbe> {
    const ready = Boolean(this.runtime());
    return { installed: ready, authenticated: null, checkedAt: new Date().toISOString(), source: "jabberwock supervisor",
      detail: ready ? "Supervisor и память Jabberwock открыты" : "Jabberwock Supervisor не запущен в этом сервере." };
  }

  resourceRequest(task: AgentTask): ReturnType<ExecutorAdapter["resourceRequest"]> {
    // Model concurrency is Jabberwock's own runtime's job; here only the orchestration itself is counted.
    return { class: "light", cpuSlots: 1, ramMiB: 256, contextTokens: task.spec.requirements?.contextTokens };
  }

  async run(context: ExecutorRunContext): Promise<ExecutorOutcome> {
    const runtime = this.runtime();
    if (!runtime) return { ok: false, failureClass: "model_unavailable", message: "Jabberwock Supervisor не запущен." };
    if (!context.workdir) return { ok: false, failureClass: "process", message: "Jabberwock работает только в рабочей папке проекта (workspace)." };
    const spec = context.task.spec;
    let routeId: string;
    try {
      const project = runtime.memory.list_projects().find(item => sameRoot(item.root_path, context.workdir!))
        ?? runtime.memory.create_project({ name: basename(context.workdir) || "workspace", description: "Создан Диспетчером задач агентов", root_path: context.workdir });
      const jwTask = runtime.memory.create_task({ project_id: project.id, title: clip(spec.goal.split("\n")[0] || context.task.id, 200), original_request: clip(context.prompt, 20_000) });
      const acceptance = (spec.acceptance ?? []).map(item => clip(item, 1_000)).slice(0, 20);
      const route = runtime.runner.create_route({ taskId: jwTask.id, autoStart: true,
        executionConfig: { runtimeMode: "agent", permissions: spec.permissions?.fileWrite === false ? "read_only" : "read_write" },
        steps: [{ title: clip(spec.goal.split("\n")[0] || "Задача", 300), instruction: clip(`${context.prompt}\n\n${context.brief}`, 4_000),
          acceptanceCriteria: acceptance.length ? acceptance : ["Цель поручения выполнена, результат описан."] }] });
      routeId = route.id;
      context.log(`[jabberwock] маршрут ${route.id} в проекте ${project.id}`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      return code === "PROJECT_BUSY"
        ? { ok: false, failureClass: "process", message: `В проекте уже идёт другой маршрут Jabberwock: ${message}`, waitForResources: "jabberwock:project" }
        : { ok: false, failureClass: "process", message: `Jabberwock не принял маршрут: ${message}` };
    }

    const deadline = Date.now() + context.timeoutMs;
    const pollMs = this.deps.pollMs ?? 3_000;
    let last = "";
    for (;;) {
      if (context.signal.aborted || Date.now() > deadline) {
        try { runtime.runner.cancel_route(routeId); } catch { /* already finished or owned elsewhere */ }
        return context.signal.aborted ? { ok: false, failureClass: "cancelled", message: "Отменено; маршрут Jabberwock остановлен." }
          : { ok: false, failureClass: "timeout", message: `Маршрут Jabberwock ${routeId} не уложился во время.` };
      }
      const state = runtime.runner.get_route_state(routeId);
      const line = `${state.status} ${state.completedSteps}/${state.totalSteps}`;
      if (line !== last) { context.log(`[jabberwock] ${line}`); last = line; }
      const status = state.status as RouteStatus;
      if (status === "completed") {
        const files = state.changedFiles.length ? `\n\nИзменённые файлы: ${state.changedFiles.join(", ")}` : "";
        const summary = `${state.summary ?? "Маршрут Jabberwock завершён."}${files}`;
        return { ok: true, message: "Jabberwock завершил маршрут.", summary, artifactText: summary, provider: "jabberwock" };
      }
      if (status === "failed" || status === "cancelled") return { ok: false, failureClass: status === "cancelled" ? "cancelled" : "process", message: `Маршрут Jabberwock ${routeId}: ${state.summary ?? status}` };
      if (status === "blocked") {
        const reason = state.blockedReason as { blockedReason?: string; message?: string; code?: string } | undefined;
        return { ok: false, failureClass: "process", message: `Маршрут Jabberwock ${routeId} остановился: ${reason?.blockedReason ?? reason?.message ?? reason?.code ?? "нужно решение"}. Продолжить можно в Jabberwock (continue_route).` };
      }
      await new Promise(done => setTimeout(done, pollMs));
    }
  }
}
