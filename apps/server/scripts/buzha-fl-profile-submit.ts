/** Owner-run: give Buzha the FL.ru profile task with immutable, independently checked acceptance criteria.
 * The public profile page is read by SnarkRoute itself (HTTP, anonymous public view); the executor's report is not evidence.
 * Idempotent by requestKey: rerunning returns the same task. Prints the task id only, never a token.
 *
 *   node --import tsx scripts/buzha-fl-profile-submit.ts            (from apps/server; owner credentials from .env)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checks, content, criteria } from "./buzha-fl-profile-contract";

const repo = join(import.meta.dirname, "..", "..", "..");
const body = { content, requestKey: "fl-profile-2026-10-30-owner", quality: "high", contract: {
  expectedResult: "Публичный профиль FL.ru Бужи оформлен: имя, описание, специализация, аватар, обложки ПК и мобильная, три работы без дублей; ограничения подтверждены сообщениями сайта.",
  checks, criteria, budget: { wallMinutes: 600, activeMinutes: 180, subscriptionRuns: 24, maxTurns: 40, providerCost: 0 }, review: { forceStrong: false, maxRuns: 4 } } };
if (process.argv.includes("--dry-run")) { console.log(JSON.stringify({ ...body, content: `${content.length} chars` }, null, 1)); process.exit(0); }
const env = readFileSync(join(repo, ".env"), "utf8");
const token = process.env.SNARKROUTE_LAUNCHER_TOKEN?.trim() || /^SNARKROUTE_LAUNCHER_TOKEN=(.+)$/m.exec(env)?.[1]?.trim().replace(/^"|"$/g, "");
if (!token) throw new Error("SNARKROUTE_LAUNCHER_TOKEN is not configured");
const response = await fetch("http://127.0.0.1:4317/api/agents/buzha/messages", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const result = await response.json() as { task?: { id: string; state: string; reason: string }; deduplicated?: boolean; error?: string };
console.log(response.status, JSON.stringify({ taskId: result.task?.id, state: result.task?.state, reason: result.task?.reason, deduplicated: result.deduplicated, error: result.error }));
