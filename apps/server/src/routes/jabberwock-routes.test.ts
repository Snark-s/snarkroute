import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JabberwockMemoryService } from "../jabberwock-memory/service";
import { SupervisorBridge, type SupervisorAgentRuntime } from "../jabberwock-memory/supervisor-bridge";
import { registerJabberwockSupervisorRoutes } from "./jabberwock-supervisor";

const prefix = "/api/jabberwock/supervisor";
let app: FastifyInstance;
let memory: JabberwockMemoryService;
let taskId: string;
let runtime: SupervisorAgentRuntime;
const oldMode = process.env.APP_MODE;
beforeEach(async () => {
  process.env.APP_MODE = "local";
  memory = new JabberwockMemoryService(":memory:"); memory.set_setting("jabberwock.defaultModel", "bonsai");
  const project = memory.create_project({ name: "API", root_path: process.cwd() });
  taskId = memory.create_task({ project_id: project.id, title: "Task", original_request: "Goal" }).id;
  runtime = { execute: vi.fn(async input => input.phase === "verification" ? {
    response: JSON.stringify({ verdict: "accepted", summary: "Actual state checked", evidence: ["Actual file inspected"] }), metadata: { toolsUsed: ["fs.read"] }
  } : { response: "Done" }) };
  app = Fastify();
  registerJabberwockSupervisorRoutes(app, memory, new SupervisorBridge(memory, { runtime,
    router: { route: async input => ({ mode: input.routingMode, model: input.model ?? "bonsai" }) } }));
  await app.ready();
});
afterEach(async () => { await app.close(); memory.close(); if (oldMode === undefined) delete process.env.APP_MODE; else process.env.APP_MODE = oldMode; });
const steps = [{ title: "Inspect", instruction: "Inspect actual code", acceptanceCriteria: ["Code inspected"] },
  { title: "Build", instruction: "Build", acceptanceCriteria: ["Build checked"], dependencies: [0] }];
const request = (method: "POST" | "GET", path: string, payload?: object) => app.inject({ method, url: `${prefix}${path}`, payload, remoteAddress: "127.0.0.1", headers: { host: "localhost" } });

describe("Supervisor Route API", () => {
  it("closes a live SSE stream and aborts owned execution before waiting for HTTP shutdown", async () => {
    vi.mocked(runtime.execute).mockImplementation(async input => {
      await new Promise<void>((_, reject) => input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }));
      return { response: "never" };
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const route = (await request("POST", "/routes", { taskId, steps })).json().data;
    await vi.waitFor(() => expect(runtime.execute).toHaveBeenCalledTimes(1));
    const response = await fetch(`${address}${prefix}/routes/${route.id}/events`);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"status":"running"');
    try {
      await app.close();
      expect(memory.get_route(route.id)?.status).toBe("running");
      expect(memory.list_runs_for_step(route.steps[0].id)[0].status).toBe("failed");
      expect(memory.get_route(route.id)?.steps[1].attempts).toBe(0);
      expect((await reader.read()).done).toBe(true);
    } finally { await reader.cancel(); }
  }, 20_000);
  it("advertises operations, creates and autostarts one route, then returns compact completion", async () => {
    expect((await request("GET", "/capabilities")).json().data.features.routeRunner).toBe(true);
    const response = await request("POST", "/routes", { taskId, steps });
    expect(response.statusCode).toBe(201); const id = response.json().data.id;
    await vi.waitFor(async () => expect((await request("GET", `/routes/${id}`)).json().data.status).toBe("completed"));
    const state = (await request("GET", `/routes/${id}`)).json().data;
    expect(state).toMatchObject({ completedSteps: 2, totalSteps: 2, retries: 0 });
    expect(JSON.stringify(state)).not.toContain("routing"); expect(runtime.execute).toHaveBeenCalledTimes(4);
  });
  it("supports explicit start, validates dependencies/config, and returns safe errors", async () => {
    expect((await request("POST", "/routes", { taskId, steps: [{ ...steps[0], dependencies: [0] }] })).statusCode).toBe(400);
    expect((await request("POST", "/routes", { taskId, steps, executionConfig: { routingMode: "fixed" } })).statusCode).toBe(400);
    expect((await request("POST", "/routes", { taskId: "missing", steps })).statusCode).toBe(404);
    expect((await request("GET", "/routes/missing")).json().error.code).toBe("ROUTE_NOT_FOUND");
    const route = (await request("POST", "/routes", { taskId, steps, autoStart: false })).json().data;
    expect(route.status).toBe("pending"); expect(runtime.execute).not.toHaveBeenCalled();
    expect((await request("POST", `/routes/${route.id}/continue`, { resolution: "No" })).statusCode).toBe(409);
    expect((await request("POST", `/routes/${route.id}/start`)).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await request("GET", `/routes/${route.id}`)).json().data.status).toBe("completed"));
  });
  it("cancels independently of an HTTP request and denies concurrent legacy writes", async () => {
    vi.mocked(runtime.execute).mockImplementation(async input => {
      await new Promise<void>((_, reject) => input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }));
      return { response: "never" };
    });
    const route = (await request("POST", "/routes", { taskId, steps })).json().data;
    await vi.waitFor(() => expect(runtime.execute).toHaveBeenCalledTimes(1));
    expect((await request("POST", `/tasks/${taskId}/steps`, { instruction: "Concurrent legacy step" })).statusCode).toBe(409);
    expect((await request("POST", `/routes/${route.id}/cancel`)).json().data.status).toBe("cancelled");
    await vi.waitFor(() => expect(memory.list_runs_for_step(route.steps[0].id)[0].status).toBe("failed"));
    expect(runtime.execute).toHaveBeenCalledTimes(1);
  });
});
