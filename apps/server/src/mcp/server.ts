import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sameSecret } from "../routes/after-effects";
import { registerAeTools } from "./tools";

const instructions = "This server controls local Adobe After Effects. Before making changes, call ae_list_sessions. If exactly one AE session is connected, tools may select it automatically; otherwise pass sessionId. For non-standard operations use ae_run_arbitrary_jsx. JSX executes directly in the currently open After Effects project through the SnarkRoute CEP panel. Arbitrary JSX is intentionally unrestricted and can access the AE DOM and ExtendScript File/Folder APIs. Timeouts stop waiting for a reply but cannot reliably interrupt ExtendScript already running.";
const transports = new Map<string, StreamableHTTPServerTransport>();

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  if (!process.env.SNARKROUTE_MCP_TOKEN?.trim()) app.log.warn("SNARKROUTE_MCP_TOKEN is not configured; /mcp is disabled. Other SnarkRoute routes remain available.");
  app.post("/mcp", (request, reply) => handlePost(request, reply));
  app.get("/mcp", (request, reply) => handleExisting(request, reply));
  app.delete("/mcp", (request, reply) => handleExisting(request, reply));
  app.addHook("onClose", async () => { for (const transport of transports.values()) await transport.close(); transports.clear(); });
}

async function handlePost(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  if (!authorize(request, reply)) return;
  const sessionId = header(request, "mcp-session-id");
  let transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport && !sessionId && isInitializeRequest(request.body)) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (id) => { transports.set(id, transport!); } });
    transport.onclose = () => { if (transport?.sessionId) transports.delete(transport.sessionId); };
    await createAeMcpServer().connect(transport);
  }
  if (!transport) return reply.code(400).send(jsonError("Invalid or missing MCP session id."));
  reply.hijack();
  await transport.handleRequest(request.raw, reply.raw, request.body);
}

async function handleExisting(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  if (!authorize(request, reply)) return;
  const sessionId = header(request, "mcp-session-id");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) return reply.code(400).send(jsonError("Invalid or missing MCP session id."));
  reply.hijack();
  await transport.handleRequest(request.raw, reply.raw);
}

export function createAeMcpServer(): McpServer {
  const server = new McpServer({ name: "snarkroute-after-effects", version: "0.1.0" }, { capabilities: { logging: {} }, instructions });
  registerAeTools(server);
  return server;
}
function authorize(request: FastifyRequest, reply: FastifyReply): boolean {
  const token = process.env.SNARKROUTE_MCP_TOKEN?.trim();
  if (!token) { void reply.code(503).send({ error: "MCP is disabled: configure SNARKROUTE_MCP_TOKEN in the root .env." }); return false; }
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ") || !sameSecret(value.slice(7), token)) { void reply.header("WWW-Authenticate", "Bearer").code(401).send({ error: "Invalid or missing MCP Bearer token." }); return false; }
  return true;
}
function header(request: FastifyRequest, name: string): string | undefined { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
function jsonError(message: string) { return { jsonrpc: "2.0", error: { code: -32000, message }, id: null }; }
