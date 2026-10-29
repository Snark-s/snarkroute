/**
 * Live check on the running SnarkRoute (127.0.0.1:4317) through MCP, the way a
 * brand-new agent sees it: no special prompt, only the server instructions.
 *
 *   tsx apps/server/scripts/agent-ops-mcp-smoke.ts            -> discovery, leases, modes, dedup (no model calls)
 *   tsx apps/server/scripts/agent-ops-mcp-smoke.ts delegate   -> also one tiny real task through the router
 *   tsx apps/server/scripts/agent-ops-mcp-smoke.ts restart    -> queue survives a launcher restart, no duplicate run
 *
 * Reads SNARKROUTE_MCP_TOKEN from the environment or the repo .env. Never prints the token.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const api = "http://127.0.0.1:4317";
const repo = join(import.meta.dirname, "..", "..", "..");
const token = process.env.SNARKROUTE_MCP_TOKEN?.trim()
  || /^SNARKROUTE_MCP_TOKEN=(.+)$/m.exec(readFileSync(join(repo, ".env"), "utf8"))?.[1]?.trim().replace(/^"|"$/g, "");
if (!token) throw new Error("SNARKROUTE_MCP_TOKEN is not configured");
const mode = process.argv[2] ?? "basic";
const failures: string[] = [];
const expect = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures.push(label); };

async function connect(name: string) {
  const client = new Client({ name, version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }) as { content: Array<{ text?: string }>; isError?: boolean };
  return { error: result.isError === true, body: JSON.parse(result.content[0]?.text ?? "{}") as Record<string, any> };
}
async function http(path: string, init?: RequestInit) {
  const response = await fetch(`${api}/api/agent-ops${path}`, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

const agentName = `fresh-agent-${Date.now()}`;
const client = await connect(agentName);
const instructions = client.getInstructions() ?? "";
expect(instructions.includes("agent_capabilities") && instructions.includes("agent_delegate_submit"), "new MCP client receives the delegation brief in server instructions");
const tools = (await client.listTools()).tools.map(item => item.name);
expect(["agent_whoami", "agent_capabilities", "agent_delegate_submit", "agent_delegate_status", "agent_delegate_result", "agent_delegate_cancel", "agent_resource_acquire", "computer_mode_status"].every(name => tools.includes(name)), "agent tools are listed");
const whoami = await tool(client, "agent_whoami");
expect(whoami.body.identity?.id === `mcp:${agentName}`, `identity from clientInfo: ${whoami.body.identity?.id}`);
const capabilities = await tool(client, "agent_capabilities", { kind: "executor" });
for (const entry of capabilities.body.entries ?? []) console.log(`  ${entry.id}: discovered=${entry.discovered} available=${entry.available} verified=${entry.verified ?? "never"} source=${entry.source}`);
expect((capabilities.body.entries ?? []).some((entry: { id: string }) => entry.id === "executor:codex_cli"), "catalog lists the Codex executor");
const all = await tool(client, "agent_capabilities", {});
expect((all.body.entries ?? []).some((entry: { kind: string }) => entry.kind === "service") && (all.body.entries ?? []).some((entry: { kind: string }) => entry.kind === "model_group"), "catalog also lists services and model groups");

// Two heavy leases on the one GPU: the second must wait.
const before = await http("/status");
const previousManual = before.body.manual as { mode: string; until?: string | null } | null;
await http("/mode", { method: "PUT", body: JSON.stringify({ mode: "free", minutes: 5 }) });
const first = await tool(client, "agent_resource_acquire", { class: "heavy", purpose: "smoke lease A", vramMiB: 512, ttlMinutes: 2 });
const second = await tool(client, "agent_resource_acquire", { class: "heavy", purpose: "smoke lease B", vramMiB: 512, ttlMinutes: 2 });
expect(first.body.granted === true && second.body.granted === false, `second heavy lease refused: ${second.body.reason ?? JSON.stringify(first.body)}`);
if (first.body.leaseId) await tool(client, "agent_resource_release", { leaseId: first.body.leaseId });

// «Компьютер нужен мне»: no new heavy work for agents.
await http("/mode", { method: "PUT", body: JSON.stringify({ mode: "owner_busy", minutes: 5 }) });
const busy = await tool(client, "agent_resource_acquire", { class: "heavy", purpose: "smoke while owner busy", vramMiB: 512, ttlMinutes: 2 });
expect(busy.body.granted === false && busy.body.waitFor === "window", `owner_busy refuses heavy agent work: ${busy.body.reason}`);
const status = await tool(client, "computer_mode_status");
expect(status.body.mode?.mode === "owner_busy" && status.body.mode?.source === "manual", "computer_mode_status shows the manual owner_busy mode");
const modeChange = await tool(client, "agent_whoami");
expect(modeChange.body.identity?.policy?.canSetComputerMode === false, "agents cannot change the computer mode");
await http("/mode", { method: "PUT", body: JSON.stringify(previousManual ? { mode: previousManual.mode, until: previousManual.until ?? null } : { mode: null }) });

const sandbox = join(repo, "apps", "server", "data", "agent-ops", "sandbox", `smoke-${Date.now()}`);
mkdirSync(sandbox, { recursive: true });
writeFileSync(join(sandbox, "package.json"), JSON.stringify({ name: "smoke", type: "module", private: true }));
writeFileSync(join(sandbox, "greet.js"), "export function greet(name) {\n  return '';\n}\n");
writeFileSync(join(sandbox, "greet.test.js"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "./greet.js";\ntest("greet", () => assert.equal(greet("Ann"), "Hello, Ann!"));\n');
execFileSync("git", ["init", "-q"], { cwd: sandbox });
const idempotencyKey = `mcp-smoke-${Date.now()}`;
const spec = { title: "Implement greet()", goal: "In greet.js make greet(name) return `Hello, ${name}!`. Do not touch greet.test.js.", workspace: sandbox,
  checks: [{ type: "command", command: "node", args: ["--test"] }], budget: { wallMinutes: 10, maxTurns: 12 }, idempotencyKey };

if (mode === "delegate") {
  const submitted = await tool(client, "agent_delegate_submit", spec);
  console.log(`  submitted ${submitted.body.taskId}: ${submitted.body.state}`);
  const again = await tool(client, "agent_delegate_submit", spec);
  expect(again.body.deduplicated === true && again.body.taskId === submitted.body.taskId, "same idempotencyKey returns the same task (no second run)");
  const started = Date.now();
  let state = "";
  for (;;) {
    const current = await tool(client, "agent_delegate_status", { taskId: submitted.body.taskId });
    if (current.body.state !== state) { state = current.body.state; console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${state}: ${current.body.reason}`); }
    if (["verified", "failed", "blocked", "cancelled", "unknown_outcome"].includes(state) || Date.now() - started > 12 * 60_000) break;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  const result = await tool(client, "agent_delegate_result", { taskId: submitted.body.taskId });
  console.log(`  executor=${result.body.result?.executor} model=${result.body.result?.model} changed=${JSON.stringify(result.body.result?.changedFiles)}`);
  let independent = false;
  try { execFileSync(process.execPath, ["--test"], { cwd: sandbox, stdio: "pipe" }); independent = true; } catch { independent = false; }
  expect(result.body.verified === true && independent, "delegated task verified by SnarkRoute checks and by an independent node --test");
}

if (mode === "restart") {
  // A task parked by «Компьютер нужен мне» must survive a restart unchanged and not start twice.
  await http("/mode", { method: "PUT", body: JSON.stringify({ mode: "owner_busy", minutes: 10 }) });
  const parked = await tool(client, "agent_delegate_submit", { ...spec, executor: "local_route", allowedExecutors: ["local_route"], requirements: { kind: "text" }, checks: [], goal: "Summarize greet.js in one sentence." });
  await new Promise(resolve => setTimeout(resolve, 4000));
  const beforeRestart = await http(`/tasks/${parked.body.taskId}`);
  console.log(`  before restart: ${beforeRestart.body.task?.state} · ${beforeRestart.body.task?.reason}`);
  const restart = await fetch("http://127.0.0.1:5176/restart", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(response => response.json()) as { ok: boolean; operation?: { id: string } };
  expect(restart.ok === true, "launcher accepted the restart");
  const deadline = Date.now() + 180_000;
  for (;;) {
    const launcher = await fetch("http://127.0.0.1:5176/status").then(response => response.json()).catch(() => undefined) as { operation?: { state: string } } | undefined;
    if (launcher?.operation?.state === "healthy" || Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const afterRestart = await http(`/tasks/${parked.body.taskId}`);
  console.log(`  after restart: ${afterRestart.body.task?.state} · ${afterRestart.body.task?.reason}`);
  expect(afterRestart.body.task?.id === parked.body.taskId && afterRestart.body.task?.attempts?.length === 0, "queued task survived the restart with no execution attempt");
  await http(`/tasks/${parked.body.taskId}/cancel`, { method: "POST", body: "{}" });
  await http("/mode", { method: "PUT", body: JSON.stringify(previousManual ? { mode: previousManual.mode, until: previousManual.until ?? null } : { mode: null }) });
}

await client.close();
console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
