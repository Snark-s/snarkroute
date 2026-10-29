/** Safe persistence/control proof. Restarts only an idle managed SnarkRoute. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { localServicePort } from "../src/services/local-service-endpoints";
const base = `http://127.0.0.1:${localServicePort("snarkroute")}`;
async function request(path: string, body?: unknown) {
  const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000) });
  const data: any = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
}
const acceptedId = "t-20261029-516f5072";
const accepted = (await request(`/api/agents/buzha/tasks/${acceptedId}`)).task;
assert.equal(accepted.state, "verified");
const input = { content: "Изолированная проверка сохранения паузы и отмены. Никаких внешних действий. Исполнение не требуется; задача будет приостановлена и отменена контроллером испытания.", requestKey: "buzha-pause-restart-2026-10-30-v1", quality: "high", contract: { budget: { subscriptionRuns: 0, wallMinutes: 30, maxTurns: 1, providerCost: 0 } } };
const control = (await request("/api/agents/buzha/messages", input)).task;
await request(`/api/agents/buzha/tasks/${control.id}/pause`, {});
const paused = (await request(`/api/agents/buzha/tasks/${control.id}`)).task;
assert.equal(paused.state, "paused"); assert(!paused.attempts.some((a: any) => a.modelCalls?.length || a.toolCalls?.length));
assert.equal((await request("/api/agents/buzha/messages", input)).task.id, control.id);
const before = await request("/api/agents/buzha");
const state = await request("/api/agent-ops/status");
assert(!state.tasks.some((t: any) => ["running", "unknown_outcome", "awaiting_verification"].includes(t.state)), "Work in flight; do not restart");
assert(!state.executors.some((e: any) => e.ledger.activeRuns > 0), "Provider turn in flight; do not restart");
const ownership = await request("/api/system/restart"); assert(ownership.managed);
await request("/api/system/restart", {});
let after: any;
for (let i = 0; i < 50; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try { const status = await request("/api/system/restart"); if (status.serverPid !== ownership.serverPid && status.operation?.state === "healthy") { after = await request("/api/agents/buzha"); break; } } catch { /* managed restart temporarily drops HTTP */ }
}
assert(after, "Managed restart did not become healthy");
const restored = after.tasks.find((t: any) => t.id === acceptedId), restoredControl = after.tasks.find((t: any) => t.id === control.id);
assert.equal(restored.state, "verified"); assert.equal(restoredControl.state, "paused");
assert.deepEqual(restored.attempts, accepted.attempts); assert.deepEqual(restored.reviews, accepted.reviews); assert.deepEqual(restored.evidence, accepted.evidence);
assert.deepEqual(after.messages.map((m: any) => m.id), before.messages.map((m: any) => m.id));
assert.equal(after.schedules.owner, "chatgpt"); assert.equal(after.schedules.localEnabled, false);
await request(`/api/agents/buzha/tasks/${control.id}/resume`, {});
await request(`/api/agents/buzha/tasks/${control.id}/cancel`, {});
const cancelled = (await request(`/api/agents/buzha/tasks/${control.id}`)).task;
assert.equal(cancelled.state, "cancelled"); assert(!cancelled.attempts.some((a: any) => a.modelCalls?.length || a.toolCalls?.length));
const dir = resolve("data", "agent-ops", "sandbox", "buzha-restart-smoke"); await mkdir(dir, { recursive: true });
const artifact = join(dir, "evidence.json");
await writeFile(artifact, JSON.stringify({ acceptedTask: restored, controlTask: cancelled, messageIds: after.messages.map((m: any) => m.id), preservedMessageIds: true, preservedAttempts: true, preservedEvidence: true, pausedAcrossRestart: true, resumedAndCancelled: true, extraModelOrToolCalls: 0, schedules: after.schedules, artifact }, null, 2));
console.log(JSON.stringify({ acceptedId, state: restored.state, controlId: control.id, pausedAcrossRestart: true, resumedAndCancelled: true, extraModelOrToolCalls: 0, historyPreserved: true, artifact }, null, 2));
