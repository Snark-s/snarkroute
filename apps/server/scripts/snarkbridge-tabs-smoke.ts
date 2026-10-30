/** Live check of Chrome Profile 13 work-tab rules through the real SnarkBridge MCP adapter (the client ChatGPT uses):
 * exact-URL reuse, the work-tab limit, a standing close without one-use approval, concurrent opens creating one tab,
 * repeated cycles not growing tabs, protected and out-of-scope actions still refused, initiators recorded.
 *   node --import tsx scripts/snarkbridge-tabs-smoke.ts [after-restart]      (from apps/server)
 * It closes and reopens only one FL.ru proposal page. Never prints a credential.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { localServiceHome, localServicePort } from "../src/services/local-service-endpoints";

const root = localServiceHome("snarkbridge"); if (!root) throw new Error("SnarkBridge is not registered");
const token = (await readFile(join(root, ".client-auth", "tunnel-bearer"), "utf8")).trim();
const client = new Client({ name: "snarkbridge-tabs-smoke", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${localServicePort("snarkbridge_mcp")}/mcp`), { requestInit: { headers: { authorization: /^Bearer /i.test(token) ? token : `Bearer ${token}`, "x-snarkbridge-initiator": "snarkbridge-tabs-smoke" } } }));
const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const result = await client.callTool({ name, arguments: { session_id: "default", ...args } }) as { content: Array<{ text?: string }>; structuredContent?: any; isError?: boolean };
  if (result.isError) throw new Error(result.content.map(c => c.text).join(" "));
  return result.structuredContent?.result ?? result.structuredContent ?? JSON.parse(result.content[0]?.text ?? "null");
};
const attempt = (name: string, args: Record<string, unknown> = {}) => call(name, args).then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error) }));
const failures: string[] = []; const expect = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures.push(label); };
const workCount = async () => (await call("browser_tab_sources")).tabs.filter((t: any) => !/accounts\.google\.com/.test(t.url)).length;
let proposal = "";
try {
  const status = await call("browser_extension_status");
  console.log(`  extension: connected=${status.connected} loaded=${JSON.stringify(status.loaded)} disk build=${status.disk?.build} ${status.note ?? ""}`);
  expect(status.connected === true, "paired extension connected");
  const tabs = await call("browser_tabs");
  const portfolio = tabs.find((t: any) => t.url.startsWith("https://www.fl.ru/users/buzhastudio/portfolio/"));
  const google = tabs.find((t: any) => t.url.startsWith("https://accounts.google.com/"));
  proposal = tabs.find((t: any) => /^https:\/\/www\.fl\.ru\/projects\/5527306\//.test(t.url))?.url ?? "";
  if (!proposal) throw new Error("the FL.ru proposal tab used by this check is not open");
  const before = await workCount();
  console.log(`  work tabs at start: ${before}`);

  const reuse = await call("browser_tab_action", { action: "create", url: "https://www.fl.ru/users/buzhastudio/portfolio/" });
  expect(reuse.action === "reused" && reuse.tab_id === portfolio?.tab_id && await workCount() === before, `reopening an open URL reuses tab ${portfolio?.tab_id}, no duplicate`);

  if (process.argv.includes("after-restart")) {
    const explain = await call("browser_policy_explain", { action: "tab_close", tab_id: portfolio.tab_id });
    expect(explain.allowed === true && explain.by === "owner standing work policy", `after restart the standing close policy is active (${explain.by})`);
    const sources = await call("browser_tab_sources");
    expect(sources.tabs.some((t: any) => t.role === "browse" && t.created_by?.mcp_client), "after restart the tab registry still knows the dedicated browse tab and its initiator");
  } else {
    const target = tabs.find((t: any) => t.url.startsWith(proposal));
    const atLimit = before >= (await call("browser_tab_sources")).work_tab_limit;
    if (atLimit) {
      const refused = await attempt("browser_tab_action", { action: "create", url: "https://www.fl.ru/users/buzhastudio/info/" });
      expect(!refused.ok && /Work-tab limit/.test(refused.error), "at the work-tab limit a new tab is refused with reuse advice");
    }
    const explain = await call("browser_policy_explain", { action: "tab_close", tab_id: target.tab_id });
    expect(explain.allowed === true, `closing a work tab is allowed by the standing policy (${explain.by})`);
    const closed = await call("browser_tab_action", { action: "close", tab_id: target.tab_id });
    expect(closed.action !== undefined && await workCount() === before - 1, "the work tab closed without a one-use approval");

    const [a, b] = await Promise.all([1, 2].map(() => call("browser_tab_action", { action: "create", url: proposal })));
    console.log(`  concurrent opens: ${a.action}/${a.tab_id}, ${b.action}/${b.tab_id}`);
    await call("browser_wait", { tab_id: a.tab_id, timeout_ms: 8000 }).catch(() => undefined);   // a new tab is listed once its URL commits
    let settled = await workCount();
    for (let n = 0; n < 10 && settled !== before; n++) { await new Promise(r => setTimeout(r, 1000)); settled = await workCount(); }
    expect(a.tab_id === b.tab_id && [a.action, b.action].sort().join() === "created,reused" && settled === before, `two concurrent opens of one URL create one tab (work tabs ${settled})`);

    for (let cycle = 1; cycle <= 3; cycle++) {
      await call("browser_tab_action", { action: "create", url: proposal });
      await call("browser_tab_action", { action: "create", url: "https://mail.google.com/mail/u/0/" });
      await call("browser_tab_action", { action: "create", url: "https://www.fl.ru/users/buzhastudio/portfolio/" });
    }
    expect(await workCount() === before, `three repeated work cycles keep ${before} work tabs`);

    const next = await call("browser_tab_action", { action: "create", url: "https://www.fl.ru/projects/" });
    expect(next.action === "reused" && next.tab_id === a.tab_id && await workCount() === before, "the next search page reuses the dedicated browse tab");
    await call("browser_navigate", { tab_id: a.tab_id, url: proposal });

    const google_close = google ? await attempt("browser_tab_action", { action: "close", tab_id: google.tab_id }) : { ok: false, error: "no tab" };
    expect(!google_close.ok && /approval|owner/i.test(google_close.error), "closing a tab outside the work policy still needs the owner");
    const paid = await call("browser_policy_explain", { action: "navigate", tab_id: a.tab_id, url: "https://www.fl.ru/payed/?from=prj" });
    expect(paid.allowed === false, `navigation to the paid page is refused (${paid.by}: ${paid.reason})`);

    const sources = await call("browser_tab_sources");
    const created = sources.tabs.find((t: any) => t.tab_id === a.tab_id);
    console.log(`  initiator of ${a.tab_id}: ${JSON.stringify(created?.created_by)} role=${created?.role} reuses=${created?.reuses}`);
    expect(created?.created_by?.client === "chatgpt" && created?.created_by?.mcp_client === "snarkbridge-tabs-smoke" && created.role === "browse", "the tab's initiator (client and MCP client) is recorded");
  }
} finally { await client.close(); }
console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
