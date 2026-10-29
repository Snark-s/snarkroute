import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile, realpath, mkdir, writeFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, dirname, join } from "node:path";
import { localServiceHome, localServicePort } from "../services/local-service-endpoints";
import { buzhaMemory } from "./memory";
import type { AgentTask, TaskCheck, CheckResult } from "../agent-ops/types";

export const BUZHA_READ_TOOLS = ["bridge_status", "browser_sessions", "browser_tabs", "browser_snapshot", "browser_find"];
export const BUZHA_TOOLS = [...BUZHA_READ_TOOLS, "memory_read", "workspace_read", "workspace_write", "delegate"];

/** Reuses the existing authenticated bridge client and its owner policy. No profile launch,
 * cookie access, new grants, tool writes, commercial messages or permission fallback. */
export class BuzhaTools {
  private client?: Promise<Client>;
  constructor(private readonly deps: { bridge?: (name: string, args: Record<string, unknown>) => Promise<unknown>; memory?: typeof buzhaMemory; delegate?: (task: AgentTask, args: Record<string, unknown>) => Promise<unknown> } = {}) {}
  private async bridge(name: string, args: Record<string, unknown>): Promise<any> {
    if (!BUZHA_READ_TOOLS.includes(name)) throw new Error("Инструмент не разрешён политикой Бужи.");
    if (this.deps.bridge) return this.deps.bridge(name, args);
    this.client ??= (async () => {
      const root = localServiceHome("snarkbridge"); if (!root) throw new Error("SnarkBridge не зарегистрирован.");
      const token = (await readFile(join(root, ".client-auth", "tunnel-bearer"), "utf8")).trim();
      const authorization = /^Bearer /i.test(token) ? token : `Bearer ${token}`;
      const client = new Client({ name: "SnarkRoute-Buzha", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${localServicePort("snarkbridge_mcp")}/mcp`), { requestInit: { headers: { authorization } } }));
      return client;
    })().catch(error => { this.client = undefined; throw error; });
    const result = await (await this.client).callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    const blocks = Array.isArray(result.content) ? result.content as Array<{ type: string; text?: string }> : [];
    if (result.isError) throw new Error(blocks.filter(c => c.type === "text").map(c => c.text).join("\n") || "SnarkBridge отклонил действие.");
    const structured = result.structuredContent as any;
    if (structured) return Object.keys(structured).length === 1 && "result" in structured ? structured.result : structured;
    const raw = blocks.filter(c => c.type === "text").map(c => c.text).join("\n");
    try { return JSON.parse(raw); } catch { throw new Error("SnarkBridge вернул неподтверждённый результат инструмента."); }
  }
  async invoke(task: AgentTask, name: string, args: Record<string, unknown>): Promise<any> {
    if (task.spec.actor !== "buzha" || task.agentId !== "app:buzha" || !BUZHA_TOOLS.includes(name) || !task.spec.tools?.includes(name)) throw new Error("Инструмент вне полномочий задачи Бужи.");
    if (name === "bridge_status") return this.bridge(name, {});
    if (name.startsWith("browser_")) {
      const sessions = await this.bridge("browser_sessions", {});
      const selected = sessions?.sessions?.find((s: any) => s.id === "default" && s.profile_directory === "Profile 13");
      if (!selected?.available) throw new Error("Рабочая сессия Бужи Chrome Profile 13 не подтверждена; другой профиль не используется.");
      if (name === "browser_sessions") return sessions;
      return this.bridge(name, { ...args, session_id: "default" });
    }
    if (name === "memory_read") {
      const memory = await (this.deps.memory ?? buzhaMemory)();
      return { identity: memory.identity, model: memory.model, jobs: memory.jobs?.slice(0, 15), tasks: memory.tasks?.slice(0, 15), messages: memory.messages?.slice(-12) };
    }
    if (name === "delegate") { if (!this.deps.delegate) throw new Error("Общая очередь делегирования недоступна."); return this.deps.delegate(task, args); }
    if (!task.workdir || typeof args.path !== "string" || args.path.length > 500) throw new Error("Нужен путь внутри рабочей папки задачи.");
    const root = await realpath(task.workdir), target = resolve(root, args.path), rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Путь вне рабочей папки задачи.");
    if (name === "workspace_write") {
      if (task.spec.permissions?.fileWrite === false || typeof args.content !== "string" || args.content.length > 100000) throw new Error("Запись файла не разрешена или превышает лимит.");
      let ancestor = dirname(target);
      for (;;) { const canonical = await realpath(ancestor).catch(() => undefined); if (canonical) { const r = relative(root, canonical); if (r.startsWith("..") || isAbsolute(r)) throw new Error("Симлинк вне рабочей папки."); break; } const next = dirname(ancestor); if (next === ancestor) throw new Error("Рабочая папка недоступна."); ancestor = next; }
      await mkdir(dirname(target), { recursive: true });
      const parent = await realpath(dirname(target)); const canonicalRel = relative(root, parent);
      if (canonicalRel.startsWith("..") || isAbsolute(canonicalRel)) throw new Error("Симлинк вне рабочей папки.");
      const existing = await realpath(target).catch(() => undefined);
      if (existing && (relative(root, existing).startsWith("..") || isAbsolute(relative(root, existing)))) throw new Error("Симлинк вне рабочей папки.");
      await writeFile(target, args.content, "utf8"); return { written: true, path: args.path, characters: args.content.length };
    }
    const canonical = await realpath(target), canonicalRel = relative(root, canonical);
    if (canonicalRel.startsWith("..") || isAbsolute(canonicalRel) || (await stat(canonical)).size > 100000) throw new Error("Чтение файла вне разрешённой области.");
    return { path: args.path, content: await readFile(canonical, "utf8") };
  }
  async check(task: AgentTask, check: Extract<TaskCheck, { type: "tool" }>): Promise<CheckResult> {
    const at = Date.now(), source = `SnarkBridge/MCP:${check.tool}`;
    try {
      if (!BUZHA_READ_TOOLS.includes(check.tool)) throw new Error("Приёмщик использует только разрешённые инструменты чтения.");
      const result = await this.invoke(task, check.tool, check.arguments ?? {});
      let value: any = result; for (const part of check.json.path.split(".")) value = value?.[part];
      const content = JSON.stringify(result), ok = value === check.json.equals;
      return { check, ok, detail: ok ? "Независимый ответ инструмента подтверждает условие." : "Независимый ответ инструмента не подтверждает условие.", source, observedAt: new Date().toISOString(), content: content.slice(0, 12000), truncated: content.length > 12000, durationMs: Date.now() - at };
    } catch (error) { return { check, ok: false, detail: String(error), source, observedAt: new Date().toISOString(), durationMs: Date.now() - at }; }
  }
  async observations(task: AgentTask): Promise<CheckResult> {
    const started = Date.now(), check = { type: "tool_observations" } as const;
    try {
      const calls = task.attempts.at(-1)?.toolCalls?.filter(call => call.ok && BUZHA_READ_TOOLS.includes(call.tool)) ?? [];
      const distinct = new Map(calls.map(call => [`${call.tool}:${JSON.stringify(call.arguments)}`, call]));
      if (distinct.size > 6) throw new Error("Для независимой проверки больше шести разных источников нужен отдельный контракт.");
      const observations = [];
      for (const call of distinct.values()) observations.push({ tool: call.tool, arguments: call.arguments, observedAt: new Date().toISOString(), result: await this.invoke(task, call.tool, call.arguments) });
      const content = JSON.stringify({ observations, note: observations.length ? "Fresh independent tool reads; executor reports are not evidence." : "No independently observed external result. A local answer alone cannot prove an external action." });
      return { check, ok: true, detail: `Независимо перечитано источников: ${observations.length}.`, source: "SnarkBridge/MCP:independent-reobservations", observedAt: new Date().toISOString(), content: content.slice(0, 12000), truncated: content.length > 12000, durationMs: Date.now() - started };
    } catch (error) { return { check, ok: false, detail: String(error), source: "SnarkBridge/MCP:independent-reobservations", observedAt: new Date().toISOString(), durationMs: Date.now() - started }; }
  }
  async close() { const client = await this.client?.catch(() => undefined); await client?.close(); this.client = undefined; }
}
