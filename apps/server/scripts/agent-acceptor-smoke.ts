/** Controlled Buzha regression. No FL.ru, paid APIs or real publication.
 * Real task store, queue, resource locks, HTTP handlers, child process and
 * independently observed HTTP result; executor is an explicit deterministic fixture.
 * Run from apps/server: node --import tsx scripts/agent-acceptor-smoke.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { createAgentOps } from "../src/agent-ops";
import { QuotaLedger } from "../src/agent-ops/quota-ledger";
import type { ExecutorAdapter, ExecutorRunContext } from "../src/agent-ops/executors";
import { registerAgentOpsRoutes } from "../src/routes/agent-ops";

const rootBase = resolve("data", "agent-acceptor-demo"); await mkdir(rootBase, { recursive: true });
const root = await mkdtemp(join(rootBase, "run-")), workspace = join(root, "project"); await mkdir(workspace);
const profileFile = join(root, "published-profile.json");
await writeFile(profileFile, JSON.stringify({ published: false }));
let publicationCount = 0, executorRuns = 0, severConnection = false, app = Fastify();
const external = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.url !== "/profile") { response.writeHead(404).end("{}"); return; }
  if (request.method === "POST") {
    // This controlled external service also supports idempotency, like a proper integration should.
    const current = JSON.parse(await readFile(profileFile, "utf8"));
    if (!current.published) { publicationCount++; await writeFile(profileFile, JSON.stringify({ published: true, name: "Бужа", bio: "Профиль опубликован в контролируемой среде" })); }
  }
  response.end(await readFile(profileFile, "utf8"));
});
await new Promise<void>(resolveListen => external.listen(0, "127.0.0.1", resolveListen));
const address = external.address() as { port: number }, profileUrl = `http://127.0.0.1:${address.port}/profile`;

async function api(method: "GET" | "POST", url: string, payload?: unknown, token?: string) {
  const response = await app.inject({ method, url, payload, headers: token ? { "x-snarkroute-agent-token": token } : {} });
  assert(response.statusCode < 300, `${response.statusCode}: ${response.body}`); return response.json();
}
async function child(context: ExecutorRunContext, code: string): Promise<void> {
  await new Promise<void>((resolveChild, reject) => {
    const worker = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (worker.pid) context.onPid(worker.pid);
    let output = ""; worker.stdout.on("data", chunk => output += chunk); worker.stderr.on("data", chunk => output += chunk);
    worker.once("error", reject); worker.once("close", code => code === 0 ? resolveChild() : reject(new Error(output || `exit ${code}`)));
  });
}
const adapter: ExecutorAdapter = {
  id: "codex_cli", label: "Controlled demonstration executor (not a model)",
  profile: { kinds: ["code_edit"], editsFiles: true, shell: true, maxContextTokens: 200000, quality: "high", pause: "none", costTier: "subscription", order: 0 },
  probe: async () => ({ installed: true, authenticated: true, source: "controlled-fixture", detail: "Deterministic child process; no provider subscription is used", checkedAt: new Date().toISOString() }),
  resourceRequest: () => ({ class: "light", ramMiB: 256, cpuSlots: 1 }),
  run: async context => {
    executorRuns++;
    if (context.task.attempts.length === 1) {
      await child(context, 'import {writeFile} from "node:fs/promises"; await writeFile("extension.json", JSON.stringify({built:true,testsPassed:true}));');
      return { ok: true, message: "Extension built. Unit tests passed. Готово!", summary: "Profile published (claim deliberately false in this fixture)." };
    }
    assert(context.prompt.includes("publication"), "Acceptor must pass the missing result as a concrete continuation");
    const reservation = await api("POST", `/api/agent-ops/tasks/${context.task.id}/effects/publish`, { action: "begin" }, context.env.SNARKROUTE_AGENT_TOKEN);
    assert.equal(reservation.execute, true);
    const duplicate = await api("POST", `/api/agent-ops/tasks/${context.task.id}/effects/publish`, { action: "begin" }, context.env.SNARKROUTE_AGENT_TOKEN);
    assert.equal(duplicate.execute, false);
    await child(context, `const r=await fetch(${JSON.stringify(profileUrl)},{method:"POST"}); if(!r.ok) throw new Error("publication failed");`);
    // Simulate the server losing its executor session after the remote action, before receiving success.
    severConnection = true;
    return new Promise(() => {});
  }
};
async function open() {
  const ops = await createAgentOps({ directory: join(root, "store"), workspaceRoots: [workspace], adapters: [adapter], tickMs: 50, ledger: new QuotaLedger(),
    telemetry: async () => ({ memory: { totalMiB: 64000, usedMiB: 10000, freeMiB: 54000 }, cpuCount: 16, capturedAt: new Date().toISOString() }) });
  registerAgentOpsRoutes(app, { ops: Promise.resolve(ops) }); await app.ready(); return ops;
}
let ops = await open();
// Anonymous callers cannot submit or read tasks: Buzha submits with her own agent token (valid across the restart below).
const requester = ops.registry.issueAgentToken(ops.registry.app("buzha", "Бужа"), 3_600_000);
let id = "";
try {
  const response = await api("POST", "/api/agent-ops/tasks", {
    title: "Бужа: сборка расширения не равна публикации профиля", goal: "Publish the complete Buzha profile in the controlled service. A built extension and passing tests do not satisfy publication.",
    expectedResult: "A published profile with name Бужа and a nonempty bio", workspace, permissions: { fileWrite: true, shell: "tests", network: true },
    checks: [{ type: "file_contains", path: "extension.json", text: '"testsPassed":true' }, { type: "http", url: profileUrl, json: { path: "published", equals: true } }, { type: "http", url: profileUrl, json: { path: "name", equals: "Бужа" } }, { type: "http", url: profileUrl, json: { path: "bio", equals: "Профиль опубликован в контролируемой среде" } }],
    criteria: [{ id: "extension", description: "Extension built and tests passed", review: "machine", checkIndexes: [0] }, { id: "publication", description: "Profile actually published with complete name and bio", review: "machine", checkIndexes: [1, 2, 3] }],
    effects: [{ key: "publish", description: "Publish profile once", check: { type: "http", url: profileUrl, json: { path: "published", equals: true } } }],
    retry: { maxAttempts: 3, delayMs: 100, maxDelayMs: 500 }, budget: { wallMinutes: 5, subscriptionRuns: 3 }, idempotencyKey: "controlled-buzha-publication"
  }, requester);
  id = response.task.id;
  const start = Date.now();
  while (!severConnection) { if (Date.now() - start > 20000) throw new Error(JSON.stringify(await api("GET", `/api/agent-ops/tasks/${id}`, undefined, requester))); await new Promise(r => setTimeout(r, 50)); }
  await ops.tasks.drain(); ops.close(); await app.close();
  assert.equal(ops.tasks.get(id)?.reviews?.[0].decision, "continue");
  assert.equal(ops.tasks.get(id)?.state, "running");
  app = Fastify(); ops = await open();
  for (let n = 0; n < 100 && ops.tasks.get(id)?.state !== "verified"; n++) await new Promise(r => setTimeout(r, 50));
  const final = await api("GET", `/api/agent-ops/tasks/${id}`, undefined, requester), observed = await fetch(profileUrl).then(r => r.json());
  assert.equal(final.task.state, "verified"); assert.equal(executorRuns, 2); assert.equal(publicationCount, 1); assert.equal(final.task.effects[0].state, "confirmed");
  assert.deepEqual(final.task.reviews.map((r: any) => r.decision), ["continue", "accept"]);
  const report = { controlledExecutor: true, taskId: id, state: final.task.state, executorRuns, publicationCount, restartRecovered: true, observed, decisions: final.task.reviews, evidence: final.task.evidence, events: final.events };
  await writeFile(join(root, "evidence.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence: final.task.evidence.length, events: final.events.length, decisions: final.task.reviews.map((r: any) => ({ decision: r.decision, attempt: r.attempt })), artifact: join(root, "evidence.json") }, null, 2));
} finally { ops.close(); await app.close(); await new Promise<void>(resolveClose => external.close(() => resolveClose())); }
