import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { NodeResult } from "@snarkroute/executor";
import { builtInNodeManifests, loadInstalledNodeManifests, validatePromptLibraryNodes, validateRouteNodeTypes } from "@snarkroute/nodes";
import { parseRoute, validateRoute } from "@snarkroute/protocol";
import { createLocalRunStorage } from "@snarkroute/storage";
import { createRouteExecutor } from "../execution/service";
import { providerNodeManifests } from "../providers/provider-node-manifests";
import type { AuthUser } from "../auth/adapters";
import { getAuthAdapter } from "../auth/adapters";
import { getBillingAdapter } from "../billing/adapters";
import { envKeyForProvider, UserSessionCredentialAdapter } from "../credentials/adapters";
import { appMode } from "../services/env";
import { getCloudStorage } from "../services/cloud-storage";
import { errorMessage, redactSecrets, userFacingErrorMessage } from "../services/errors";
import { validateGuestDemoRoute } from "./demo-routes";

const storage = createLocalRunStorage(join(process.cwd(), "data", "runs"));
const guestDemoRunsBySession = new Map<string, number>();

type RunRequestBody = { route?: unknown; initialNodeOutputs?: Record<string, unknown>; userSessionCredentials?: Record<string, Record<string, string> | string> };

export async function registerExecutionRoutes(app: FastifyInstance) {
app.post("/api/routes/validate", async (request) => {
  const validation = validateRoute(request.body);
  if (!validation.ok || !validation.route) return validation;
  const promptIssues = await validatePromptLibraryNodes(validation.route.nodes);
  const nodeTypeIssues = await validateRouteNodeTypes(validation.route.nodes, [...builtInNodeManifests, ...providerNodeManifests(), ...(await loadInstalledNodeManifests())]);
  const issues = [...promptIssues, ...nodeTypeIssues];
  return {
    ok: issues.length === 0,
    route: issues.length === 0 ? validation.route : undefined,
    issues
  };
});

app.post<{ Body: RunRequestBody }>("/api/routes/run", async (request, reply) => {
  let cloudRunId = "";
  let reservationId = "";
  let reservationAmount = 0;
  try {
    const routeInput = request.body && typeof request.body === "object" && "routeVersion" in request.body ? request.body : request.body?.route;
    const route = parseRoute(routeInput);
    const actor = await authorizeRunActor(route, request, reply);
    const estimate = await getBillingAdapter().estimateRunCost(route);
    const executor = await createRouteExecutor();
    const bookkeeping: Promise<void>[] = [];
    if (appMode() === "cloud") {
      cloudRunId = randomUUID();
      await getCloudStorage().createRun({
        id: cloudRunId,
        userId: actor.user?.id ?? null,
        inputs: { routeId: route.route.id, initialNodeOutputs: request.body?.initialNodeOutputs ?? {}, actorType: actor.actorType, guestSessionId: actor.guestSessionId ?? null }
      });
    }
    const runId = cloudRunId || `run_${Date.now()}`;
    const reservation = actor.user ? await getBillingAdapter().reserveCredits(runId, estimate.totalEstimatedCredits, actor.user.id) : { reservationId: "", amount: 0 };
    reservationId = reservation.reservationId;
    reservationAmount = reservation.amount;
    const outputDirectory = await storage.createRunDirectory(runId);
    const result = await withUserSessionCredentials(route, request.body?.userSessionCredentials, () =>
      executor.executeRoute(route, {
        runId,
        outputDirectory,
        initialNodeOutputs: request.body?.initialNodeOutputs,
        onNodeResult: (nodeResult: NodeResult) => {
          if (cloudRunId) bookkeeping.push(persistCloudNodeResult(cloudRunId, nodeResult, { user: actor.user, recordCredits: actor.actorType === "guest" || reservation.amount > 0 }));
        }
      })
    );
    await Promise.all(bookkeeping);
    if (actor.user && reservation.amount === 0) zeroRunCreditCharges(result);
    if (actor.user && reservationId) {
      const billing = await getBillingAdapter().commitCredits(reservationId, result.costSummary.totalActualCredits);
      result.costSummary.refundedCredits = billing.refunded;
    }
    if (cloudRunId) await finishCloudRunSafely({ runId: cloudRunId, status: "completed", outputs: sanitizeCloudJson(result) });
    return result;
  } catch (error) {
    if (reservationId && reservationAmount > 0) await getBillingAdapter().refundCredits(reservationId, reservationAmount).catch(() => undefined);
    if (cloudRunId) await finishCloudRunSafely({ runId: cloudRunId, status: "failed", error: errorMessage(error) });
    return reply.code(runErrorStatus(error)).send({ error: userFacingErrorMessage(error) });
  }
});

app.post<{ Body: RunRequestBody }>("/api/routes/run/stream", async (request, reply) => {
  let cloudRunId = "";
  let reservationId = "";
  let reservationAmount = 0;
  reply.raw.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("X-Accel-Buffering", "no");

  const sendEvent = (event: Record<string, unknown>) => {
    reply.raw.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const routeInput = request.body && typeof request.body === "object" && "routeVersion" in request.body ? request.body : request.body?.route;
    const route = parseRoute(routeInput);
    const actor = await authorizeRunActor(route, request, reply);
    const estimate = await getBillingAdapter().estimateRunCost(route);
    const executor = await createRouteExecutor();
    const bookkeeping: Promise<void>[] = [];
    if (appMode() === "cloud") {
      cloudRunId = randomUUID();
      await getCloudStorage().createRun({
        id: cloudRunId,
        userId: actor.user?.id ?? null,
        inputs: { routeId: route.route.id, initialNodeOutputs: request.body?.initialNodeOutputs ?? {}, actorType: actor.actorType, guestSessionId: actor.guestSessionId ?? null }
      });
    }
    const runId = cloudRunId || `run_${Date.now()}`;
    const reservation = actor.user ? await getBillingAdapter().reserveCredits(runId, estimate.totalEstimatedCredits, actor.user.id) : { reservationId: "", amount: 0 };
    reservationId = reservation.reservationId;
    reservationAmount = reservation.amount;
    const outputDirectory = await storage.createRunDirectory(runId);
    sendEvent({ type: "runStarted", runId, startedAt: new Date().toISOString(), estimate });
    const result = await withUserSessionCredentials(route, request.body?.userSessionCredentials, () =>
      executor.executeRoute(route, {
        runId,
        outputDirectory,
        initialNodeOutputs: request.body?.initialNodeOutputs,
        onNodeResult: (nodeResult: NodeResult) => {
          sendEvent({ type: "nodeResult", nodeResult });
          if (cloudRunId) bookkeeping.push(persistCloudNodeResult(cloudRunId, nodeResult, { user: actor.user, recordCredits: actor.actorType === "guest" || reservation.amount > 0 }));
        }
      })
    );
    await Promise.all(bookkeeping);
    if (actor.user && reservation.amount === 0) zeroRunCreditCharges(result);
    if (actor.user && reservationId) {
      const billing = await getBillingAdapter().commitCredits(reservationId, result.costSummary.totalActualCredits);
      result.costSummary.refundedCredits = billing.refunded;
    }
    if (cloudRunId) await finishCloudRunSafely({ runId: cloudRunId, status: "completed", outputs: sanitizeCloudJson(result) });
    sendEvent({ type: "runCompleted", result });
  } catch (error) {
    if (reservationId && reservationAmount > 0) await getBillingAdapter().refundCredits(reservationId, reservationAmount).catch(() => undefined);
    if (cloudRunId) await finishCloudRunSafely({ runId: cloudRunId, status: "failed", error: errorMessage(error) });
    sendEvent({ type: "runFailed", error: userFacingErrorMessage(error) });
  } finally {
    reply.raw.end();
  }
  return reply;
});
}

async function authorizeRunActor(route: ReturnType<typeof parseRoute>, request: FastifyRequest<{ Body: RunRequestBody }>, reply: FastifyReply): Promise<{ actorType: "user" | "guest"; user: AuthUser | null; guestSessionId?: string }> {
  if (appMode() !== "cloud") return { actorType: "user", user: await getAuthAdapter().requireUser(request) };
  const user = await getAuthAdapter().getCurrentUser(request);
  if (user) return { actorType: "user", user };
  validateGuestDemoRoute(route);
  if (request.body?.userSessionCredentials && Object.keys(request.body.userSessionCredentials).length > 0) throw new Error("Guest demo cannot use user credentials.");
  const guestSessionId = ensureGuestSessionId(request, reply);
  const limit = Number(process.env.BOOJUM_GUEST_DEMO_RUN_LIMIT ?? 5);
  const used = guestDemoRunsBySession.get(guestSessionId) ?? 0;
  if (Number.isFinite(limit) && limit > 0 && used >= limit) throw new Error("Guest demo run limit reached. Please log in to continue.");
  guestDemoRunsBySession.set(guestSessionId, used + 1);
  return { actorType: "guest", user: null, guestSessionId };
}

function ensureGuestSessionId(request: FastifyRequest, reply: FastifyReply): string {
  const existing = cookieValue(request.headers.cookie, "boojum_guest_session");
  if (existing) return existing;
  const guestSessionId = randomUUID();
  reply.header("Set-Cookie", `boojum_guest_session=${guestSessionId}; Path=/; SameSite=Lax; Max-Age=86400`);
  return guestSessionId;
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  const parts = (cookieHeader ?? "").split(";");
  for (const part of parts) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function runErrorStatus(error: unknown): number {
  const message = errorMessage(error);
  if (/Guest demo|user credentials|run limit/i.test(message)) return 403;
  if (/Login is required/i.test(message)) return 401;
  return 400;
}

async function withUserSessionCredentials<T>(route: ReturnType<typeof parseRoute>, credentials: RunRequestBody["userSessionCredentials"], run: () => Promise<T>): Promise<T> {
  const providers = providersRequiringUserSession(route);
  if (providers.length === 0) return run();
  const adapter = new UserSessionCredentialAdapter(credentials);
  const previous = new Map<string, string | undefined>();
  try {
    for (const provider of providers) {
      const envKey = envKeyForProvider(provider);
      if (!envKey) continue;
      const secret = await adapter.getCredential(provider, "default");
      if (!secret) throw new Error(`${provider} user-session credential is required for this run.`);
      previous.set(envKey, process.env[envKey]);
      process.env[envKey] = secret;
    }
    return await run();
  } finally {
    for (const [envKey, value] of previous) {
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
}

function providersRequiringUserSession(route: ReturnType<typeof parseRoute>): string[] {
  const providers = new Set<string>();
  for (const node of route.nodes) {
    const params = node.params ?? {};
    if (params.credentialMode !== "user-session") continue;
    const provider = credentialProviderForNode(node.type, params);
    if (provider) providers.add(provider);
  }
  return [...providers];
}

function credentialProviderForNode(type: string, params: Record<string, unknown>): string | null {
  const providerMode = typeof params.providerMode === "string" ? params.providerMode : "";
  if (providerMode === "openrouter") return "openrouter";
  if (type.includes("openrouter") || type === "ai.text" || type === "ai.image.generate") return "openrouter";
  if (type.startsWith("polza.")) return "polza";
  if (type.startsWith("replicate.")) return "replicate";
  return null;
}

function zeroRunCreditCharges(result: { costSummary?: { actuals: Array<{ actualCredits: number }>; totalActualCredits: number; refundedCredits: number }; nodeResults?: Record<string, NodeResult> }) {
  if (!result.costSummary) return;
  result.costSummary.actuals = result.costSummary.actuals.map((entry) => ({ ...entry, actualCredits: 0 }));
  result.costSummary.totalActualCredits = 0;
  result.costSummary.refundedCredits = 0;
  for (const node of Object.values(result.nodeResults ?? {})) node.actualCredits = 0;
}

async function persistCloudNodeResult(runId: string, nodeResult: NodeResult, options: { user: AuthUser | null; recordCredits: boolean }): Promise<void> {
  const storage = getCloudStorage();
  const nodeRun = await storage.saveNodeRun(nodeRunInput(runId, nodeResult, options.recordCredits));
  const artifacts = await saveArtifactsForNodeResult(runId, nodeRun.id, nodeResult, options.user);
  if (artifacts.length > 0) await storage.updateNodeRunOutputs(nodeRun.id, attachArtifactRefs(sanitizeCloudJson(nodeResult.output), artifacts));
  await saveProviderUsageEventsForNodeResult(runId, nodeRun.id, nodeResult, options);
}

async function saveArtifactsForNodeResult(runId: string, nodeRunId: string, nodeResult: NodeResult, user: AuthUser | null): Promise<Array<{ id: string; nodeId: string; storageKey: string }>> {
  const candidates = artifactCandidates(nodeResult.output);
  const saved: Array<{ id: string; nodeId: string; storageKey: string }> = [];
  for (const candidate of candidates) {
    const size = candidate.bytes ?? await fileSize(candidate.localPath ?? candidate.path);
    const relativePath = localRelativePath(candidate.localPath ?? candidate.path);
    const storageKey = relativePath ?? candidate.storageKey ?? candidate.path;
    const artifact = await getCloudStorage().saveArtifact({
      runId,
      nodeRunId,
      nodeId: nodeResult.nodeId,
      ownerUserId: user?.id ?? null,
      artifactKind: candidate.kind,
      storageUri: storageKey,
      storageBackend: "local",
      storageKey,
      relativePath,
      mimeType: candidate.mimeType,
      bytes: size,
      metadata: safeJson({ model: candidate.model, originalUrl: candidate.originalUrl, sourceNodeId: candidate.sourceNodeId })
    });
    saved.push({ id: artifact.id, nodeId: nodeResult.nodeId, storageKey });
  }
  return saved;
}

async function saveProviderUsageEventsForNodeResult(runId: string, nodeRunId: string, nodeResult: NodeResult, options: { user: AuthUser | null; recordCredits: boolean }): Promise<void> {
  const estimate = nodeResult.costEstimate;
  const events = nodeResult.providerUsage?.length ? nodeResult.providerUsage : estimate?.provider ? [{ provider: estimate.provider, model: estimate.model, status: nodeResult.status }] : [];
  for (const event of events) {
    const provider = event.provider;
    if (!provider) continue;
    await getCloudStorage().saveProviderUsageEvent({
      runId,
      nodeRunId,
      userId: options.user?.id ?? null,
      nodeId: nodeResult.nodeId,
      nodeType: nodeResult.type,
      provider,
      modelId: event.providerModel ?? event.model ?? estimate?.model ?? null,
      operation: nodeResult.type,
      status: event.status ?? nodeResult.status,
      usage: safeJson(event.metrics ?? nodeResult.actualUsage ?? {}),
      estimatedCredits: estimate?.estimatedCredits ?? null,
      actualCredits: options.recordCredits ? nodeResult.actualCredits ?? null : 0,
      usageSource: nodeResult.usageSource ?? estimate?.usageSource ?? "unknown",
      providerCostEstimateAmount: event.estimatedCost ?? estimate?.estimatedProviderCostAmount ?? null,
      providerCostActualAmount: event.actualCost ?? nodeResult.actualProviderCostAmount ?? null,
      currency: event.actualCostCurrency ?? estimate?.providerCostCurrency ?? null,
      providerRequestId: event.externalId ?? null,
      metadata: safeJson({ pricingHint: event.pricingHint, pricingSource: event.pricingSource, pricingQuote: event.pricingQuote })
    });
  }
}

function artifactCandidates(value: unknown, found: Array<Record<string, any>> = []): Array<Record<string, any>> {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) artifactCandidates(item, found);
    return found;
  }
  const record = value as Record<string, any>;
  const localPath = typeof record.localPath === "string" ? record.localPath : undefined;
  const path = typeof record.path === "string" ? record.path : undefined;
  const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
  if ((localPath || path) && mimeType) {
    found.push({
      localPath,
      path,
      mimeType,
      bytes: typeof record.sizeBytes === "number" ? record.sizeBytes : undefined,
      model: typeof record.model === "string" ? record.model : undefined,
      originalUrl: typeof record.originalUrl === "string" ? record.originalUrl : undefined,
      sourceNodeId: typeof record.sourceNodeId === "string" ? record.sourceNodeId : undefined,
      kind: mimeType.startsWith("video/") ? "video" : mimeType.startsWith("image/") ? "image" : "artifact"
    });
  }
  for (const item of Object.values(record)) artifactCandidates(item, found);
  return found;
}

async function fileSize(path: string | undefined): Promise<number | null> {
  if (!path || !isAbsolute(path)) return null;
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function localRelativePath(path: string | undefined): string | null {
  if (!path || !isAbsolute(path)) return null;
  const rel = relative(process.cwd(), path).replace(/\\/g, "/");
  return rel.startsWith("..") ? null : rel;
}

function attachArtifactRefs(output: unknown, artifacts: Array<{ id: string; nodeId: string; storageKey: string }>): unknown {
  if (artifacts.length === 0 || !output || typeof output !== "object") return output;
  return { ...(output as Record<string, unknown>), artifacts: artifacts.map((artifact) => ({ artifactId: artifact.id, storageKey: artifact.storageKey })) };
}

function sanitizeCloudJson(value: unknown): unknown {
  const text = redactSecrets(JSON.stringify(value ?? null));
  return JSON.parse(text, (_key, item) => {
    if (typeof item !== "string" || !isAbsolute(item)) return item;
    return localRelativePath(item) ?? "[local-path]";
  });
}

function safeJson(value: unknown): unknown {
  return JSON.parse(redactSecrets(JSON.stringify(value ?? {})));
}

async function finishCloudRunSafely(input: { runId: string; status: string; outputs?: unknown; error?: unknown }) {
  try {
    await getCloudStorage().finishRun(input);
  } catch {
    // Preserve the execution response path even when cloud bookkeeping fails.
  }
}

function nodeRunInput(runId: string, nodeResult: NodeResult, chargeCredits: boolean) {
  const estimate = nodeResult.costEstimate;
  const usage = nodeResult.actualUsage ?? {};
  return {
    runId,
    nodeId: nodeResult.nodeId,
    nodeType: nodeResult.type,
    provider: estimate?.provider ?? null,
    model: estimate?.model ?? null,
    status: nodeResult.status,
    outputs: nodeResult.output ?? null,
    error: nodeResult.error ?? null,
    estimatedCredits: estimate?.estimatedCredits ?? null,
    actualCredits: chargeCredits ? nodeResult.actualCredits ?? null : 0,
    estimatedProviderCostAmount: estimate?.estimatedProviderCostAmount ?? null,
    actualProviderCostAmount: nodeResult.actualProviderCostAmount ?? null,
    providerCostCurrency: estimate?.providerCostCurrency ?? null,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    imageCount: usage.imageCount ?? null,
    videoSeconds: usage.videoSeconds ?? null,
    requestCount: usage.requestCount ?? null,
    usageSource: nodeResult.usageSource ?? estimate?.usageSource ?? "unknown"
  };
}

export async function registerRunResultRoutes(app: FastifyInstance) {
app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
  try {
    return await storage.readRunResult(request.params.runId);
  } catch {
    return reply.code(404).send({ error: `Run "${request.params.runId}" was not found.` });
  }
});
}

