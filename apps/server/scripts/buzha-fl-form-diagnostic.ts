/** Read-only diagnostic of FL.ru profile editing pages in Buzha's Chrome Profile 13 through her own SnarkBridge
 * read tools: fresh observer tabs, visible text, form messages, file inputs (attached vs visible). No fill, click or upload.
 * Run from apps/server: node --import tsx scripts/buzha-fl-form-diagnostic.ts [url ...]
 */
import { writeFileSync } from "node:fs";
import { BuzhaTools, BUZHA_TOOLS, buzhaObserverFile } from "../src/buzha/tools";
import type { AgentTask } from "../src/agent-ops/types";

const pages = process.argv.slice(2).length ? process.argv.slice(2) : [
  "https://www.fl.ru/users/buzhastudio/portfolio/",
  "https://www.fl.ru/users/buzhastudio/setup/main/",
  "https://www.fl.ru/users/buzhastudio/setup/specsetup/",
  "https://www.fl.ru/users/buzhastudio/setup/portfolio/"
];
const tools = new BuzhaTools({ observerFile: buzhaObserverFile() });
const task = { agentId: "app:buzha", spec: { actor: "buzha", tools: BUZHA_TOOLS } } as AgentTask;
const report: unknown[] = [];
try {
  for (const url of pages) {
    try {
      const page = await tools.invoke(task, "browser_observe_url", { url });
      const tab = page.observerTabId;
      const files: Record<string, unknown> = {};
      for (const state of ["attached", "visible"]) files[state] = await tools.invoke(task, "browser_wait", { tab_id: tab, selector: "input[type=file]", state, timeout_ms: 1500 }).catch(error => String(error));
      const fileLike = (page.elements ?? []).filter((e: any) => e.tag === "input" && e.type === "file" || /загруз|фото|обложк|аватар|изображ/i.test(String(e.label ?? "")));
      report.push({ url, finalUrl: page.url, title: page.title, snapshotFileInputs: page.fileInputs ?? "absent (extension build without fileInputs)", messages: page.messages, formStatus: page.formStatus, images: page.images, fileInputs: files, fileLikeElements: fileLike, elements: page.elements, text: page.text?.slice(0, 6000) });
    } catch (error) { report.push({ url, error: String(error) }); }
  }
  const out = process.env.DIAG_OUT ?? "fl-form-diagnostic.json";
  writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report.map((r: any) => ({ url: r.url, finalUrl: r.finalUrl, error: r.error, fileInputs: r.fileInputs, fileLike: r.fileLikeElements?.length, messages: r.messages })), null, 1));
} finally { await tools.close(); }
