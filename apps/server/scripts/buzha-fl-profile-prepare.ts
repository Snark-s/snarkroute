/** Prepare Buzha's FL.ru profile request with immutable, independently checked acceptance criteria for the owner.
 * The public profile page is read by SnarkRoute itself (HTTP, anonymous public view); the executor's report is not evidence.
 * Writes the request to Buzha's data/prepared-requests; the owner submits it in the Workshop (Бужа → «Подготовленные
 * поручения») with the owner session. Idempotent by requestKey: submitting again returns the same task. No credentials here.
 *
 *   node --import tsx scripts/buzha-fl-profile-prepare.ts [--dry-run]        (from apps/server)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buzhaPreparedDir } from "../src/buzha/prepared";
import { checks, content, criteria } from "./buzha-fl-profile-contract";

const body = { content, requestKey: "fl-profile-2026-10-30-owner", quality: "high", contract: {
  expectedResult: "Публичный профиль FL.ru Бужи оформлен: имя, описание, специализация, аватар, обложки ПК и мобильная, три работы без дублей; ограничения подтверждены сообщениями сайта.",
  checks, criteria, budget: { wallMinutes: 600, activeMinutes: 180, subscriptionRuns: 24, maxTurns: 40, providerCost: 0 }, review: { forceStrong: false, maxRuns: 4 } } };
if (process.argv.includes("--dry-run")) { console.log(JSON.stringify({ ...body, content: `${content.length} chars` }, null, 1)); process.exit(0); }
const summary = [...criteria.map(criterion => `Критерий: ${criterion.description}`), "Бюджет: 24 подписочных шага, до 40 ходов модели за попытку, 180 активных минут; без платных API", "Приёмщик сам читает публичную страницу https://www.fl.ru/users/buzhastudio/portfolio/ по HTTP"];
const dir = buzhaPreparedDir(); mkdirSync(dir, { recursive: true });
const file = join(dir, "fl-profile-2026-10-30.json");
writeFileSync(file, JSON.stringify({ title: "Оформить профиль FL.ru: описание, специализация, аватар, обложки, три работы", preparedBy: "Claude Code (mcp:claude-code)", preparedAt: new Date().toISOString(), summary, body }, null, 2));
console.log(`prepared ${file}`);
