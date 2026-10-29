/**
 * Live full cycle of the local text executor on the running SnarkRoute (4317), as a new MCP agent:
 * discovery → suitability → resource lease in the allowed mode → model load through the regular
 * local runtime path → execution → independent check of the answer → lease released and model unloaded.
 *
 *   tsx apps/server/scripts/agent-ops-local-model-smoke.ts
 *
 * Reads SNARKROUTE_MCP_TOKEN from the environment or the repo .env. Never prints the token.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const api = "http://127.0.0.1:4317";
const repo = process.env.SNARKROUTE_REPO ?? join(import.meta.dirname, "..", "..", "..");
const token = process.env.SNARKROUTE_MCP_TOKEN?.trim()
  || /^SNARKROUTE_MCP_TOKEN=(.+)$/m.exec(readFileSync(join(repo, ".env"), "utf8"))?.[1]?.trim().replace(/^"|"$/g, "");
if (!token) throw new Error("SNARKROUTE_MCP_TOKEN is not configured");
const failures: string[] = [];
const expect = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures.push(label); };

const client = new Client({ name: process.env.LOCAL_SMOKE_AGENT ?? `local-model-smoke-${Date.now()}`, version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 }) as { content: Array<{ text?: string }>; isError?: boolean };
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, any>;
};
const ollama = async (path: string) => (await fetch(`http://127.0.0.1:11434${path}`).then(response => response.json()).catch(() => ({}))) as { models?: Array<{ name: string; size_vram?: number }> };

// 1. Discovery and suitability.
const executors = (await tool("agent_capabilities", { kind: "executor" })).entries as Array<Record<string, any>>;
const local = executors.find(entry => entry.id === "executor:local_route");
console.log(`  local executor: discovered=${local?.discovered} available=${local?.available} · ${local?.detail}`);
expect(local?.available === true, "local text executor discovered and available in the catalog");
const goal = "Compute 17 multiplied by 23. Reply with the number only, digits, nothing else.";
// The task waits for the owner's allowed window like any background work; pass minutes to wait (default 10).
const waitMs = Number(process.argv[2] ?? 10) * 60_000;
const reattach = process.argv[3];
const answerReady = (status: Record<string, any>) => (status.attempts ?? []).some((attempt: Record<string, any>) => attempt.outcome === "succeeded");
const preview = await tool("agent_route_preview", { goal, requirements: { kind: "text", quality: "basic" } });
const first = (preview.candidates as Array<Record<string, any>>)[0];
console.log(`  router: first=${first?.executorId} suitable=${first?.suitable} (${(first?.reasons ?? []).join("; ")})`);
expect(first?.executorId === "local_route" && first?.suitable === true, "router picks the local model for a small text task");

// 2–4. Lease, load, execution: the task runs through the queue; we watch the lease and the runtime.
const before = await ollama("/api/ps");
const submitted = reattach ? { taskId: reattach, state: "reattached" }
  : await tool("agent_delegate_submit", { goal, title: "17×23 local check", requirements: { kind: "text", quality: "basic" }, executor: "local_route", allowedExecutors: ["local_route"], idempotencyKey: `local-smoke-${Date.now()}` });
console.log(`  submitted ${submitted.taskId}: ${submitted.state}`);
let leaseSeen = false;
let modelSeen = "";
let state = "";
const started = Date.now();
for (;;) {
  const status = await tool("agent_delegate_status", { taskId: submitted.taskId });
  if (status.state !== state) { state = status.state; console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${state}: ${status.reason}`); }
  const mode = await tool("computer_mode_status");
  for (const lease of (mode.leases ?? []) as Array<Record<string, any>>) if (lease.class === "heavy" && String(lease.purpose).includes(submitted.taskId)) leaseSeen = true;
  const ps = await ollama("/api/ps");
  if (ps.models?.length) modelSeen = ps.models.map(model => `${model.name} (${((model.size_vram ?? 0) / 2 ** 30).toFixed(1)} ГБ VRAM)`).join(", ");
  if (["verified", "failed", "cancelled", "blocked", "unknown_outcome"].includes(state) || state === "awaiting_acceptance" && answerReady(status) || Date.now() - started > waitMs) break;
  await new Promise(resolve => setTimeout(resolve, 1500));
}
console.log(`  runtime before: ${before.models?.map(model => model.name).join(", ") || "no model loaded"} · during: ${modelSeen || "not observed"}`);
expect(leaseSeen, "a heavy GPU lease was held for the task while it ran");
expect(Boolean(modelSeen), "the model was loaded by the regular local runtime path");

// 5. Independent check: the answer itself, not the executor's claim.
const result = await tool("agent_delegate_result", { taskId: submitted.taskId });
const answer = String(result.result?.summary ?? "").trim();
console.log(`  executor=${result.result?.executor} model=${result.result?.model} answer=${JSON.stringify(answer.slice(0, 80))} state=${result.state}`);
expect(/(^|\D)391(\D|$)/.test(answer), "independent check: the answer is 391");

// 6. Lease released; the model unloads by the runtime's own keep-alive, nobody else's model is touched.
const after = await tool("computer_mode_status");
expect(!((after.leases ?? []) as Array<Record<string, any>>).some(lease => String(lease.purpose).includes(submitted.taskId)), "the lease is released after the run");
await client.close();
console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
