/** Live check of the persistent Buzha route through the real SnarkBridge MCP adapter (the one ChatGPT uses):
 * discovery → submit a small safe request → same key returns the same task → status/result; with "after-restart"
 * it only repeats the same key (run it after restarting SnarkBridge). Never prints a credential.
 *   node --import tsx scripts/snarkbridge-buzha-route-smoke.ts [after-restart]      (from apps/server)
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { localServiceHome, localServicePort } from "../src/services/local-service-endpoints";

const key = "route-smoke-2026-10-30-a";
const prompt = "Проверка маршрута SnarkBridge → постоянная Бужа. Ничего не отправляй и не меняй на сайтах: вызови bridge_status и запиши в answer.md одну строку «SnarkBridge: <status>».";
const root = localServiceHome("snarkbridge"); if (!root) throw new Error("SnarkBridge is not registered");
const token = (await readFile(join(root, ".client-auth", "tunnel-bearer"), "utf8")).trim();
const client = new Client({ name: "snarkbridge-buzha-route-smoke", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${localServicePort("snarkbridge_mcp")}/mcp`), { requestInit: { headers: { authorization: /^Bearer /i.test(token) ? token : `Bearer ${token}` } } }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text?: string }>; structuredContent?: any; isError?: boolean };
  if (result.isError) throw new Error(result.content.map(c => c.text).join(" "));
  const value = result.structuredContent?.result ?? result.structuredContent ?? JSON.parse(result.content[0]?.text ?? "null");
  return value;
};
const failures: string[] = []; const expect = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures.push(label); };
try {
  const routes = await call("agent_routes");
  const buzha = (routes as any[]).find(route => route.route === "buzha");
  console.log("  routes:", (routes as any[]).map(route => `${route.route}(${route.provider})`).join(", "));
  expect(buzha?.kind === "persistent_agent", "SnarkBridge discovers the persistent Buzha route");
  const first = await call("agent_submit", { route: "buzha", prompt, idempotency_key: key });
  console.log(`  submit: bridge ${first.id} → SnarkRoute ${first.snarkroute_task_id} (${first.result?.remote_state}); deduplicated by SnarkRoute: ${first.deduplicated_by_snarkroute}`);
  expect(/^t-\d{8}-[0-9a-f]{8}$/.test(first.snarkroute_task_id), "submission created a durable SnarkRoute Buzha task");
  const again = await call("agent_submit", { route: "buzha", prompt, idempotency_key: key });
  expect(again.snarkroute_task_id === first.snarkroute_task_id && again.id === first.id, "the same key returns the same task");
  const refused = await call("agent_submit", { route: "buzha", prompt: prompt + " (другой текст)", idempotency_key: key }).then(() => false, () => true);
  expect(refused, "the same key with another text is refused");
  const status = await call("agent_status", { identifier: first.id });
  console.log(`  status: ${status.status} · ${status.result?.remote_state} · ${String(status.result?.reason ?? "").slice(0, 120)}`);
  expect(status.result?.snarkroute_task_id === first.snarkroute_task_id, "status reads the live SnarkRoute task");
  const result = await call("agent_result", { identifier: first.id });
  console.log(`  result: verified=${result.result?.verified} decision=${result.result?.acceptor_decision ?? "-"}`);
  if (process.argv.includes("after-restart")) console.log("  (run after a SnarkBridge restart: the ids above must equal the ones before it)");
} finally { await client.close(); }
console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
