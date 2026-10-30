/** Read-only probe: can Buzha's loaded browser extension target the hidden file inputs on her FL.ru profile page?
 * Uses browser_prepare_action (describe only; nothing is selected, clicked or saved).
 * Run from apps/server: node --import tsx scripts/buzha-fl-upload-probe.ts [selector ...]
 */
import { BuzhaTools, BUZHA_TOOLS, buzhaObserverFile } from "../src/buzha/tools";
import type { AgentTask } from "../src/agent-ops/types";
const tools = new BuzhaTools({ observerFile: buzhaObserverFile() });
const task = { agentId: "app:buzha", spec: { actor: "buzha", tools: BUZHA_TOOLS } } as AgentTask;
const selectors = process.argv.slice(2).length ? process.argv.slice(2) : ["input[type=file]"];
try {
  const page = await tools.invoke(task, "browser_observe_url", { url: "https://www.fl.ru/users/buzhastudio/portfolio/" });
  for (const selector of selectors) {
    const result = await tools.invoke(task, "browser_prepare_action", { action: "upload", tab_id: page.observerTabId, selector, root: "y_apps", path: "Бужа/portfolio-publish/2026-10-30-fl/fl-cover-900x300.jpg" }).catch(error => ({ error: String(error) }));
    console.log(selector, "=>", JSON.stringify(result).slice(0, 600));
  }
} finally { await tools.close(); }
