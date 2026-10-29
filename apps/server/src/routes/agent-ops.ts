import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { agentOpsInstance, setAgentOpsTextRunner, startAgentOps, type AgentOps } from "../agent-ops";
import { agentBrief } from "../agent-ops/agents";
import { opsContext } from "../agent-ops/context";
import { isModelWorkRequest } from "../agent-ops/caller-process";
import { rankExecutors } from "../agent-ops/router";
import { AgentOpsError, normalizeSpec } from "../agent-ops/tasks";
import type { AgentIdentity, FailureClass, TaskSpec, TaskState } from "../agent-ops/types";
import { SUBSCRIPTION_PROVIDERS } from "../services/model-routing-policy";
import { errorMessage } from "../services/errors";

const ROOT = "/api/agent-ops";
const OWNER_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const OWNER_CODE_TTL_MS = 2 * 60_000;
const AGENT_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Who is calling, by credential only:
 * - `x-snarkroute-agent-token`: an agent or executor token this server signed;
 * - `x-snarkroute-owner-session` (or Bearer `owner.…`): the Workshop owner session;
 * - Bearer SNARKROUTE_LAUNCHER_TOKEN: the launcher acting for the owner;
 * - Bearer SNARKROUTE_MCP_TOKEN + `x-snarkroute-agent: <name>`: an MCP-authenticated agent;
 * - nothing: anonymous, read-only. A missing token never means "owner".
 */
export function resolveHttpIdentity(ops: AgentOps, request: FastifyRequest): AgentIdentity {
  const token = header(request, "x-snarkroute-agent-token");
  if (token) {
    const identity = ops.registry.identityFromToken(token);
    if (!identity) throw new AgentOpsError("BAD_AGENT_TOKEN", "Токен агента недействителен или истёк.", {}, 401);
    return identity;
  }
  const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7).trim() : undefined;
  const session = header(request, "x-snarkroute-owner-session") ?? (bearer?.startsWith("owner.") ? bearer : undefined);
  if (session) {
    if (!ops.registry.verifyOwnerSession(session, ownerEpoch(ops))) throw new AgentOpsError("BAD_OWNER_SESSION", "Сессия владельца недействительна или отозвана: войдите через Мастерскую.", {}, 401);
    return ops.registry.owner("workshop");
  }
  if (bearer && sameSecret(bearer, process.env.SNARKROUTE_LAUNCHER_TOKEN)) return ops.registry.owner("launcher");
  const name = header(request, "x-snarkroute-agent");
  if (name && bearer && sameSecret(bearer, process.env.SNARKROUTE_MCP_TOKEN)) return ops.registry.mcpClient(name);
  return ops.registry.anonymous();
}

/**
 * One-time owner login codes: minted only for the launcher (which holds the owner's launcher token),
 * valid for two minutes, redeemed once, stored as hashes and never logged (they travel in a POST body
 * and in the URL fragment, which browsers do not send to servers).
 */
export class OwnerLoginCodes {
  private codes = new Map<string, number>();
  private failures: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  issue(): string {
    this.sweep();
    const code = randomBytes(24).toString("base64url");
    this.codes.set(hashCode(code), this.now() + OWNER_CODE_TTL_MS);
    return code;
  }

  redeem(code: string | undefined): boolean {
    this.sweep();
    // A brute-force guard on top of 192-bit codes: at most 10 wrong codes a minute.
    this.failures = this.failures.filter(at => this.now() - at < 60_000);
    if (this.failures.length >= 10) return false;
    const key = code ? hashCode(code) : "";
    const expires = this.codes.get(key);
    this.codes.delete(key);
    if (expires === undefined || expires < this.now()) { this.failures.push(this.now()); return false; }
    return true;
  }

  private sweep(): void { for (const [key, expires] of this.codes) if (expires < this.now()) this.codes.delete(key); }
}

function hashCode(code: string): string { return createHash("sha256").update(code).digest("hex"); }

const ownerEpochs = new WeakMap<object, number>();
export function ownerEpoch(ops: AgentOps): number { return ownerEpochs.get(ops) ?? 0; }

export function registerAgentOpsRoutes(app: FastifyInstance, options: { ops?: Promise<AgentOps>; codes?: OwnerLoginCodes } = {}): void {
  const ready = options.ops ?? startAgentOps({ apiUrl: `http://127.0.0.1:${process.env.SNARKROUTE_API_PORT_FOR_AGENTS ?? "4317"}` });
  ready.catch(error => app.log.error({ err: error }, "agent-ops failed to start"));
  app.addHook("onClose", async () => { (await ready.catch(() => undefined))?.close(); });

  // Every SnarkRoute call carrying an agent token runs as that agent: its model and GPU work is
  // dispatched as background agent work, whatever endpoint it uses (routes, Model Gateway, tools).
  app.addHook("onRequest", (request, reply, done) => {
    const token = header(request, "x-snarkroute-agent-token");
    const ops = options.ops ?? agentOpsInstance();
    if (!ops) { done(); return; }
    if (!token) {
      // Tokenless model/GPU work is attributed by the calling process, never by headers; internal
      // calls (app.inject inside a task) already carry their context.
      const socket = request.raw.socket;
      if (opsContext.getStore() || !isModelWorkRequest(request.method, request.url) || !socket?.remotePort || !socket.localPort) { done(); return; }
      void ops.then(async instance => {
        const attribution = await instance.callers.attribute(socket.remotePort!, socket.localPort!);
        instance.callers.note(request.url.split("?")[0], attribution);
        if (attribution.kind === "agent") opsContext.run({ origin: "agent", agentId: attribution.agentId }, done);
        else if (attribution.kind === "interactive") opsContext.run({ origin: "owner", agentId: `interactive:${attribution.client}` }, done);
        // Unknown caller: treated as background work, the conservative side.
        else opsContext.run({ origin: "agent", agentId: "unidentified" }, done);
      }, () => done());
      return;
    }
    void ops.then(instance => {
      const identity = instance.registry.identityFromToken(token);
      if (!identity) { void reply.code(401).send({ ok: false, code: "BAD_AGENT_TOKEN", error: "Токен агента недействителен или истёк." }); return; }
      opsContext.run({ origin: "agent", agentId: identity.id, ...(identity.taskId ? { taskId: identity.taskId } : {}) }, done);
    }, () => done());
  });

  // Local text through the regular route executor: routing policy, admission and ledger stay authoritative.
  setAgentOpsTextRunner(async (model, prompt, signal, options) => {
    const subscription = SUBSCRIPTION_PROVIDERS.has(model.provider);
    const response = await app.inject({ method: "POST", url: "/api/routes/run", signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]), payload: { route: {
      routeVersion: "0.1", route: { id: `agent-ops-${randomUUID()}`, title: options?.title ?? "Agent ops · text", author: { name: "SnarkRoute" } },
      nodes: [{ id: "answer", type: "ai.text", params: { model: model.providerModelId, providerModelId: model.providerModelId, executionProvider: model.provider,
        promptBase64: Buffer.from(prompt, "utf8").toString("base64"), max_tokens: options?.maxTokens ?? 2048,
        routingPolicy: { allowPaid: false, subscriptionModels: subscription ? "allow" : "exclude" } } }], edges: []
    } } });
    const result = response.json() as Record<string, any>;
    const node = result.nodeResults?.answer ?? {};
    const text = node.output?.text;
    if (response.statusCode !== 200 || result.status !== "succeeded" || typeof text !== "string") {
      return { ok: false, error: errorMessage(node.error ?? result.error ?? `HTTP ${response.statusCode}`), errorCode: node.errorDetails?.code ?? node.errorCode };
    }
    return { ok: true, text, usage: node.output?.actualUsage ?? undefined };
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
  const ownerOnly = (identity: AgentIdentity, what: string) => {
    if (identity.kind !== "owner") throw new AgentOpsError("OWNER_ONLY", `${what}: только владелец (сессия Мастерской).`, { identity: identity.id }, identity.kind === "anonymous" ? 401 : 403);
  };
  const identified = (identity: AgentIdentity) => {
    if (identity.kind === "anonymous") throw new AgentOpsError("IDENTITY_REQUIRED", "Нужна идентификация: токен агента (x-snarkroute-agent-token) или сессия Мастерской.", {}, 401);
  };

  const codes = options.codes ?? new OwnerLoginCodes();
  void ready.then(async ops => { ownerEpochs.set(ops, (await ops.store.readState<{ epoch?: number }>("owner-sessions", {})).epoch ?? 0); }).catch(() => undefined);

  /** The launcher (Bearer launcher token) asks for a one-time code and opens the Workshop with it. */
  app.post(`${ROOT}/owner-login/code`, handle(async (_ops, identity, request, reply) => {
    const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7).trim() : undefined;
    if (identity.kind !== "owner" || !sameSecret(bearer, process.env.SNARKROUTE_LAUNCHER_TOKEN)) {
      return reply.code(403).send({ ok: false, code: "LAUNCHER_ONLY", error: "Одноразовый код выдаётся только лаунчеру." });
    }
    return { ok: true, code: codes.issue(), expiresInMs: OWNER_CODE_TTL_MS };
  }));

  /** The Workshop page redeems the code for a session. No browser header is trusted here. */
  app.post(`${ROOT}/owner-session`, handle(async (ops, _identity, request, reply) => {
    const code = ((request.body ?? {}) as { code?: string }).code;
    if (typeof code !== "string" || !codes.redeem(code)) return reply.code(401).send({ ok: false, code: "BAD_OWNER_CODE", error: "Код входа недействителен, истёк или уже использован: нажмите «Войти» ещё раз." });
    return { ok: true, session: ops.registry.issueOwnerSession(OWNER_SESSION_TTL_MS, ownerEpoch(ops)), expiresInMs: OWNER_SESSION_TTL_MS };
  }));

  /** Ends every owner session at once (lost device, shared screen). */
  app.post(`${ROOT}/owner-session/revoke-all`, handle(async (ops, identity) => {
    ownerOnly(identity, "Отзыв сессий");
    const epoch = ownerEpoch(ops) + 1;
    ownerEpochs.set(ops, epoch);
    await ops.store.writeState("owner-sessions", { epoch, revokedAt: new Date().toISOString() });
    return { ok: true, epoch };
  }));

  /** A launched agent renews its own token before it expires; the identity never changes. */
  app.post(`${ROOT}/token/refresh`, handle(async (ops, identity) => {
    if (identity.kind !== "app" && identity.kind !== "persona") throw new AgentOpsError("NOT_RENEWABLE", "Продлевается только токен запущенного агента.", {}, 403);
    return { ok: true, token: ops.registry.issueAgentToken(identity, AGENT_TOKEN_TTL_MS), expiresInMs: AGENT_TOKEN_TTL_MS };
  }));

  app.get(`${ROOT}/status`, handle(async (ops, identity) => {
    const status = await ops.status();
    const tasks = ops.tasks.list({ limit: 200 }).filter(task => ops.tasks.canRead(task, identity)).slice(0, 60);
    return { ok: true, ...status, identity: { id: identity.id, kind: identity.kind },
      // Other agents' leases and locks are visible as occupancy, not as their task details.
      leases: identity.kind === "owner" ? status.leases : status.leases.map(lease => ({ ...lease, purpose: lease.agentId === identity.id ? lease.purpose : "занято другим агентом" })),
      locks: identity.kind === "owner" ? status.locks : status.locks.map(lock => ({ ...lock, ownerTaskId: tasks.some(task => task.id === lock.ownerTaskId) ? lock.ownerTaskId : "другая задача" })),
      tasks: tasks.map(task => ({ id: task.id, title: task.title, state: task.state, reason: task.reason, executor: task.executor, agentId: task.agentId,
        priority: task.priority, depth: task.chain.depth, createdAt: task.createdAt, updatedAt: task.updatedAt, workdir: task.workdir, attempts: task.attempts.length,
        reworks: task.acceptance?.reworks ?? 0, maxReworks: task.acceptance?.maxReworks ?? null })) };
  }));

  app.get(`${ROOT}/whoami`, handle(async (ops, identity) => ({ ok: true, identity: { id: identity.id, kind: identity.kind, policy: identity.policy, taskId: identity.taskId },
    brief: agentBrief(identity), mode: await ops.mode() })));

  app.get(`${ROOT}/catalog`, handle(async (ops, identity, request) => {
    const query = request.query as { kind?: string; query?: string; availableOnly?: string };
    return { ok: true, entries: await ops.catalog.list(identity, { kind: query.kind as never, query: query.query, availableOnly: query.availableOnly === "1" }) };
  }));

  app.get(`${ROOT}/catalog/:id`, handle(async (ops, identity, request, reply) => {
    const detail = await ops.catalog.detail(identity, (request.params as { id: string }).id);
    return detail ? { ok: true, entry: detail } : reply.code(404).send({ ok: false, error: "Нет такой записи каталога." });
  }));

  app.post(`${ROOT}/route`, handle(async (ops, identity, request) => {
    const spec = normalizeSpec(request.body as TaskSpec);
    await ops.tasks.refreshExecutorProbes(false);
    return { ok: true, candidates: rankExecutors({ spec, policy: identity.policy, adapters: ops.adapters, probes: ops.tasks.probeSnapshot() })
      .map(candidate => ({ ...candidate, availability: ops.ledger.availability(candidate.executorId, candidate.tier) })) };
  }));

  /** Would a lease be granted right now? Reserves nothing. */
  app.post(`${ROOT}/admission`, handle(async (ops, identity, request) => {
    identified(identity);
    const body = (request.body ?? {}) as { class?: "heavy" | "light"; vramMiB?: number; ramMiB?: number; runtimeId?: string };
    const decision = await ops.dispatcher.preview({ holder: "preview", agentId: identity.id, purpose: "preview", origin: identity.kind === "owner" ? "owner" : "agent",
      class: body.class === "heavy" ? "heavy" : "light", vramMiB: body.vramMiB, ramMiB: body.ramMiB, runtimeId: body.runtimeId });
    if (body.class === "heavy" && !identity.policy.canUseHeavyGpu) return { ok: true, granted: false, waitFor: "resources", reason: "Политика агента не разрешает тяжёлую работу с GPU." };
    return { ok: true, ...decision };
  }));

  app.get(`${ROOT}/tasks`, handle(async (ops, identity, request) => {
    const query = request.query as { state?: string; limit?: string; mine?: string };
    return { ok: true, tasks: ops.tasks.list({ agentId: query.mine === "1" ? identity.id : undefined, states: query.state ? query.state.split(",") as TaskState[] : undefined, limit: 1000 })
      .filter(task => ops.tasks.canRead(task, identity)).slice(0, Math.min(500, Number(query.limit) || 100)) };
  }));

  app.post(`${ROOT}/tasks`, handle(async (ops, identity, request, reply) => {
    const { task, deduplicated } = await ops.tasks.submit(identity, request.body as TaskSpec);
    return reply.code(deduplicated ? 200 : 202).send({ ok: true, deduplicated, task });
  }));

  app.get(`${ROOT}/tasks/:id`, handle(async (ops, identity, request) => {
    const task = ops.tasks.requireReadable((request.params as { id: string }).id, identity);
    return { ok: true, task, chainBudget: ops.tasks.chainBudget(task.chain.rootTaskId), events: await ops.tasks.events(task.id) };
  }));

  app.get(`${ROOT}/tasks/:id/result`, handle(async (ops, identity, request) => {
    const task = ops.tasks.requireReadable((request.params as { id: string }).id, identity);
    return { ok: true, id: task.id, state: task.state, reason: task.reason, accepted: task.state === "verified", verified: task.state === "verified", result: task.result ?? null, acceptance: task.acceptance ?? null };
  }));

  app.get(`${ROOT}/tasks/:id/log`, handle(async (ops, identity, request) => {
    const task = ops.tasks.requireReadable((request.params as { id: string }).id, identity);
    return { ok: true, log: await ops.tasks.log(task.id) };
  }));

  app.post(`${ROOT}/tasks/:id/cancel`, handle(async (ops, identity, request) => ({ ok: true, task: await ops.tasks.cancel((request.params as { id: string }).id, identity) })));

  app.post(`${ROOT}/tasks/:id/resolve`, handle(async (ops, identity, request) => {
    const body = (request.body ?? {}) as { action?: "requeue" | "continue" | "mark_failed" | "mark_verified"; note?: string };
    if (!body.action) throw new AgentOpsError("BAD_REQUEST", "Нужно действие: requeue, continue, mark_failed или mark_verified.", {}, 400);
    return { ok: true, task: await ops.tasks.resolve((request.params as { id: string }).id, identity, body.action, body.note) };
  }));

  app.post(`${ROOT}/tasks/:id/verify`, handle(async (ops, identity, request) => ({ ok: true, task: await ops.tasks.verify((request.params as { id: string }).id, identity) })));

  app.put(`${ROOT}/mode`, handle(async (ops, identity, request) => {
    ownerOnly(identity, "Режим компьютера");
    const body = (request.body ?? {}) as { mode?: "owner_busy" | "background" | "free" | null; until?: string | null; minutes?: number };
    const until = body.until ?? (body.minutes ? new Date(Date.now() + Math.min(7 * 24 * 60, body.minutes) * 60_000).toISOString() : null);
    await ops.setManualMode(identity, { mode: body.mode ?? null, until });
    return { ok: true, mode: await ops.mode() };
  }));

  app.put(`${ROOT}/schedule`, handle(async (ops, identity, request) => {
    ownerOnly(identity, "Расписание");
    await ops.setSchedule(identity, ((request.body ?? {}) as { rules?: never[] }).rules ?? []);
    return { ok: true, schedule: ops.modeState().schedule, mode: await ops.mode() };
  }));

  app.put(`${ROOT}/limits`, handle(async (ops, identity, request) => {
    ownerOnly(identity, "Пределы режимов");
    await ops.setLimits(identity, (request.body ?? {}) as never);
    return { ok: true, limits: ops.modeState().limits };
  }));

  app.post(`${ROOT}/leases`, handle(async (ops, identity, request, reply) => {
    identified(identity);
    const body = (request.body ?? {}) as { class?: "heavy" | "light"; purpose?: string; vramMiB?: number; ramMiB?: number; cpuSlots?: number; diskHeavy?: boolean; runtimeId?: string; ttlMinutes?: number };
    const decision = await ops.acquireAgentLease(identity, { class: body.class === "heavy" ? "heavy" : "light", purpose: body.purpose?.slice(0, 200) || "agent work",
      vramMiB: body.vramMiB, ramMiB: body.ramMiB, cpuSlots: body.cpuSlots, diskHeavy: body.diskHeavy, runtimeId: body.runtimeId, ttlMs: body.ttlMinutes ? body.ttlMinutes * 60_000 : undefined });
    return decision.granted ? { ok: true, granted: true, lease: decision.lease } : reply.code(409).send({ ok: false, granted: false, waitFor: decision.waitFor, reason: decision.reason });
  }));

  app.post(`${ROOT}/leases/:id/heartbeat`, handle(async (ops, identity, request) => {
    identified(identity);
    const lease = ops.dispatcher.get((request.params as { id: string }).id);
    if (lease && lease.agentId !== identity.id && identity.kind !== "owner") throw new AgentOpsError("NOT_YOUR_LEASE", "Чужой резерв.", {}, 403);
    return { ok: ops.dispatcher.heartbeat((request.params as { id: string }).id) };
  }));
  app.delete(`${ROOT}/leases/:id`, handle(async (ops, identity, request) => { identified(identity); return { ok: ops.releaseAgentLease(identity, (request.params as { id: string }).id) }; }));

  app.get(`${ROOT}/agents`, handle(async (ops, identity) => { ownerOnly(identity, "Список агентов"); return { ok: true, agents: ops.registry.list(), policies: ops.registry.policyDocument() }; }));

  // Limits and outages are tested by simulation; real subscriptions are never exhausted on purpose.
  app.post(`${ROOT}/simulate`, handle(async (ops, identity, request) => {
    ownerOnly(identity, "Симуляции");
    const body = (request.body ?? {}) as { executor?: string; failure?: FailureClass; seconds?: number };
    if (!body.executor || !ops.adapters.some(adapter => adapter.id === body.executor)) throw new AgentOpsError("BAD_REQUEST", "Неизвестный исполнитель.", {}, 400);
    const failure = body.failure ?? "quota_exhausted";
    const seconds = Math.min(3600, Math.max(5, body.seconds ?? 300));
    ops.ledger.recordFailure(body.executor, { class: failure, message: `Симуляция: ${failure}`, resetsAt: new Date(Date.now() + seconds * 1000).toISOString(), source: "simulation", simulated: true });
    if (failure === "auth") ops.ledger.recordAuth(body.executor, "not_logged_in", "simulation", "Симуляция ошибки авторизации");
    ops.tasks.kick();
    return { ok: true, ledger: ops.ledger.view(body.executor) };
  }));

  app.delete(`${ROOT}/simulate/:executor`, handle(async (ops, identity, request) => {
    ownerOnly(identity, "Симуляции");
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

function sameSecret(given: string | undefined, expected: string | undefined): boolean {
  const secret = expected?.trim();
  if (!given || !secret) return false;
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
