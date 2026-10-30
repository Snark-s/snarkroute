import type { FastifyInstance } from "fastify";
import type { AgentOps } from "../agent-ops";
import { AgentOpsError } from "../agent-ops/tasks";
import { resolveHttpIdentity } from "./agent-ops";
import { buzhaMemory } from "../buzha/memory";
import { buzhaModels } from "./buzha-model-gateway";

export function registerBuzhaAgentRoutes(app: FastifyInstance, ready: Promise<AgentOps>) {
  const handle = (fn: (ops: AgentOps, request: any) => Promise<unknown>) => async (request: any, reply: any) => {
    try { return { ok: true, ...await fn(await ready, request) as object }; }
    catch (error) { return reply.code(error instanceof AgentOpsError ? error.status : 503).send({ ok: false, code: error instanceof AgentOpsError ? error.code : "BUZHA_UNAVAILABLE", error: String(error instanceof Error ? error.message : error) }); }
  };
  app.get("/api/agents/buzha", handle(async (ops, request) => ops.buzha.status(resolveHttpIdentity(ops, request))));
  app.post("/api/agents/buzha/messages", handle(async (ops, request) => ops.buzha.submit(resolveHttpIdentity(ops, request), request.body)));
  app.post("/api/agents/buzha/schedules/trigger",handle(async(ops,request)=>ops.buzha.scheduleTrigger(resolveHttpIdentity(ops,request),request.body)));
  app.post("/api/agents/buzha/schedules/handoff",handle(async(ops,request)=>ops.buzha.acknowledgeScheduleSource(resolveHttpIdentity(ops,request),request.body)));
  app.post("/api/agents/buzha/model", handle(async (ops, request) => {
    const identity = resolveHttpIdentity(ops, request); if (identity.kind !== "owner") throw new AgentOpsError("OWNER_ONLY", "Настройку основной модели меняет владелец.", {}, 403);
    const model = request.body?.model;
    if (typeof model !== "string" || model && !(await buzhaModels()).some(entry => entry.id === model && ["local_openai", "chatgpt_subscription", "claude_subscription"].includes(entry.provider))) throw new AgentOpsError("BAD_REQUEST", "Нужна доступная локальная модель или разрешённая подписка.");
    await buzhaMemory("/api/model", { model }); await ops.tasks.refreshExecutorProbes(true); return { configuredModel: model || "auto" };
  }));
  app.get("/api/agents/buzha/tasks/:id", handle(async (ops, request) => {
    const task = ops.buzha.task(request.params.id, resolveHttpIdentity(ops, request));
    return { task: ops.buzha.view(task), events: await ops.tasks.events(task.id) };
  }));
  for (const action of ["pause", "resume", "cancel", "continue"] as const) app.post(`/api/agents/buzha/tasks/:id/${action}`, handle(async (ops, request) => ({ task: await ops.buzha.control(request.params.id, resolveHttpIdentity(ops, request), action) })));
}
