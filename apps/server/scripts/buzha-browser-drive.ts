/** Owner-instructed direct work in Buzha's browser through her own SnarkBridge tools (Chrome Profile 13, central policy).
 * Reads a JSON array of {tool, arguments} and runs them in order; writes keep a local write-ahead journal, so an identical
 * confirmed action returns its receipt instead of running twice and an unknown outcome blocks a repeat.
 *   node --import tsx scripts/buzha-browser-drive.ts <actions.json> [journal.json]       (from apps/server)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BuzhaTools, BUZHA_TOOLS } from "../src/buzha/tools";
import type { AgentTask } from "../src/agent-ops/types";

const [actionsFile, journalFile = "Y:/Приложения/Бужа/data/agent-work/claude-fl-2026-10-30/effects.json"] = process.argv.slice(2);
type Entry = { tool: string; state: "started" | "confirmed" | "refused" | "unknown"; at: string; result?: unknown; reason?: string };
const journal: Record<string, Entry> = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, "utf8")) : {};
const save = () => writeFileSync(journalFile, JSON.stringify(journal, null, 1));
// An action may carry "repeat": "<reason>" to run again a step whose earlier confirmed result is known to be gone
// (a wizard that closed); the reason is kept in the journal. Unknown outcomes are never repeated.
let repeat = "";
const tools = new BuzhaTools({ effect: async (_task, key, phase, tool, reason) => {
  const entry = journal[key];
  if (phase === "begin") {
    if (entry?.state === "confirmed" && repeat) { (entry as any).repeats = [...((entry as any).repeats ?? []), { at: new Date().toISOString(), reason: repeat }]; entry.state = "started"; save(); return { execute: true, state: "started" }; }
    if (entry?.state === "confirmed") return { execute: false, state: "confirmed", result: entry.result };
    if (entry && entry.state !== "refused") return { execute: false, state: entry.state };
    journal[key] = { tool, state: "started", at: new Date().toISOString() }; save(); return { execute: true, state: "started" };
  }
  if (phase === "refused") { journal[key] = { tool, state: "refused", at: new Date().toISOString(), reason }; save(); return { execute: false, state: "refused" }; }
  if (entry) { entry.state = "confirmed"; save(); }
  return { execute: false, state: "confirmed" };
} });
const task = { id: "claude-fl-2026-10-30", agentId: "app:buzha", spec: { actor: "buzha", tools: BUZHA_TOOLS }, attempts: [{ n: 1 }] } as unknown as AgentTask;
const actions = JSON.parse(readFileSync(actionsFile, "utf8")) as Array<{ tool: string; arguments: Record<string, unknown>; show?: string[]; repeat?: string }>;
const full: unknown[] = [];
try {
  for (const action of actions) {
    let value: any;
    repeat = action.repeat ?? "";
    try {
      value = await tools.invoke(task, action.tool, action.arguments);
      if (value?.effectKey && journal[value.effectKey]) { journal[value.effectKey].result = value; await tools.reconcile(task, action.tool, value); }
      else if (value?.effectKey) await tools.reconcile(task, action.tool, value);
    } catch (error) {
      value = { error: String(error instanceof Error ? error.message : error) };
      for (const entry of Object.values(journal)) if (entry.state === "started" && entry.tool === action.tool) { entry.state = /refused|owner directly|вне области/i.test(value.error) ? "refused" : "unknown"; entry.reason = value.error; }
      save();
    }
    const view = value && typeof value === "object" && typeof value.text === "string"
      ? Object.fromEntries((action.show ?? ["url", "title", "messages", "formStatus", "fileInputs", "text"]).map(key => [key, key === "text" ? value.text.slice(0, 4000) : value[key]]))
      : value;
    full.push({ tool: action.tool, arguments: action.arguments, result: value });
    console.log(`=== ${action.tool} ${JSON.stringify(action.arguments).slice(0, 160)}\n${JSON.stringify(view, null, 0).slice(0, 6000)}`);
  }
} finally { if (process.env.DRIVE_OUT) writeFileSync(process.env.DRIVE_OUT, JSON.stringify(full, null, 1)); await tools.close(); }
