/**
 * Live check of agent operations with the real Codex CLI and Claude Code CLI on
 * a throwaway project. Each executor gets one tiny bounded task; limits are
 * simulated, never exhausted for real.
 *
 *   pnpm --filter @snarkroute/server exec tsx scripts/agent-ops-smoke.ts [codex|claude|both]
 */
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentOps } from "../src/agent-ops";
import { loadRootEnv } from "../src/services/env-loader";

loadRootEnv();
const which = process.argv[2] ?? "both";
const root = join(process.cwd(), "data", "agent-ops-smoke");
await rm(root, { recursive: true, force: true });
const sandbox = join(root, "sandbox");

async function project(name: string): Promise<string> {
  const dir = join(sandbox, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, type: "module", private: true }, null, 2));
  await writeFile(join(dir, "math.js"), "export function add(a, b) {\n  // TODO\n  return 0;\n}\n");
  await writeFile(join(dir, "math.test.js"), [
    'import test from "node:test";', 'import assert from "node:assert/strict";', 'import { add } from "./math.js";', "",
    'test("add", () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0); });', ""
  ].join("\n"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@local", "add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@local", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const ops = await createAgentOps({ directory: join(root, "data"), workspaceRoots: [sandbox], tickMs: 1000 });
const agent = ops.registry.mcpClient(`fresh-smoke-agent-${Date.now()}`);
console.log(`agent ${agent.id} policy=${agent.policy.id}`);
await ops.tasks.refreshExecutorProbes(true);
const executors = await ops.catalog.list(agent, { kind: "executor" });
for (const entry of executors) console.log(`catalog ${entry.id}: discovered=${entry.status.discovered} available=${entry.status.available} verified=${entry.status.verified?.at ?? "never"} · ${entry.status.detail ?? ""}`);

async function waitFor(id: string, timeoutMs = 12 * 60_000) {
  const started = Date.now();
  let last = "";
  for (;;) {
    const task = ops.tasks.get(id)!;
    const line = `${task.state}: ${task.reason}`;
    if (line !== last) { console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${line}`); last = line; }
    if (["verified", "failed", "cancelled", "blocked", "unknown_outcome"].includes(task.state) || task.state === "awaiting_verification" && !task.spec.checks?.length) return task;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout in ${task.state}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

function independentCheck(dir: string): boolean {
  try { execFileSync(process.execPath, ["--test"], { cwd: dir, stdio: "pipe" }); return true; } catch { return false; }
}

const summary: Record<string, unknown> = {};
const spec = (dir: string, executor?: string) => ({
  title: "Fix add()", goal: "In math.js implement add(a, b) so that it returns the sum. Do not modify math.test.js.",
  acceptance: ["node --test passes", "math.test.js unchanged"], workspace: dir, executor,
  checks: [{ type: "command" as const, command: "node", args: ["--test"] }, { type: "file_contains" as const, path: "math.test.js", text: "assert.equal(add(2, 3), 5)" }],
  budget: { wallMinutes: 10, maxTurns: 15 }, idempotencyKey: `smoke-${executor ?? "auto"}-${Date.now()}`
});

if (which === "codex" || which === "both") {
  const dir = await project("codex-project");
  const { task } = await ops.tasks.submit(agent, spec(dir));
  console.log(`codex task ${task.id} (executor auto)`);
  const done = await waitFor(task.id);
  summary.codex = { state: done.state, executor: done.executor, attempts: done.attempts.map(attempt => `${attempt.executor}:${attempt.outcome}`), changed: done.result?.changedFiles, independentTest: independentCheck(dir) };
}

if (which === "claude" || which === "both") {
  const dir = await project("claude-project");
  // Codex "hits its limit" (simulated): the router must pick Claude Code instead, no paid API.
  ops.ledger.recordFailure("codex_cli", { class: "quota_exhausted", message: "Simulated usage limit (smoke)", resetsAt: new Date(Date.now() + 20 * 60_000).toISOString(), source: "simulation", simulated: true });
  const { task } = await ops.tasks.submit(agent, spec(dir));
  console.log(`claude task ${task.id} (executor auto, Codex limit simulated)`);
  const done = await waitFor(task.id);
  ops.ledger.clearSimulation("codex_cli");
  summary.claude = { state: done.state, executor: done.executor, attempts: done.attempts.map(attempt => `${attempt.executor}:${attempt.outcome}`), changed: done.result?.changedFiles, independentTest: independentCheck(dir) };
}

await ops.tasks.drain();
ops.close();
console.log(JSON.stringify(summary, null, 2));
const ok = Object.values(summary).every(item => (item as { state: string; independentTest: boolean }).state === "verified" && (item as { independentTest: boolean }).independentTest);
process.exit(ok ? 0 : 1);
