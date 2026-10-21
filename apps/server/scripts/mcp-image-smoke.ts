/**
 * Live smoke for the SnarkRoute MCP image tools (the same path Codex / Claude use).
 *   tsx apps/server/scripts/mcp-image-smoke.ts                -> list tools + flux3 runtime state
 *   tsx apps/server/scripts/mcp-image-smoke.ts "a red fox"    -> also run one real local generation
 * Reads SNARKROUTE_MCP_TOKEN from the environment or the repo .env. Never prints the token.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const repo = join(import.meta.dirname, "..", "..", "..");
const token = process.env.SNARKROUTE_MCP_TOKEN?.trim()
  || /^SNARKROUTE_MCP_TOKEN=(.+)$/m.exec(readFileSync(join(repo, ".env"), "utf8"))?.[1]?.trim().replace(/^"|"$/g, "");
if (!token) throw new Error("SNARKROUTE_MCP_TOKEN is not configured");

const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4317/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: "mcp-image-smoke", version: "1" });
await client.connect(transport);
const names = (await client.listTools()).tools.map(tool => tool.name);
console.log("TOOLS", names.filter(name => name.startsWith("image_") || name.startsWith("local_runtime")).join(","));
const status = await client.callTool({ name: "local_runtime_status", arguments: {} }) as { content: Array<{ text?: string }> };
const snapshot = JSON.parse(status.content[0].text ?? "{}").snapshot;
const flux3 = snapshot?.runtimes?.find((runtime: { id: string }) => runtime.id === "flux3");
console.log("FLUX3_RUNTIME", JSON.stringify(flux3 ?? null));
const admission = await client.callTool({ name: "local_runtime_admission", arguments: { runtimeId: "flux3", intent: "workload" } }) as { content: Array<{ text?: string }> };
console.log("FLUX3_ADMISSION", admission.content[0].text);
const prompt = process.argv[2];
if (prompt) {
  const started = Date.now();
  let result = await client.callTool({ name: "image_generate", arguments: { prompt, seed: 42, waitSeconds: 280 } }, undefined, { timeout: 300_000 }) as { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
  let body = JSON.parse(result.content[0].text ?? "{}");
  while (!result.isError && body.job && !["completed", "failed", "cancelled"].includes(body.job.status)) {
    console.log("WAITING", body.job.status, Math.round((Date.now() - started) / 1000) + "s");
    result = await client.callTool({ name: "image_job", arguments: { jobId: body.job.id, waitSeconds: 280 } }, undefined, { timeout: 300_000 }) as typeof result;
    body = JSON.parse(result.content[0].text ?? "{}");
  }
  console.log("GENERATE", JSON.stringify({ isError: result.isError ?? false, status: body.job?.status, resultPath: body.job?.resultPath, error: body.job?.error ?? body.error, seconds: Math.round((Date.now() - started) / 1000), previewBytes: result.content.find(item => item.type === "image")?.data?.length ?? 0 }));
}
await transport.terminateSession().catch(() => undefined);
await client.close();
