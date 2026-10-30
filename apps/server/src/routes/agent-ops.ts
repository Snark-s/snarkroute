import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { setAgentOpsTextRunner, startAgentOps, type AgentOps } from "../agent-ops";
import { agentBrief } from "../agent-ops/agents";
import { rankExecutors } from "../agent-ops/router";
import { AgentOpsError, normalizeSpec } from "../agent-ops/tasks";
import type { AgentIdentity, FailureClass, TaskSpec, TaskState } from "../agent-ops/types";
import { errorMessage } from "../services/errors";
import { registerBuzhaAgentRoutes } from "./buzha-agent";

const ROOT = "/api/agent-ops";

/**
 * HTTP face of agent operations, same contract as the MCP tools. Identity:
 * a delegated executor sends its task token; an MCP-authenticated client may
 * name itself; any other loopback caller is the owner's Workshop (the local
 * API's existing trust boundary).
 */
export function resolveHttpIdentity(ops: AgentOps, request: FastifyRequest): AgentIdentity {
  const token = header(request, "x-snarkroute-agent-token");
  if (token) {
    const identity = ops.registry.identityFromToken(token);
    if (!identity) throw new AgentOpsError("BAD_AGENT_TOKEN", "Токен агента недействителен или истёк.", {}, 401);
    return identity;
  }
  const name = header(request, "x-snarkroute-agent");
  const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined;
  if (name && bearer && process.env.SNARKROUTE_MCP_TOKEN?.trim() && bearer === process.env.SNARKROUTE_MCP_TOKEN.trim()) return ops.registry.mcpClient(name);
  return ops.registry.owner("http");
}

export function registerAgentOpsRoutes(app: FastifyInstance, options: { ops?: Promise<AgentOps> } = {}): void {
  const ready = options.ops ?? startAgentOps({ apiUrl: `http://127.0.0.1:${process.env.SNARKROUTE_API_PORT_FOR_AGENTS ?? "4317"}` });
  ready.catch(error => app.log.error({ err: error }, "agent-ops failed to start"));
  registerBuzhaAgentRoutes(app, ready);
  app.addHook("onClose", async () => { (await ready.catch(() => undefined))?.close(); });

  // The local executor runs ai.text through the regular route executor: routing policy, admission and ledger stay authoritative.
  setAgentOpsTextRunner(async (model, prompt, signal) => {
    const response = await app.inject({ method: "POST", url: "/api/routes/run", signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]), payload: { route: {
      routeVersion: "0.1", route: { id: `agent-ops-${randomUUID()}`, title: "Agent ops · local text", author: { name: "SnarkRoute" } },
      nodes: [{ id: "answer", type: "ai.text", params: { model: model.providerModelId, providerModelId: model.providerModelId, executionProvider: model.provider,
        promptBase64: Buffer.from(prompt, "utf8").toString("base64"), max_tokens: 2048, routingPolicy: { allowPaid: false, subscriptionModels: model.provider === "local_openai" ? "exclude" : "allow" } } }], edges: []
    } } });
    const result = response.json() as Record<string, any>;
    const node = result.nodeResults?.answer ?? {};
    const text = node.output?.text;
    if (response.statusCode !== 200 || result.status !== "succeeded" || typeof text !== "string") return { ok: false, error: errorMessage(node.error ?? result.error ?? `HTTP ${response.statusCode}`) };
    return { ok: true, text, usage: node.output?.actualUsage ?? undefined, actualModel: node.output?.model ?? node.provenance?.model ?? model.providerModelId, actualProvider: node.provenance?.provider ?? model.provider, runId: result.runId, sessionId: node.output?.sessionId };
  });

  const handle = (fn: (ops: AgentOps, identity: AgentIdentity, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ops = await ready;
        return await fn(ops, resolveHttpIdentity(ops, request), request, reply);
      } catch (error) {
        if (error instanceof AgentOpsError) return reply.code(error.status).send({ ok: false, code: error.code, error: error.message, details: error.details });
        return reply.code(400).send({ ok: false, error: errorMessage(error) });
      }
    };

  app.get(`${ROOT}/status`, handle(async ops => ({ ok: true, ...await ops.status(),
    tasks: ops.tasks.list({ limit: 60 }).map(task => ({ id: task.id, title: task.title, state: task.state, reason: task.reason, executor: task.executor, agentId: task.agentId,
      priority: task.priority, depth: task.chain.depth, createdAt: task.createdAt, updatedAt: task.updatedAt, workdir: task.workdir, attempts: task.attempts.length,
      nextStep: task.nextStep, nextAttemptAt: task.nextAttemptAt, lastDecision: task.reviews?.at(-1), criteria: task.contract?.criteria, chainBudget: ops.tasks.chainBudget(task.chain.rootTaskId), taskBudget: ops.tasks.budgetUsage(task) })) })));

  app.get(`${ROOT}/whoami`, handle(async (ops, identity) => ({ ok: true, identity: { id: identity.id, kind: identity.kind, policy: identity.policy, taskId: identity.taskId },
    brief: agentBrief(identity), mode: await ops.mode() })));

  app.get<{ Querystring: { kind?: string; query?: string; availableOnly?: string } }>(`${ROOT}/catalog`, handle(async (ops, identity, request) => {
    const query = request.query as { kind?: string; query?: string; availableOnly?: string };
    return { ok: true, entries: await ops.catalog.list(identity, { kind: query.kind as never, query: query.query, availableOnly: query.availableOnly === "1" }) };
  }));

  app.get<{ Params: { id: string } }>(`${ROOT}/catalog/:id`, handle(async (ops, identity, request, reply) => {
    const detail = await ops.catalog.detail(identity, (request.params as { id: string }).id);
    return detail ? { ok: true, entry: detail } : reply.code(404).send({ ok: false, error: "Нет такой записи каталога." });
  }));

  app.post(`${ROOT}/route`, handle(async (ops, identity, request) => {
    const spec = normalizeSpec(request.body as TaskSpec);
    await ops.tasks.refreshExecutorProbes(false);
    return { ok: true, candidates: rankExecutors({ spec, policy: identity.policy, adapters: ops.adapters, probes: ops.tasks.probeSnapshot() })
      .map(candidate => ({ ...candidate, availability: ops.ledger.availability(candidate.executorId, candidate.tier) })) };
  }));

  app.get(`${ROOT}/tasks`, handle(async (ops, identity, request) => {
    const query = request.query as { state?: string; limit?: string; mine?: string };
    return { ok: true, tasks: ops.tasks.list({ agentId: query.mine === "1" || identity.kind !== "owner" ? identity.id : undefined,
      states: query.state ? query.state.split(",") as TaskState[] : undefined, limit: Math.min(500, Number(query.limit) || 100) }) };
  }));

  app.post(`${ROOT}/tasks`, handle(async (ops, identity, request, reply) => {
    const { task, deduplicated } = await ops.tasks.submit(identity, request.body as TaskSpec);
    return reply.code(deduplicated ? 200 : 202).send({ ok: true, deduplicated, task });
  }));

  app.get<{ Params: { id: string } }>(`${ROOT}/tasks/:id`, handle(async (ops, _identity, request, reply) => {
    const task = ops.tasks.get((request.params as { id: string }).id);
    if (!task) return reply.code(404).send({ ok: false, error: "Задача не найдена." });
    return { ok: true, task, chainBudget: ops.tasks.chainBudget(task.chain.rootTaskId), taskBudget: ops.tasks.budgetUsage(task), events: await ops.tasks.events(task.id) };
  }));

  app.get<{ Params: { id: string } }>(`${ROOT}/tasks/:id/result`, handle(async (ops, _identity, request, reply) => {
    const task = ops.tasks.get((request.params as { id: string }).id);
    if (!task) return reply.code(404).send({ ok: false, error: "Задача не найдена." });
    return { ok: true, id: task.id, state: task.state, reason: task.reason, verified: task.state === "verified", result: task.result ?? null, contract: task.contract, decisions: task.reviews, evidence: task.evidence };
  }));

  app.get<{ Params: { id: string } }>(`${ROOT}/tasks/:id/log`, handle(async (ops, _identity, request) => ({ ok: true, log: await ops.tasks.log((request.params as { id: string }).id) })));

  app.post<{ Params: { id: string } }>(`${ROOT}/tasks/:id/cancel`, handle(async (ops, identity, request) => ({ ok: true, task: await ops.tasks.cancel((request.params as { id: string }).id, identity) })));
  app.post<{ Params: { id: string } }>(`${ROOT}/tasks/:id/budget`, handle(async (ops, identity, request) => { const body=request.body as { budget: { wallMinutes?: number; activeMinutes?: number; subscriptionRuns?: number }; reason: string }; return {ok:true,task:await ops.tasks.reviseBudget((request.params as {id:string}).id,identity,body.budget,body.reason)}; }));

  app.post<{ Params: { id: string } }>(`${ROOT}/tasks/:id/resolve`, handle(async (ops, identity, request) => {
    const body = (request.body ?? {}) as { action?: "requeue" | "continue" | "mark_failed" | "mark_verified"; note?: string };
    if (!body.action) throw new AgentOpsError("BAD_REQUEST", "Нужно действие: requeue, continue, mark_failed или mark_verified.", {}, 400);
    return { ok: true, task: await ops.tasks.resolve((request.params as { id: string }).id, identity, body.action, body.note) };
  }));

  app.post<{ Params: { id: string } }>(`${ROOT}/tasks/:id/verify`, handle(async (ops, identity, request) => ({ ok: true, task: await ops.tasks.verify((request.params as { id: string }).id, identity) })));

  for (const action of ["pause", "resume"] as const) app.post(`${ROOT}/tasks/:id/${action}`, handle(async (ops, identity, request) => ({ ok: true, task: await ops.tasks[action]((request.params as { id: string }).id, identity) })));
  app.post(`${ROOT}/tasks/:id/amend`, handle(async (ops, identity, request) => {
    const { note, ...patch } = request.body as Partial<TaskSpec> & { note: string };
    return { ok: true, task: await ops.tasks.amend((request.params as { id: string }).id, identity, patch, note) };
  }));
  app.post(`${ROOT}/tasks/:id/effects/:key`, handle(async (ops, identity, request) => {
    const { id, key } = request.params as { id: string; key: string }, body = request.body as { action: "begin" | "reconcile" | "not_performed"; note?: string };
    if (!["begin", "reconcile", "not_performed"].includes(body.action)) throw new AgentOpsError("BAD_REQUEST", "Нужно begin/reconcile/not_performed.");
    return { ok: true, ...await ops.tasks.effect(id, identity, key, body.action, body.note) };
  }));
  app.get(`${ROOT}/acceptor`, handle(async ops => ({ ok: true, calibration: await ops.store.readState("acceptor-calibration", {}), tasks: ops.tasks.list({ limit: 100 }).map(task => ({ id: task.id, state: task.state, contract: task.contract, lastDecision: task.reviews?.at(-1), nextStep: task.nextStep })) })));
  app.post(`${ROOT}/acceptor/inspect`, handle(async (ops, identity, request, reply) => {
    const result = await ops.tasks.submit(identity, request.body as TaskSpec, { inspectExisting: true });
    return reply.code(result.deduplicated ? 200 : 202).send({ ok: true, ...result });
  }));

  app.put(`${ROOT}/mode`, handle(async (ops, identity, request) => {
    const body = (request.body ?? {}) as { mode?: "owner_busy" | "background" | "free" | null; until?: string | null; minutes?: number };
    const until = body.until ?? (body.minutes ? new Date(Date.now() + Math.min(7 * 24 * 60, body.minutes) * 60_000).toISOString() : null);
    await ops.setManualMode(identity, { mode: body.mode ?? null, until });
    return { ok: true, mode: await ops.mode() };
  }));

  app.put(`${ROOT}/schedule`, handle(async (ops, identity, request) => {
    await ops.setSchedule(identity, ((request.body ?? {}) as { rules?: never[] }).rules ?? []);
    return { ok: true, schedule: ops.modeState().schedule, mode: await ops.mode() };
  }));

  app.put(`${ROOT}/limits`, handle(async (ops, identity, request) => {
    await ops.setLimits(identity, (request.body ?? {}) as never);
    return { ok: true, limits: ops.modeState().limits };
  }));

  app.post(`${ROOT}/leases`, handle(async (ops, identity, request, reply) => {
    const body = (request.body ?? {}) as { class?: "heavy" | "light"; purpose?: string; vramMiB?: number; ramMiB?: number; cpuSlots?: number; diskHeavy?: boolean; runtimeId?: string; ttlMinutes?: number };
    const decision = await ops.acquireAgentLease(identity, { class: body.class === "heavy" ? "heavy" : "light", purpose: body.purpose?.slice(0, 200) || "agent work",
      vramMiB: body.vramMiB, ramMiB: body.ramMiB, cpuSlots: body.cpuSlots, diskHeavy: body.diskHeavy, runtimeId: body.runtimeId, ttlMs: body.ttlMinutes ? body.ttlMinutes * 60_000 : undefined });
    return decision.granted ? { ok: true, granted: true, lease: decision.lease } : reply.code(409).send({ ok: false, granted: false, waitFor: decision.waitFor, reason: decision.reason });
  }));

  app.post<{ Params: { id: string } }>(`${ROOT}/leases/:id/heartbeat`, handle(async (ops, _identity, request) => ({ ok: ops.dispatcher.heartbeat((request.params as { id: string }).id) })));
  app.delete<{ Params: { id: string } }>(`${ROOT}/leases/:id`, handle(async (ops, identity, request) => ({ ok: ops.releaseAgentLease(identity, (request.params as { id: string }).id) })));

  app.get(`${ROOT}/agents`, handle(async ops => ({ ok: true, agents: ops.registry.list(), policies: ops.registry.policyDocument() })));

  // Limits and outages are tested by simulation; real subscriptions are never exhausted on purpose.
  app.post(`${ROOT}/simulate`, handle(async (ops, identity, request) => {
    if (identity.kind !== "owner") throw new AgentOpsError("OWNER_ONLY", "Симуляции доступны только владельцу.", {}, 403);
    const body = (request.body ?? {}) as { executor?: string; failure?: FailureClass; seconds?: number };
    if (!body.executor || !ops.adapters.some(adapter => adapter.id === body.executor)) throw new AgentOpsError("BAD_REQUEST", "Неизвестный исполнитель.", {}, 400);
    const failure = body.failure ?? "quota_exhausted";
    const seconds = Math.min(3600, Math.max(5, body.seconds ?? 300));
    ops.ledger.recordFailure(body.executor, { class: failure, message: `Симуляция: ${failure}`, resetsAt: new Date(Date.now() + seconds * 1000).toISOString(), source: "simulation", simulated: true });
    if (failure === "auth") ops.ledger.recordAuth(body.executor, "not_logged_in", "simulation", "Симуляция ошибки авторизации");
    ops.tasks.kick();
    return { ok: true, ledger: ops.ledger.view(body.executor) };
  }));

  app.delete<{ Params: { executor: string } }>(`${ROOT}/simulate/:executor`, handle(async (ops, identity, request) => {
    if (identity.kind !== "owner") throw new AgentOpsError("OWNER_ONLY", "Симуляции доступны только владельцу.", {}, 403);
    const executor = (request.params as { executor: string }).executor;
    ops.ledger.clearSimulation(executor);
    if (ops.ledger.view(executor).auth.source === "simulation") ops.ledger.recordAuth(executor, "unknown", "simulation-cleared");
    await ops.tasks.refreshExecutorProbes(true);
    ops.tasks.kick();
    return { ok: true, ledger: ops.ledger.view(executor) };
  }));
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
