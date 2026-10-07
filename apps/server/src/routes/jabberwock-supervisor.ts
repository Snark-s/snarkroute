import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { z } from "zod";
import { isLoopbackAddress, isLoopbackHost } from "./after-effects";
import { JabberwockMemoryService } from "../jabberwock-memory/service";
import { SupervisorBridge } from "../jabberwock-memory/supervisor-bridge";
import { RouteRunner, RouteRunnerError } from "../jabberwock-memory/route-runner";
import { continueRouteSchema, createRouteSchema } from "../jabberwock-memory/route-input";
import { appMode } from "../services/env";
import { userFacingErrorMessage } from "../services/errors";

const basePath = "/api/jabberwock/supervisor";
const writeBodyLimit = 128 * 1024;
const defaultSupervisorTimeoutMs = 600_000;

const projectInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4_000).optional(),
  rootPath: z.string().trim().min(1).max(2_000)
}).strict();

const defaultModelInput = z.object({
  modelId: z.string().trim().min(1).max(300)
}).strict();

const taskInput = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(300),
  originalRequest: z.string().trim().min(1).max(16_000)
}).strict();

const stepInput = z.object({
  instruction: z.string().trim().min(1).max(8_000),
  routingMode: z.enum(["auto", "fixed"]).optional(),
  model: z.string().trim().min(1).nullable().optional(),
  runtimeMode: z.enum(["text", "agent"]).optional(),
  permissions: z.enum(["read_only", "read_write"]).optional(),
  maxToolTurns: z.number().int().min(1).max(16).optional(),
  toolProtocol: z.enum(["native", "json", "auto"]).optional(),
  constraints: z.union([
    z.array(z.string().trim().min(1).max(1_000)).max(20),
    z.record(z.unknown())
  ]).optional(),
  expectedOutput: z.union([
    z.string().trim().min(1).max(4_000),
    z.array(z.string().trim().min(1).max(1_000)).min(1).max(20)
  ]).optional()
}).strict().refine((body) => body.routingMode !== "fixed" || Boolean(body.model), {
  message: "model is required when routingMode is fixed",
  path: ["model"]
});

const assessmentItem = z.union([
  z.string().trim().min(1).max(2_000),
  z.object({ text: z.string().trim().min(1).max(2_000), source: z.string().trim().min(1).max(300).optional() }).strict()
]);
const decisionItem = z.union([
  z.string().trim().min(1).max(2_000),
  z.object({ text: z.string().trim().min(1).max(2_000), rationale: z.string().trim().min(1).max(2_000).optional() }).strict()
]);
const assessmentInput = z.object({
  assessment: z.string().trim().min(1).max(4_000),
  accepted: z.boolean(),
  facts: z.array(assessmentItem).max(20).optional(),
  decisions: z.array(decisionItem).max(20).optional()
}).strict();

export function registerJabberwockSupervisorRoutes(
  app: FastifyInstance,
  memory: JabberwockMemoryService,
  bridge: SupervisorBridge
): RouteRunner {
  const runner = new RouteRunner(memory, bridge);
  const streams = new Set<ServerResponse>();
  app.addHook("onReady", async () => runner.recover());
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
    await runner.close();
  });
  app.addHook("onClose", async () => runner.close());
  app.register(async (scope) => {
    scope.setErrorHandler((error, request, reply) => {
      if (error instanceof RouteRunnerError) return sendError(reply, error.code.endsWith("NOT_FOUND") ? 404 : error.code === "INVALID_REQUEST" ? 400 : 409, error.code, error.message);
      if (error.statusCode === 400 || error.statusCode === 413) {
        return sendError(reply, error.statusCode, "INVALID_REQUEST", "Invalid request body.");
      }
      return internalError(request, reply, error);
    });
    scope.addHook("onRequest", async (request, reply) => {
      if (appMode() !== "local") return sendError(reply, 404, "UNAVAILABLE", "Supervisor API is available only in local mode.");
      const remoteAddress = request.raw.socket.remoteAddress ?? request.ip;
      if (!isLoopbackAddress(remoteAddress) || !isLoopbackHost(request.hostname) || !allowedOrigin(request.headers.origin)) {
        return sendError(reply, 403, "FORBIDDEN", "Supervisor API requires an allowed local client.");
      }
      reply.header("Cache-Control", "no-store");
    });

    scope.get("/capabilities", async () => ({
      ok: true,
      data: {
        available: true,
        version: 1,
        features: { workingMemory: true, autoRouting: true, fixedRouting: true, atomicAgent: true, readOnlyTools: true, assessment: true,
          routeRunner: true, persistentRoutes: true, routeEvents: true },
        routeOperations: ["create_route", "start_route", "get_route_state", "get_escalation", "continue_route", "cancel_route"]
      }
    }));

    scope.get("/projects", async () => ({ ok: true, data: memory.list_projects() }));
    scope.post("/routes", { bodyLimit: writeBodyLimit }, async (request, reply) => {
      const input = createRouteSchema.safeParse(request.body);
      if (!input.success) return invalidRequest(reply, input.error);
      const route = runner.create_route(input.data);
      return reply.code(201).send({ ok: true, data: runner.get_route_state(route.id) });
    });
    scope.get<{ Params: { routeId: string } }>("/routes/:routeId", async request => ({ ok: true, data: runner.get_route_state(request.params.routeId) }));
    scope.get<{ Params: { routeId: string } }>("/routes/:routeId/escalation", async request => ({ ok: true, data: runner.get_escalation(request.params.routeId) }));
    scope.post<{ Params: { routeId: string } }>("/routes/:routeId/start", async request => {
      runner.start_route(request.params.routeId); return { ok: true, data: runner.get_route_state(request.params.routeId) };
    });
    scope.post<{ Params: { routeId: string } }>("/routes/:routeId/cancel", async request => {
      runner.cancel_route(request.params.routeId); return { ok: true, data: runner.get_route_state(request.params.routeId) };
    });
    scope.post<{ Params: { routeId: string } }>("/routes/:routeId/continue", { bodyLimit: writeBodyLimit }, async (request, reply) => {
      const input = continueRouteSchema.safeParse(request.body);
      if (!input.success) return invalidRequest(reply, input.error);
      runner.continue_route({ routeId: request.params.routeId, ...input.data });
      return { ok: true, data: runner.get_route_state(request.params.routeId) };
    });
    scope.get<{ Params: { routeId: string } }>("/routes/:routeId/events", async (request, reply) => {
      const initial = runner.get_route_state(request.params.routeId);
      reply.hijack();
      reply.raw.writeHead(200, { ...reply.getHeaders(), "Content-Type": "text/event-stream", "Connection": "keep-alive", "Cache-Control": "no-store" } as OutgoingHttpHeaders);
      streams.add(reply.raw);
      const send = (state: ReturnType<RouteRunner["get_route_state"]>) => {
        if (state.id !== initial.id || reply.raw.destroyed || reply.raw.writableEnded) return;
        reply.raw.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        if (["completed", "blocked", "cancelled", "failed"].includes(state.status)) reply.raw.end();
      };
      runner.events.on("state", send);
      const heartbeat = setInterval(() => { if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(": keepalive\n\n"); }, 15_000);
      heartbeat.unref();
      reply.raw.once("close", () => { streams.delete(reply.raw); clearInterval(heartbeat); runner.events.off("state", send); });
      send(initial);
    });
  scope.get("/default-model", async () => ({ ok: true, data: { modelId: memory.get_setting("jabberwock.defaultModel") } }));
  scope.put("/default-model", async (request, reply) => { const input = defaultModelInput.safeParse(request.body); if (!input.success) return sendError(reply, 400, "INVALID_REQUEST", "Invalid request body."); memory.set_setting("jabberwock.defaultModel", input.data.modelId); return { ok: true, data: { modelId: input.data.modelId } }; });

    scope.get<{ Querystring: { name?: string } }>("/projects/find", async (request, reply) => {
      const name = request.query.name?.trim();
      if (!name) return sendError(reply, 400, "INVALID_REQUEST", "name is required.");
      const project = memory.list_projects()
        .filter((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
      if (!project) return sendError(reply, 404, "PROJECT_NOT_FOUND", `Project "${name}" was not found.`);
      return { ok: true, data: project };
    });

    scope.post("/projects", { bodyLimit: writeBodyLimit }, async (request, reply) => {
      const input = projectInput.safeParse(request.body);
      if (!input.success) return invalidRequest(reply, input.error);
      try {
        const project = memory.create_project({
          name: input.data.name,
          description: input.data.description,
          root_path: input.data.rootPath
        });
        return reply.code(201).send({ ok: true, data: project });
      } catch (error) {
        return internalError(request, reply, error);
      }
    });

    scope.post("/tasks", { bodyLimit: writeBodyLimit }, async (request, reply) => {
      const input = taskInput.safeParse(request.body);
      if (!input.success) return invalidRequest(reply, input.error);
      if (!memory.get_project(input.data.projectId)) return sendError(reply, 404, "PROJECT_NOT_FOUND", `Project "${input.data.projectId}" was not found.`);
      try {
        const task = memory.create_task({
          project_id: input.data.projectId,
          title: input.data.title,
          original_request: input.data.originalRequest
        });
        return reply.code(201).send({ ok: true, data: task });
      } catch (error) {
        return internalError(request, reply, error);
      }
    });

    scope.get<{ Params: { taskId: string } }>("/tasks/:taskId", async (request, reply) => {
      if (!memory.get_task(request.params.taskId)) return sendError(reply, 404, "TASK_NOT_FOUND", `Task "${request.params.taskId}" was not found.`);
      try {
        return { ok: true, data: bridge.supervisorGetState(request.params.taskId) };
      } catch (error) {
        return internalError(request, reply, error);
      }
    });

    scope.post<{ Params: { taskId: string } }>("/tasks/:taskId/steps", { bodyLimit: writeBodyLimit }, async (request, reply) => {
      const input = stepInput.safeParse(request.body);
      if (!input.success) return invalidRequest(reply, input.error);
      if (!memory.get_task(request.params.taskId)) return sendError(reply, 404, "TASK_NOT_FOUND", `Task "${request.params.taskId}" was not found.`);
      if (memory.project_has_running_route(request.params.taskId)) return sendError(reply, 409, "PROJECT_BUSY", "A route is already running in this project.");
      const lifecycle = supervisorRequestLifecycle(request, reply, request.params.taskId);
      const executeInput = {
        taskId: request.params.taskId,
        instruction: input.data.instruction,
        signal: lifecycle.signal,
        routingMode: input.data.routingMode,
        model: input.data.model ?? undefined,
        runtimeMode: input.data.runtimeMode,
        permissions: input.data.permissions,
        maxToolTurns: input.data.maxToolTurns,
        toolProtocol: input.data.toolProtocol,
        constraints: input.data.constraints,
        expectedOutput: Array.isArray(input.data.expectedOutput)
          ? input.data.expectedOutput.join("\n- ")
          : input.data.expectedOutput
      };
      if ((request.query as { stream?: string }).stream === "1") {
        // Chrome MV3 terminates worker fetches that do not receive a response within 30 seconds.
        // Start a JSON stream now; whitespace heartbeats keep the response open until the step ends.
        reply.header("Content-Type", "application/json; charset=utf-8");
        reply.hijack();
        reply.raw.writeHead(200, reply.getHeaders() as OutgoingHttpHeaders);
        reply.raw.write(" ");
        const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(" "); }, 15_000);
        heartbeat.unref();
        try {
          const result = await bridge.supervisorExecuteStep(executeInput);
          if (!reply.raw.destroyed) reply.raw.end(JSON.stringify(result.status === "failed"
            ? { ok: false, error: { code: result.failureStage === "routing" ? "ROUTING_FAILURE" : "RUNTIME_FAILURE",
                message: userFacingErrorMessage(result.error ?? result.summary) }, data: result }
            : { ok: true, data: result }));
        } catch (error) {
          request.log.error({ err: error }, "Jabberwock streamed step failed");
          if (!reply.raw.destroyed) reply.raw.end(JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "Supervisor API request failed." } }));
        } finally {
          clearInterval(heartbeat);
          lifecycle.dispose();
        }
        return;
      }
      try {
        const result = await bridge.supervisorExecuteStep(executeInput);
        if (result.status === "failed") {
          const code = result.failureStage === "routing" ? "ROUTING_FAILURE" : "RUNTIME_FAILURE";
          const message = userFacingErrorMessage(result.error ?? result.summary);
          return reply.code(502).send({ ok: false, error: { code, message }, data: { ...result, summary: message, error: message } });
        }
        return { ok: true, data: result };
      } catch (error) {
        return internalError(request, reply, error);
      } finally {
        lifecycle.dispose();
      }
    });

    scope.post<{ Params: { taskId: string; stepId: string } }>("/tasks/:taskId/steps/:stepId/assessment", { bodyLimit: writeBodyLimit }, async (request, reply) => {
      const input = assessmentInput.safeParse(request.body);
      if (!input.success) return invalidRequest(reply, input.error);
      if (!memory.get_task(request.params.taskId)) return sendError(reply, 404, "TASK_NOT_FOUND", `Task "${request.params.taskId}" was not found.`);
      const step = memory.get_step(request.params.stepId);
      if (!step || step.task_id !== request.params.taskId) return sendError(reply, 404, "STEP_NOT_FOUND", `Step "${request.params.stepId}" was not found in this task.`);
      try {
        return { ok: true, data: bridge.supervisorRecordAssessment({
          taskId: request.params.taskId,
          stepId: request.params.stepId,
          assessment: input.data.assessment,
          accepted: input.data.accepted,
          facts: input.data.facts,
          decisions: input.data.decisions
        }) };
      } catch (error) {
        return internalError(request, reply, error);
      }
    });
  }, { prefix: basePath });
  return runner;
}

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname)) return true;
    if (parsed.protocol !== "chrome-extension:") return false;
    const allowedIds = (process.env.JABBERWOCK_SUPERVISOR_EXTENSION_IDS ?? "")
      .split(",").map((id) => id.trim().toLowerCase()).filter((id) => /^[a-p]{32}$/.test(id));
    return allowedIds.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function invalidRequest(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const issue = error.issues[0];
  const message = issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request body.";
  return sendError(reply, 400, "INVALID_REQUEST", message);
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ ok: false, error: { code, message } });
}

function internalError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  request.log.error({ err: error }, "Jabberwock supervisor API failed");
  return sendError(reply, 500, "INTERNAL_ERROR", "Supervisor API request failed.");
}

function supervisorRequestLifecycle(
  request: FastifyRequest,
  reply: FastifyReply,
  taskId: string
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeoutMs = supervisorTimeoutMs();
  const abort = (message: string) => {
    if (controller.signal.aborted) return;
    const error = new Error(message);
    error.name = "AbortError";
    controller.abort(error);
    request.log.info({ taskId, reason: message }, "Jabberwock supervisor request aborted");
  };
  const requestAborted = () => abort("Supervisor client request was aborted.");
  const responseClosed = () => {
    if (!reply.raw.writableEnded) abort("Supervisor client disconnected.");
  };
  request.raw.once("aborted", requestAborted);
  reply.raw.once("close", responseClosed);
  const timer = setTimeout(() => abort(`Supervisor step timed out after ${timeoutMs} ms.`), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      request.raw.removeListener("aborted", requestAborted);
      reply.raw.removeListener("close", responseClosed);
    }
  };
}

function supervisorTimeoutMs(): number {
  const parsed = Number(process.env.JABBERWOCK_SUPERVISOR_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 3_600_000) : defaultSupervisorTimeoutMs;
}
