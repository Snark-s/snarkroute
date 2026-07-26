import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createAeMcpServer, registerMcpRoutes } from "./server";

afterEach(() => { delete process.env.SNARKROUTE_MCP_TOKEN; });

describe("After Effects MCP", () => {
  it("lists tools and previews arbitrary JSX through the official SDK", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createAeMcpServer(); const client = new Client({ name: "test", version: "1" });
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ae_list_sessions", "ae_get_project", "ae_run_arbitrary_jsx", "ae_import_subtitles"]));
    const preview = await client.callTool({ name: "ae_run_arbitrary_jsx", arguments: { code: "Привет\nreturn 1;", mode: "preview" } });
    expect(JSON.stringify(preview)).toContain("Preview only"); expect(JSON.stringify(preview)).toContain("Привет");
    await client.close(); await server.close();
  });

  it("enforces bearer auth while a missing token leaves normal routes working", async () => {
    const app = Fastify(); app.get("/api/health", async () => ({ ok: true })); await registerMcpRoutes(app); await app.ready();
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/mcp", payload: {} })).statusCode).toBe(503);
    process.env.SNARKROUTE_MCP_TOKEN = "test-secret";
    expect((await app.inject({ method: "POST", url: "/mcp", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer test-secret" }, payload: {} })).statusCode).toBe(400);
    await app.close();
  });

  it("initializes over Streamable HTTP and lists tools", async () => {
    process.env.SNARKROUTE_MCP_TOKEN = "http-secret";
    const app = Fastify(); await registerMcpRoutes(app); await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address(); if (!address || typeof address === "string") throw new Error("No test port");
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { Authorization: "Bearer http-secret" } } });
    const client = new Client({ name: "http-test", version: "1" }); await client.connect(transport);
    expect((await client.listTools()).tools.some((tool) => tool.name === "ae_run_arbitrary_jsx")).toBe(true);
    await transport.terminateSession(); await client.close(); await app.close();
  });
});
