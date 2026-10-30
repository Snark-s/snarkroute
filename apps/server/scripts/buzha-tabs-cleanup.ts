/** Close duplicate work tabs in Buzha's Chrome Profile 13 under the owner's standing tab-close policy.
 * Keeps the tabs listed in KEEP (by id) and, among the rest, never closes a tab whose fresh read shows unsaved or
 * in-progress work (open wizard, crop dialog, mail draft, form errors). Dry run by default; --close closes.
 *   node --import tsx scripts/buzha-tabs-cleanup.ts [--close] [keepId,...]      (from apps/server)
 */
import { writeFileSync } from "node:fs";
import { BuzhaTools, BUZHA_TOOLS, buzhaObserverFile } from "../src/buzha/tools";
import type { AgentTask } from "../src/agent-ops/types";

const close = process.argv.includes("--close");
const keep = new Set((process.argv.find(arg => /^\d+(,\d+)*$/.test(arg)) ?? "").split(",").filter(Boolean));
// Tabs this cleanup's operator opened and finished (their result is saved on the site): closed even if they show a dialog.
const finished = new Set((/--finished=([\d,]+)/.exec(process.argv.join(" "))?.[1] ?? "").split(",").filter(Boolean));
const normalize = (url: string) => { const u = new URL(url); return `${u.origin}${u.pathname.replace(/\/$/, "")}${u.search}`; };
// Proposal pages hold no drafts here (responses on these sites are paid or by mail); unreadable ones may close.
const proposal = /^https:\/\/(www\.fl\.ru\/projects\/\d+\/|illustrators\.ru\/jobs\/[^/]+$|freelance\.ru\/task\/view\/\d+)/;
const journal = new Map<string, unknown>();
const tools = new BuzhaTools({ observerFile: buzhaObserverFile(), effect: async (_task, key, phase) => {
  if (phase === "begin") { if (journal.has(key)) return { execute: false, state: "confirmed", result: journal.get(key) }; journal.set(key, null); return { execute: true, state: "started" }; }
  return { execute: false, state: "confirmed" };
} });
const task = { id: "tab-cleanup", agentId: "app:buzha", spec: { actor: "buzha", tools: BUZHA_TOOLS }, attempts: [{ n: 1 }] } as unknown as AgentTask;
const busy = /Добавление примера работы|Двигайте изображение|Двигайте фото|Новое сообщение|Черновик сохран|Поле заполнено некорректно|Сохранить обложку/;
const report: unknown[] = [];
try {
  const tabs = await tools.invoke(task, "browser_tabs", {}) as Array<{ tab_id: string; url: string; title: string }>;
  console.log(`tabs before: ${tabs.length}`);
  const keptUrls = new Set(tabs.filter(tab => keep.has(tab.tab_id)).map(tab => normalize(tab.url)));
  for (const tab of tabs) {
    if (keep.has(tab.tab_id)) { report.push({ ...tab, decision: "keep (selected)" }); continue; }
    let decision = "close";
    try {
      const page = await tools.invoke(task, "browser_snapshot", { tab_id: tab.tab_id, max_chars: 20000, element_limit: 5 });
      const text = String(page?.text ?? "");
      if (busy.test(text) && !finished.has(tab.tab_id)) decision = `keep (in-progress work: ${busy.exec(text)?.[0]})`;
    } catch (error) {
      // Chrome discards idle tabs under memory pressure and never discards tabs with unsaved form input; a discarded
      // duplicate of a kept URL or a proposal page is safe to close, anything else unreadable stays.
      decision = keptUrls.has(normalize(tab.url)) ? "close" : proposal.test(tab.url) ? "close" : `keep (not readable: ${String(error).slice(-60)})`;
    }
    if (decision === "close" && close) {
      try { await tools.invoke(task, "browser_tab_action", { action: "close", tab_id: tab.tab_id }); decision = "closed"; }
      catch (error) { decision = `close refused: ${String(error).slice(-160)}`; }
    }
    report.push({ ...tab, decision });
    console.log(`${tab.tab_id} ${decision.padEnd(28)} ${tab.url.slice(0, 90)}`);
  }
  const after = await tools.invoke(task, "browser_tabs", {}) as unknown[];
  console.log(`tabs after: ${after.length}`);
} finally {
  writeFileSync("Y:/Приложения/Бужа/data/agent-work/claude-fl-2026-10-30/evidence/tab-cleanup-" + (close ? "closed" : "dry-run") + ".json", JSON.stringify(report, null, 1));
  await tools.close();
}
