/** Real MCP/API duplicate protection and a model/tool/Acceptor run. No commercial actions. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadRootEnv } from "../src/services/env-loader";
import { localServicePort } from "../src/services/local-service-endpoints";
loadRootEnv();
const base = `http://127.0.0.1:${localServicePort("snarkroute")}`;
const client = new Client({ name: "buzha-mcp-smoke", version: "1" });
const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${process.env.SNARKROUTE_MCP_TOKEN}` } } });
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content as Array<{ type: string; text?: string }> : [];
  const text = content.filter(c => c.type === "text").map(c => c.text).join("\n"); if (result.isError) throw new Error(text); return JSON.parse(text);
}
try {
  await client.connect(transport); const tools = await client.listTools();
  for (const name of ["buzha_message", "buzha_status", "buzha_task", "buzha_control", "agent_acceptor_status"]) assert(tools.tools.some(t => t.name === name), `missing ${name}`);
  const input = { content: "Безопасная проверка API/MCP. Из внешних инструментов используй bridge_status. По его реальному ответу локально запиши answer.md со строкой SnarkBridge: ok и фактической версией сервера. Не открывай страницы, не отправляй сообщения, не меняй аккаунты.", requestKey: "buzha-mcp-2026-10-30-v2", quality: "high" };
  const first = await call("buzha_message", input), second = await call("buzha_message", input);
  assert.equal(first.task.id, second.task.id); assert.equal(second.deduplicated, true);
  const apiDuplicate: any = await fetch(base + "/api/agents/buzha/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }).then(r => r.json());
  assert.equal(apiDuplicate.task.id, first.task.id); assert.equal(apiDuplicate.deduplicated, true);
  console.log(`MCP task ${first.task.id}; MCP and API repetitions returned the same task.`);
  const started = Date.now(); let last = "";
  for (;;) {
    const state = await call("buzha_task", { taskId: first.task.id }), task = state.task;
    const line = `${task.state}: ${task.reason}`; if (line !== last) { console.log(line); last = line; }
    if (["verified", "blocked", "failed", "cancelled"].includes(task.state)) {
      const directory = resolve("data", "agent-ops", "sandbox", "buzha-mcp-smoke"); await mkdir(directory, { recursive: true }); const artifact = join(directory, `${task.id}.json`);
      await writeFile(artifact, JSON.stringify({ ...state, mcpDeduplicated: second.deduplicated, apiDeduplicated: apiDuplicate.deduplicated }, null, 2));
      assert.equal(task.state, "verified"); assert(task.attempts.some((a: any) => a.toolCalls?.some((t: any) => t.tool === "bridge_status" && t.ok)));
      console.log(JSON.stringify({ taskId: task.id, state: task.state, attempts: task.attempts.length, actualModels: task.attempts.flatMap((a: any) => a.modelCalls ?? []).filter((c: any) => c.ok).map((c: any) => ({ provider: c.provider, model: c.model })), evidence: task.evidence.length, mcpDeduplicated: true, apiDeduplicated: true, artifact }, null, 2)); break;
    }
    if (Date.now() - started > 8 * 60000) throw new Error(`Task remains ${task.state}; inspect ${task.id}, do not resubmit.`);
    await new Promise(r => setTimeout(r, 2000));
  }
} finally { await transport.terminateSession().catch(() => undefined); await client.close(); }
