/** Owner-instructed: add one FL.ru portfolio work through Buzha's own browser tools (Profile 13, central SnarkBridge
 * policy). Selectors come from fresh snapshots inside one run because the site's wizard re-renders and keeps drafts.
 * Stops before the final publish unless --publish is given; never repeats a publish whose outcome is unknown.
 *   node --import tsx scripts/buzha-fl-add-work.ts <tab_id> <section_id> <work-index> [--until=step1|step2|step3] [--publish]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { BuzhaTools, BUZHA_TOOLS } from "../src/buzha/tools";
import type { AgentTask } from "../src/agent-ops/types";

const [tab, section, index] = process.argv.slice(2);
const until = /--until=(\w+)/.exec(process.argv.join(" "))?.[1] ?? "step3";
const manifest = JSON.parse(readFileSync("Y:/Приложения/Бужа/portfolio-publish/2026-10-30-fl/fl-profile-manifest.json", "utf8"));
const work = manifest.works[Number(index)];
const thumb = work.uploadPath.replace(/^Бужа\/portfolio-publish\/2026-10-30(-fl)?\//, "Бужа/portfolio-publish/2026-10-30-fl/thumb-").replace(/\.(jpg|png)$/, "-1200.jpg");
const journalFile = "Y:/Приложения/Бужа/data/agent-work/claude-fl-2026-10-30/effects.json";
const journal = JSON.parse(readFileSync(journalFile, "utf8"));
const save = () => writeFileSync(journalFile, JSON.stringify(journal, null, 1));
let repeat = "";
// Same write-ahead rule as the driver: a confirmed identical action is not repeated without a stated reason; unknown never.
const tools = new BuzhaTools({ effect: async (_task, key, phase, tool, reason) => {
  const entry = journal[key];
  if (phase === "begin") {
    if (entry?.state === "confirmed" && repeat) { entry.repeats = [...(entry.repeats ?? []), { at: new Date().toISOString(), reason: repeat }]; entry.state = "started"; save(); return { execute: true, state: "started" }; }
    if (entry?.state === "confirmed") return { execute: false, state: "confirmed", result: entry.result };
    if (entry && entry.state !== "refused") return { execute: false, state: entry.state };
    journal[key] = { tool, state: "started", at: new Date().toISOString() }; save(); return { execute: true, state: "started" };
  }
  if (phase === "refused") { journal[key] = { tool, state: "refused", at: new Date().toISOString(), reason }; save(); return { execute: false, state: "refused" }; }
  if (entry) { entry.state = "confirmed"; save(); }
  return { execute: false, state: "confirmed" };
} });
const task = { id: "claude-fl-2026-10-30", agentId: "app:buzha", spec: { actor: "buzha", tools: BUZHA_TOOLS }, attempts: [{ n: 1 }] } as unknown as AgentTask;
const log: unknown[] = [];
async function call(tool: string, args: Record<string, unknown>, why = "") {
  repeat = why;
  try { const value = await tools.invoke(task, tool, { tab_id: tab, ...args }); if (value?.effectKey) await tools.reconcile(task, tool, value); log.push({ tool, args, ok: true, value }); return value; }
  catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    for (const entry of Object.values<any>(journal)) if (entry.state === "started" && entry.tool === tool) { entry.state = /refused/i.test(message) ? "refused" : "unknown"; entry.reason = message; }
    save(); log.push({ tool, args, ok: false, error: message }); throw error;
  }
}
const pause = (ms: number) => call("browser_wait", { timeout_ms: ms });
const snap = () => call("browser_snapshot", { max_chars: 6000, element_limit: 400 });
const modalText = (v: any) => { const t = String(v.text ?? ""), i = t.indexOf("Добавление примера работы"); return i < 0 ? "" : t.slice(i, i + 1200); };
const inModal = (v: any) => { const out: any[] = []; let on = false; for (const e of v.elements ?? []) { if (e.id === "fl-example-work-modal") on = true; if (on && !/^(Добавить работу|Редактировать)$/.test(String(e.label).trim())) out.push(e); } return out; };
const why = "мастер открыт заново: прежнее окно закрыто, работа не создана";
try {
  if (!process.argv.includes("--no-nav")) await call("browser_navigate", { url: "https://www.fl.ru/users/buzhastudio/portfolio/" }, why);
  await call("browser_wait", { selector: `#prof_works_${section} button`, state: "visible", timeout_ms: 15000 });
  await pause(5000);
  await call("browser_click", { selector: `#prof_works_${section} > div:nth-of-type(1) > div:nth-of-type(1) > button:nth-of-type(1)` }, why);
  await call("browser_wait", { selector: "#ui-input-example-name-input", state: "visible", timeout_ms: 10000 });
  let v = await snap();
  console.log("OPEN:", modalText(v).slice(0, 500));
  await call("browser_fill", { selector: "#ui-input-example-name-input", value: work.title }, why);
  v = await snap();
  // The wizard's crop editor does not confirm programmatic saves; its hidden cover uploader takes the ready square file.
  const cancel = inModal(v).find((e: any) => /^Отменить$/.test(String(e.label).trim()) && e.selector.startsWith("#qa-example"));
  if (cancel) { await call("browser_click", { selector: cancel.selector }, why); await pause(1500); v = await snap(); }
  const coverUploader = (v.fileInputs ?? []).find((f: any) => f.selector.startsWith("#qa-example-wizard-step-1 > div:nth-of-type(2) > div:nth-of-type(3)") && !f.accept);
  console.log("COVER UPLOADER:", coverUploader?.selector);
  if (coverUploader) { await call("browser_upload", { selector: coverUploader.selector, root: "y_apps", path: thumb }, why); await pause(6000); v = await snap(); const t = modalText(v); console.log("COVER:", t.slice(t.indexOf("Обложка"), t.indexOf("Обложка") + 260)); }
  const files = (v.fileInputs ?? []).filter((f: any) => f.selector.startsWith("#qa-example-wizard-step-1 > div:nth-of-type(2) > div:nth-of-type(5)"));
  console.log("FILE INPUTS:", JSON.stringify(files.map((f: any) => f.selector.slice(-70))));
  const target = files.find((f: any) => /div:nth-of-type\(5\)/.test(f.selector)) ?? files.at(-1);
  console.log("FILES TARGET:", target?.selector, "visibleAncestorDepth", target?.visibleAncestorDepth);
  if (target) {
    await call("browser_upload", { selector: target.selector, root: "y_apps", path: work.uploadPath }, why);
    for (const ms of [1000, 3000, 6000]) { await pause(ms); const s = await snap(); const t = modalText(s); console.log(`after ${ms}ms:`, /Загрузка/.test(t) ? "LOADING" : "-", t.slice(t.indexOf("Файлы, иллюстрирующие"), t.indexOf("Файлы, иллюстрирующие") + 260)); }
  }
  v = await snap();
  console.log("STEP1:", modalText(v).slice(0, 700));
  console.log("IMAGES:", JSON.stringify((v.images ?? []).filter((i: any) => /blob:|upload|temp/.test(i.src)).map((i: any) => i.src.slice(0, 80))));
  for (const e of inModal(v)) if (e.tag !== "a") console.log("  ", e.tag, e.type, e.id, e.disabled ? "DIS" : "", "|", String(e.label).replace(/\s+/g, " ").slice(0, 60), "|", e.selector.slice(-60));
  if (until === "step1") process.exit(0);
  await call("browser_click", { selector: "#qa-project-wizard-step-1-button-next" }, why); await pause(4000);
  v = await snap();
  console.log("STEP2:", modalText(v).slice(0, 900), JSON.stringify(v.messages));
  for (const e of inModal(v)) if (e.tag !== "a") console.log("  ", e.tag, e.type, e.id, e.name, e.disabled ? "DIS" : "", "|", String(e.label).replace(/\s+/g, " ").slice(0, 60), "|", e.selector.slice(-60));
} catch (error) { console.log("STOPPED:", String(error).slice(0, 300)); }
finally { writeFileSync(`C:/Users/serge/AppData/Local/Temp/claude/Y----------SnarkRoute/26c49d14-cd22-4e9d-bf28-f68c4c281aa5/scratchpad/add-work-${index}.json`, JSON.stringify(log, null, 1)); await tools.close(); }
