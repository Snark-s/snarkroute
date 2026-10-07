import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JabberwockMemoryService } from "../jabberwock-memory/service";
import { SupervisorBridge, type SupervisorAgentRuntime, type SupervisorModelRouter } from "../jabberwock-memory/supervisor-bridge";
import { registerJabberwockSupervisorRoutes } from "./jabberwock-supervisor";

const prefix = "/api/jabberwock/supervisor";
const previousMode = process.env.APP_MODE;
const previousExtensionIds = process.env.JABBERWOCK_SUPERVISOR_EXTENSION_IDS;
const previousSupervisorTimeout = process.env.JABBERWOCK_SUPERVISOR_TIMEOUT_MS;
let app: FastifyInstance;
let memory: JabberwockMemoryService;
let runtime: SupervisorAgentRuntime;
let router: SupervisorModelRouter;

beforeEach(async () => {
  process.env.APP_MODE = "local";
  delete process.env.JABBERWOCK_SUPERVISOR_EXTENSION_IDS;
  app = Fastify({ logger: false });
  await app.register(cors, { origin: true, credentials: true });
  memory = new JabberwockMemoryService(":memory:");
  memory.set_setting("jabberwock.defaultModel", "mock-model");
  router = { route: vi.fn(async (request) => ({
    mode: request.routingMode,
    model: "mock-model",
    provider: "local_openai",
    providerModelId: "mock-physical-model",
    reason: "mock selection"
  })) };
  runtime = { execute: vi.fn(async () => ({ response: "One atomic result.", summary: "Atomic result recorded." })) };
  registerJabberwockSupervisorRoutes(app, memory, new SupervisorBridge(memory, { router, runtime }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  memory.close();
  if (previousMode === undefined) delete process.env.APP_MODE;
  else process.env.APP_MODE = previousMode;
  if (previousExtensionIds === undefined) delete process.env.JABBERWOCK_SUPERVISOR_EXTENSION_IDS;
  else process.env.JABBERWOCK_SUPERVISOR_EXTENSION_IDS = previousExtensionIds;
  if (previousSupervisorTimeout === undefined) delete process.env.JABBERWOCK_SUPERVISOR_TIMEOUT_MS;
  else process.env.JABBERWOCK_SUPERVISOR_TIMEOUT_MS = previousSupervisorTimeout;
});

describe("Jabberwock Supervisor HTTP API", () => {
  it("starts a streamed step response before a long-running runtime finishes", async () => {
    const project = memory.create_project({ name: "Streaming", root_path: "Y:\\Project" });
    const task = memory.create_task({ project_id: project.id, title: "Task", original_request: "Inspect." });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    vi.mocked(runtime.execute).mockImplementationOnce(async () => {
      await gate;
      return { response: "Completed after tools." };
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}${prefix}/tasks/${task.id}/steps?stream=1`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "Inspect once.", runtimeMode: "agent", permissions: "read_only" })
    });
    expect(response.status).toBe(200);
    expect(memory.list_task_steps(task.id)).toHaveLength(1);
    finish();
    expect(await response.json()).toMatchObject({ ok: true, data: { status: "completed", response: "Completed after tools." } });
  });

  it("aborts downstream runtime and clears active step state when the streaming client disconnects", async () => {
    const project = memory.create_project({ name: "Cancellation", root_path: "Y:\\Project" });
    const task = memory.create_task({ project_id: project.id, title: "Task", original_request: "Cancel safely." });
    let runtimeSignal: AbortSignal | undefined;
    vi.mocked(runtime.execute).mockImplementationOnce(async (input) => {
      runtimeSignal = input.signal;
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
      });
      return { response: "unreachable" };
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    let clientResponse: IncomingMessage | undefined;
    let firstChunk!: () => void;
    const chunkReceived = new Promise<void>((resolve) => { firstChunk = resolve; });
    const body = JSON.stringify({ instruction: "Run until disconnected.", routingMode: "auto", runtimeMode: "agent" });
    const clientRequest = httpRequest(`${address}${prefix}/tasks/${task.id}/steps?stream=1`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
    }, (response) => {
      clientResponse = response;
      expect(response.statusCode).toBe(200);
      response.once("data", firstChunk);
    });
    clientRequest.on("error", () => undefined);
    clientRequest.end(body);
    await chunkReceived;
    await vi.waitFor(() => expect(runtimeSignal).toBeDefined());
    clientResponse?.destroy();

    await vi.waitFor(() => {
      expect(runtimeSignal?.aborted).toBe(true);
      expect(memory.list_task_steps(task.id)).toEqual([
        expect.objectContaining({ status: "failed", result_summary: expect.stringMatching(/disconnect|abort/i) })
      ]);
      expect(new SupervisorBridge(memory, { router, runtime }).supervisorGetState(task.id).activeSteps).toEqual([]);
    });
  });

  it("turns a Supervisor timeout into downstream cancellation and a failed step", async () => {
    process.env.JABBERWOCK_SUPERVISOR_TIMEOUT_MS = "25";
    const project = memory.create_project({ name: "Timeout", root_path: "Y:\\Project" });
    const task = memory.create_task({ project_id: project.id, title: "Task", original_request: "Time out safely." });
    let runtimeSignal: AbortSignal | undefined;
    vi.mocked(runtime.execute).mockImplementationOnce(async (input) => {
      runtimeSignal = input.signal;
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
      });
      return { response: "unreachable" };
    });

    const response = await inject("POST", `/tasks/${task.id}/steps`, {
      instruction: "Run longer than the Supervisor timeout.",
      routingMode: "auto",
      runtimeMode: "agent"
    });

    expect(response.statusCode).toBe(502);
    expect(runtimeSignal?.aborted).toBe(true);
    expect(response.json()).toMatchObject({ ok: false, data: { status: "failed", failureStage: "runtime" } });
    expect(memory.list_task_steps(task.id)).toEqual([
      expect.objectContaining({ status: "failed", result_summary: expect.stringMatching(/timed out/i) })
    ]);
    expect(new SupervisorBridge(memory, { router, runtime }).supervisorGetState(task.id).activeSteps).toEqual([]);
  });

  it("runs the local capabilities → project → task → state → step → assessment → state smoke flow", async () => {
    const capabilities = await inject("GET", "/capabilities");
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({ ok: true, data: { available: true, version: 1, features: { workingMemory: true, autoRouting: true, fixedRouting: true, assessment: true } } });

    const createdProject = await inject("POST", "/projects", { name: "SnarkRoute", description: "Local project", rootPath: "Y:\\Процесс\\SnarkRoute" });
    expect(createdProject.statusCode).toBe(201);
    const projectId = createdProject.json().data.id as string;
    const listed = await inject("GET", "/projects");
    expect(listed.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ id: projectId })]));
    const found = await inject("GET", "/projects/find?name=snarkroute");
    expect(found.json().data.id).toBe(projectId);

    const createdTask = await inject("POST", "/tasks", { projectId, title: "Inspect providers", originalRequest: "Find the provider registration code." });
    expect(createdTask.statusCode).toBe(201);
    const taskId = createdTask.json().data.id as string;
    const initialState = await inject("GET", `/tasks/${taskId}`);
    expect(initialState.json()).toMatchObject({ ok: true, data: { taskId, project: { id: projectId }, goal: { originalRequest: "Find the provider registration code." }, activeSteps: [] } });

    const executed = await inject("POST", `/tasks/${taskId}/steps`, {
      instruction: "Find the provider registration file. Do not edit.",
      routingMode: "auto",
      model: null,
      constraints: ["Do not edit files"],
      expectedOutput: ["Relevant files", "Short explanation"]
    });
    expect(executed.statusCode).toBe(200);
    const stepId = executed.json().data.stepId as string;
    expect(executed.json()).toMatchObject({ ok: true, data: { taskId, stepId, sequence: 1, status: "completed", response: "One atomic result." } });
    expect(memory.list_task_steps(taskId)).toHaveLength(1);
    expect(memory.list_runs_for_step(stepId)).toHaveLength(1);
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(memory.list_runs_for_step(stepId)[0]?.prompt).toContain("EXPECTED OUTPUT\n- Relevant files\n- Short explanation");

    const assessed = await inject("POST", `/tasks/${taskId}/steps/${stepId}/assessment`, {
      assessment: "The provider layer was found.",
      accepted: true,
      facts: ["local_openai already exists"],
      decisions: ["Reuse the existing provider layer"]
    });
    expect(assessed.statusCode).toBe(200);
    expect(assessed.json()).toMatchObject({ ok: true, data: { step: { id: stepId, accepted: true, assessment: "The provider layer was found." } } });

    const finalState = await inject("GET", `/tasks/${taskId}`);
    expect(finalState.json().data).toMatchObject({
      completedSteps: [{ id: stepId, accepted: true }],
      facts: [{ text: "local_openai already exists" }],
      decisions: [{ text: "Reuse the existing provider layer" }]
    });
    expect(JSON.stringify(finalState.json())).not.toContain("One atomic result.");
  });

  it("returns compact not-found, validation, routing and runtime errors", async () => {
    const missing = await inject("GET", "/tasks/missing");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ ok: false, error: { code: "TASK_NOT_FOUND", message: expect.any(String) } });
    expect(JSON.stringify(missing.json())).not.toContain("stack");

    const missingProject = await inject("POST", "/tasks", { projectId: "missing", title: "Title", originalRequest: "Goal" });
    expect(missingProject.statusCode).toBe(404);
    expect(missingProject.json().error.code).toBe("PROJECT_NOT_FOUND");

    const project = memory.create_project({ name: "Project", root_path: "Y:\\Project" });
    const task = memory.create_task({ project_id: project.id, title: "Task", original_request: "Goal" });
    const invalid = await inject("POST", `/tasks/${task.id}/steps`, { instruction: "Run", routingMode: "fixed" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("INVALID_REQUEST");
    expect(memory.list_task_steps(task.id)).toHaveLength(0);
    const malformed = await app.inject({
      method: "POST", url: `${prefix}/tasks`,
      headers: { host: "127.0.0.1:4317", "content-type": "application/json" },
      payload: "{"
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ ok: false, error: { code: "INVALID_REQUEST", message: "Invalid request body." } });

    const missingStep = await inject("POST", `/tasks/${task.id}/steps/missing/assessment`, { assessment: "No", accepted: false });
    expect(missingStep.statusCode).toBe(404);
    expect(missingStep.json().error.code).toBe("STEP_NOT_FOUND");

    vi.mocked(router.route).mockRejectedValueOnce(new Error("No compatible route"));
    const routingFailure = await inject("POST", `/tasks/${task.id}/steps`, { instruction: "Route once" });
    expect(routingFailure.statusCode).toBe(502);
    expect(routingFailure.json()).toMatchObject({ ok: false, error: { code: "ROUTING_FAILURE" }, data: { status: "failed", failureStage: "routing" } });

    vi.mocked(runtime.execute).mockRejectedValueOnce(new Error("Provider unavailable"));
    const runtimeFailure = await inject("POST", `/tasks/${task.id}/steps`, { instruction: "Execute once" });
    expect(runtimeFailure.statusCode).toBe(502);
    expect(runtimeFailure.json()).toMatchObject({ ok: false, error: { code: "RUNTIME_FAILURE" }, data: { status: "failed", failureStage: "runtime" } });
    expect(memory.list_task_steps(task.id)).toHaveLength(2);
    expect(memory.list_runs_for_step(runtimeFailure.json().data.stepId)).toHaveLength(1);
  });

  it("restricts the namespace to loopback clients and configured Chrome extension origins", async () => {
    const forbiddenWeb = await inject("GET", "/capabilities", undefined, { origin: "https://example.com" });
    expect(forbiddenWeb.statusCode).toBe(403);
    const extensionId = "ohkkimdnpgonlmcdbicjlgkkddpaonio";
    const extensionOrigin = `chrome-extension://${extensionId}`;
    const unconfigured = await inject("GET", "/capabilities", undefined, { origin: extensionOrigin });
    expect(unconfigured.statusCode).toBe(403);
    process.env.JABBERWOCK_SUPERVISOR_EXTENSION_IDS = extensionId;
    const configured = await inject("GET", "/capabilities", undefined, { origin: extensionOrigin });
    expect(configured.statusCode).toBe(200);
    expect(configured.headers["access-control-allow-origin"]).toBe(extensionOrigin);
    const preflight = await app.inject({
      method: "OPTIONS", url: `${prefix}/tasks`,
      headers: {
        host: "127.0.0.1:4317", origin: extensionOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type"
      }
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(extensionOrigin);

    const remote = await app.inject({ method: "GET", url: `${prefix}/capabilities`, headers: { host: "127.0.0.1:4317" }, remoteAddress: "203.0.113.9" });
    expect(remote.statusCode).toBe(403);
    const rebindingHost = await app.inject({ method: "GET", url: `${prefix}/capabilities`, headers: { host: "example.com" }, remoteAddress: "127.0.0.1" });
    expect(rebindingHost.statusCode).toBe(403);
    process.env.APP_MODE = "cloud";
    const cloud = await inject("GET", "/capabilities");
    expect(cloud.statusCode).toBe(404);
  });
});

function inject(method: "GET" | "POST", suffix: string, payload?: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  const options: InjectOptions = {
    method,
    url: `${prefix}${suffix}`,
    headers: { host: "127.0.0.1:4317", ...extraHeaders },
    remoteAddress: "127.0.0.1",
    ...(payload === undefined ? {} : { payload })
  };
  return app.inject(options);
}
