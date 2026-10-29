/** Evaluate the duty reviewer through the live server. Calls no worker directly.
 * node --import tsx scripts/agent-acceptor-qualify.ts
 * The saved task remains pending when the owner's resources are unavailable.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const base = "http://127.0.0.1:4317/api/agent-ops";
const parent = resolve("data", "agent-ops", "sandbox", "acceptor-qualification"); await mkdir(parent, { recursive: true });
const workspace = await mkdtemp(join(parent, "run-"));
await writeFile(join(workspace, "profile.json"), JSON.stringify({ published: true, name: "Бужа", bio: "Помогаю с разовыми заказами" }));
const response = await fetch(base + "/acceptor/inspect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
  title: "Приёмщик: пригодность локального кандидата на контрольных примерах",
  goal: "Independently evaluate the existing simulated Buzha profile. It must be published, have the name Бужа and a nonempty bio describing help with one-off tasks. This is a controlled local file, not a claim about real FL.ru.",
  expectedResult: "A complete simulated profile with publication=true, name Бужа, and meaningful bio about one-off tasks", workspace,
  permissions: { fileWrite: false, shell: "none", network: false }, requirements: { kind: "analysis", quality: "normal" },
  checks: [{ type: "file_content", path: "profile.json" }], criteria: [{ id: "content", description: "The profile is published and its name and bio fully satisfy the original request", review: "model", checkIndexes: [0] }],
  budget: { wallMinutes: 20, subscriptionRuns: 1 }, review: { maxRuns: 8, timeoutMs: 120000 }, retry: { maxAttempts: 2, delayMs: 1000, maxDelayMs: 10000 }, idempotencyKey: `qualify-${workspace}`
}) });
if (!response.ok) throw new Error(await response.text()); const data: any = await response.json(), id = data.task.id;
console.log(`task=${id}\nworkspace=${workspace}`);
let last = "";
for (let n = 0; n < 240; n++) {
  const state: any = await fetch(base + `/tasks/${id}`).then(r => r.json()), task = state.task;
  const line = `${task.state}: ${task.reason} · reviewerRuns=${task.reviewRuns?.length ?? 0}`;
  if (line !== last) { console.log(line); last = line; }
  if (["verified", "blocked", "failed", "cancelled"].includes(task.state) || task.state === "awaiting_verification" && task.reviews?.at(-1)?.decision === "wait_resource" && !task.reviewRuns?.length) {
    const calibration: any = await fetch(base + "/acceptor").then(r => r.json());
    await writeFile(join(workspace, "qualification-evidence.json"), JSON.stringify({ task: state, calibration: calibration.calibration }, null, 2));
    console.log(JSON.stringify({ taskId: id, state: task.state, reason: task.reason, calibration: calibration.calibration, artifact: join(workspace, "qualification-evidence.json") }, null, 2)); break;
  }
  await new Promise(resolve => setTimeout(resolve, 2500));
}
