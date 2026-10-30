/** Independent check of Buzha's public FL.ru profile with the exact HTTP checks of her contract (anonymous public view).
 *   node --import tsx scripts/buzha-fl-profile-check.ts        (from apps/server)
 */
import { runCheck } from "../src/agent-ops/workspace";
import { checks, criteria } from "./buzha-fl-profile-contract";

const results = await Promise.all(checks.map(check => check.type === "http" ? runCheck(check, undefined) : undefined));
for (const criterion of criteria) {
  const own = (criterion.checkIndexes ?? []).map(index => ({ index, check: checks[index], result: results[index] })).filter(item => item.result);
  if (!own.length) continue;
  console.log(`${own.every(item => item.result!.ok) ? "PASS" : "FAIL"} ${criterion.id}: ${criterion.description}`);
  for (const item of own) { const c = item.check as any; console.log(`   [${item.index}] ${item.result!.ok ? "ok  " : "miss"} ${(c.text ? `contains ${c.text}` : c.absentText ? `absent ${c.absentText}` : `/${c.pattern}/ ${JSON.stringify(c.matches)}`).slice(0, 140)}`); }
}
