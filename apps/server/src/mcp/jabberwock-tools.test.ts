import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createAeMcpServer } from "./server";
import { JabberwockMemoryService } from "../jabberwock-memory/service";
import { RouteRunner } from "../jabberwock-memory/route-runner";
import { SupervisorBridge } from "../jabberwock-memory/supervisor-bridge";

describe("Jabberwock MCP tools", () => {
  it("creates, starts and reads one route through the native MCP protocol", async () => {
    const memory = new JabberwockMemoryService(":memory:"); memory.set_setting("jabberwock.defaultModel", "bonsai");
    const bridge = new SupervisorBridge(memory, { router: { route: async request => ({ mode: request.routingMode, model: request.model! }) },
      runtime: { execute: async input => input.phase === "verification" ? {
        response: JSON.stringify({ verdict: "accepted", summary: "Verified actual state", evidence: ["Actual file read"] }), metadata: { toolsUsed: ["fs.read"] }
      } : { response: "Executed" } } });
    const runner = new RouteRunner(memory, bridge);
    const server = createAeMcpServer(undefined, { memory, bridge, runner });
    const client = new Client({ name: "native-route-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain("jabberwock_create_route");
      const call = async (name: string, args: object) => {
        const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
        return JSON.parse((result.content as Array<{ text: string }>)[0].text);
      };
      const project = (await call("jabberwock_create_project", { name: "MCP project", rootPath: process.cwd() })).data;
      const task = (await call("jabberwock_create_task", { projectId: project.id, title: "Route", originalRequest: "Inspect" })).data;
      const route = (await call("jabberwock_create_route", { taskId: task.id, steps: [{ title: "Step", instruction: "Inspect", acceptanceCriteria: ["Inspected"] }] })).data;
      await runner.wait(route.id);
      expect((await call("jabberwock_get_route_state", { routeId: route.id })).data).toMatchObject({ status: "completed", completedSteps: 1 });
      expect(memory.list_task_steps(task.id)).toHaveLength(1);
    } finally { await runner.close(); await client.close(); await server.close(); memory.close(); }
  });
});
