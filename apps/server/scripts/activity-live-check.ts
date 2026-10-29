/**
 * Live check of computer-activity measurement on this machine: real open applications as they are,
 * then a short bounded CPU load (worker threads, ~40 s), never a render.
 *   tsx apps/server/scripts/activity-live-check.ts [loadSeconds]
 */
import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import { assessOwnerActivity, sampleActivity, type ActivitySample } from "../src/agent-ops/activity";
import { DEFAULT_OWNER_APPS } from "../src/agent-ops/computer-mode";

const options = { ownerApps: DEFAULT_OWNER_APPS, ownProcessNames: ["ollama", "llama-server", "sd-server", "codex", "claude"], heavyLeaseActive: false };
async function samples(count: number): Promise<ActivitySample[]> {
  const out: ActivitySample[] = [];
  for (let index = 0; index < count; index += 1) { out.push(await sampleActivity()); await new Promise(resolve => setTimeout(resolve, 3000)); }
  return out;
}
const idle = await samples(3);
const open = idle.at(-1)!.processes.filter(item => DEFAULT_OWNER_APPS.includes(item.name)).map(item => `${item.name}(gpu ${item.gpuPercent}%, cpu ${item.cpuPercent}%)`);
console.log("baseline:", JSON.stringify(assessOwnerActivity(idle, options)), "| owner apps seen:", open.join(", ") || "none", "| total CPU", idle.at(-1)!.totalCpuPercent);

const seconds = Number(process.argv[2] ?? 40);
const threads = Math.max(2, cpus().length - 1);
const workers = Array.from({ length: threads }, () => new Worker(`const end = Date.now() + ${seconds * 1000}; while (Date.now() < end) { Math.sqrt(Math.random()); }`, { eval: true }));
await new Promise(resolve => setTimeout(resolve, 8000));
const loaded = await samples(3);
console.log("under load:", JSON.stringify(assessOwnerActivity(loaded, options)), "| total CPU", loaded.map(sample => sample.totalCpuPercent).join(","));
await Promise.all(workers.map(worker => worker.terminate()));
