/** Read-only DOM walk in Buzha's browser by describe-only prepare_action labels: finds a CSS path to an element by text.
 *   node --import tsx scripts/buzha-dom-walk.ts <tab_id> <root selector> <text> [maxDepth]      (from apps/server)
 */
import { BuzhaTools, BUZHA_TOOLS, buzhaObserverFile } from "../src/buzha/tools";
import type { AgentTask } from "../src/agent-ops/types";
const [tab, root, wanted, depthArg] = process.argv.slice(2);
const tools = new BuzhaTools({ observerFile: buzhaObserverFile() });
const task = { agentId: "app:buzha", spec: { actor: "buzha", tools: BUZHA_TOOLS } } as AgentTask;
const label = async (selector: string) => { try { const r = await tools.invoke(task, "browser_prepare_action", { action: "click", tab_id: tab, selector }); return String(r?.payload?.target?.label ?? "").replace(/\s+/g, " ").trim(); } catch { return undefined; } };
try {
  let path = root;
  for (let depth = 0; depth < Number(depthArg ?? 10); depth++) {
    let next: string | undefined;
    for (let n = 1; n <= 40; n++) {
      const candidate = `${path} > :nth-child(${n})`, text = await label(candidate);
      if (text === undefined) { if (n > 3) break; continue; }
      if (text === wanted) { console.log(`FOUND ${candidate}`); process.exit(0); }
      if (text.includes(wanted)) { next = candidate; console.log(`depth ${depth} child ${n}: ${text.slice(0, 80)}`); break; }
    }
    if (!next) { console.log(`not found below ${path}`); break; }
    path = next;
  }
} finally { await tools.close(); }
