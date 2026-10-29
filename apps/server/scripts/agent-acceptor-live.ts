/** Live server/real Codex CLI acceptance cycle. Only a new disposable folder is edited.
 * node --import tsx scripts/agent-acceptor-live.ts
 * Model qualification can subsequently re-review this same result through /amend.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const base = "http://127.0.0.1:4317/api/agent-ops";
async function api(path: string, body?: unknown) {
  const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const data: any = await r.json(); if (!r.ok) throw new Error(JSON.stringify(data)); return data;
}
const parent = resolve("data", "agent-ops", "sandbox", "acceptor-live"); await mkdir(parent, { recursive: true });
const workspace = await mkdtemp(join(parent, "run-"));
const response = await api("/tasks", {
  title: "Приёмщик: реальный Codex, контролируемая неполная первая попытка",
  goal: "Controlled acceptance test in this disposable folder. Final required result: extension.json contains {\"built\":true,\"testsPassed\":true}; profile.json contains {\"published\":true,\"name\":\"Бужа\",\"bio\":\"Помогаю с разовыми заказами\"}. This is a simulation; do not contact FL.ru or any real external service. On the FIRST attempt, intentionally create ONLY extension.json and reply 'готово', leaving the profile missing so the Acceptor detects the incomplete result. On a continuation with Acceptor feedback, preserve extension.json and create the complete profile.json to satisfy the original final goal. Do not change tests or other files, do not delegate.",
  expectedResult: "Complete simulated profile published, named Бужа with bio Помогаю с разовыми заказами; extension built and tested", workspace,
  permissions: { fileWrite: true, shell: "tests", network: false }, requirements: { kind: "code_edit", quality: "high" }, executor: "codex_cli", allowedExecutors: ["codex_cli", "local_route"],
  checks: [{ type: "file_contains", path: "extension.json", text: '"built"' }, { type: "command", command: process.execPath, args: ["-e", "const fs=require('node:fs');const a=JSON.parse(fs.readFileSync('profile.json','utf8'));if(a.published!==true||a.name!=='Бужа'||a.bio!=='Помогаю с разовыми заказами')process.exit(1);console.log(JSON.stringify(a));"] }],
  criteria: [{ id: "extension", description: "Extension built", review: "machine", checkIndexes: [0] }, { id: "publication", description: "Simulated profile published with exact name and bio", review: "machine", checkIndexes: [1] }],
  retry: { maxAttempts: 2, sameFailureLimit: 2, delayMs: 1000, maxDelayMs: 2000 }, budget: { wallMinutes: 5, subscriptionRuns: 2, maxTurns: 10 }, idempotencyKey: `acceptor-live-${workspace}`
});
const id = response.task.id; await writeFile(join(workspace, "task-id.txt"), id); console.log(`task=${id}\nworkspace=${workspace}`);
let last = ""; const start = Date.now();
for (;;) {
  const state = await api(`/tasks/${id}`), task = state.task;
  const line = `${task.state} (${task.attempts.length} attempts): ${task.reason}`;
  if (line !== last) { console.log(line); last = line; }
  if (["verified", "blocked", "failed", "cancelled", "unknown_outcome"].includes(task.state)) {
    await writeFile(join(workspace, "live-evidence.json"), JSON.stringify(state, null, 2));
    assert.equal(task.state, "verified"); assert.equal(task.attempts.length, 2); assert.deepEqual(task.reviews.map((r: any) => r.decision), ["continue", "accept"]);
    console.log(JSON.stringify({ taskId: id, actualExecutors: task.attempts.map((a: any) => ({ executor: a.executor, model: a.model, sessionId: a.sessionId })), decisions: task.reviews.map((r: any) => ({ decision: r.decision, attempt: r.attempt })), artifact: join(workspace, "live-evidence.json") }, null, 2)); break;
  }
  if (Date.now() - start > 5 * 60000) throw new Error(`Live task remains ${task.state}; inspect ${id}, do not resubmit.`);
  await new Promise(resolve => setTimeout(resolve, 1500));
}
