/**
 * Live end-to-end smoke for Claude Subscription (Claude Code CLI behind SnarkRoute).
 * Every call goes through the SnarkRoute API on 127.0.0.1:4317, never to Claude directly.
 *   tsx apps/server/scripts/claude-subscription-smoke.ts
 * Steps: auth -> route run (standard ai.text path) -> streaming -> model switch + resume ->
 * conversation isolation -> no API key -> simulated limit + automatic fallback.
 * Uses a few short haiku/sonnet turns of the subscription quota; no paid API.
 */
const BASE = process.env.SNARKROUTE_URL ?? "http://127.0.0.1:4317";
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

async function json(path: string, init?: RequestInit) {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  return { status: response.status, body: await response.json() as any };
}

async function runText(params: Record<string, unknown>) {
  const { body } = await json("/api/routes/run", { method: "POST", body: JSON.stringify({ route: {
    routeVersion: "0.1", route: { id: `claude-sub-smoke-${Date.now()}`, title: "Claude subscription smoke", author: { name: "SnarkRoute" } },
    nodes: [{ id: "chat", type: "ai.text", params }], edges: []
  } }) });
  const node = body.nodeResults?.chat ?? {};
  return { status: body.status as string, output: node.output ?? {}, error: node.error ?? body.error, logs: node.logs ?? [] };
}

async function streamChat(payload: Record<string, unknown>) {
  const response = await fetch(`${BASE}/api/claude-subscription/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, stream: true }) });
  const text = await response.text();
  const events = text.split("\n\n").filter(Boolean).map(block => ({
    event: /^event: (.+)$/m.exec(block)?.[1],
    data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "null")
  }));
  return { events, deltas: events.filter(item => item.event === "delta").length, done: events.find(item => item.event === "done")?.data, error: events.find(item => item.event === "error")?.data };
}

// 1. Subscription login
const status = (await json("/api/claude-subscription/status?refresh=1")).body;
console.log("AUTH", JSON.stringify({ enabled: status.enabled, ...status.auth }));
check("1 subscription login", status.auth?.subscription === true, status.auth?.reason ?? `${status.auth?.authMethod} ${status.auth?.subscriptionType ?? ""}`);
check("  provider enabled", status.enabled === true, "CLAUDE_SUBSCRIPTION_ENABLED=1");
if (!status.auth?.subscription || !status.enabled) process.exit(1);

// 2-3. Standard provider path: ai.text route through the Model Gateway runner
const routed = await runText({ executionProvider: "claude_subscription", model: "subscriptions/anthropic/haiku", providerModelId: "subscriptions/anthropic/haiku", prompt: "Reply with exactly one word: PONG" });
check("2-3 route run via SnarkRoute -> Claude Code", routed.status === "succeeded" && /PONG/i.test(routed.output.text ?? ""), `${routed.output.model ?? ""}: ${JSON.stringify(routed.output.text ?? routed.error)}`);
check("  zero booked cost", routed.output.actualCost === 0 && routed.output.pricingSource === "subscription", `apiEquivalentCostUsd=${routed.output.apiEquivalentCostUsd} (information only)`);

// 4. Streaming
const streamed = await streamChat({ model: "subscriptions/anthropic/sonnet", prompt: "Count from 1 to 30, comma separated, nothing else." });
check("4 streaming", streamed.deltas > 1 && Boolean(streamed.done?.text), `${streamed.deltas} deltas, model ${streamed.done?.model ?? streamed.error?.message}`);

// 5-6. Model switch inside one conversation + resume
const first = await json("/api/claude-subscription/chat", { method: "POST", body: JSON.stringify({ model: "subscriptions/anthropic/haiku", conversationId: "new", prompt: "Remember the code word GIRAFFE-731. Reply only: OK" }) });
const conversationId = first.body.conversationId as string;
const second = await json("/api/claude-subscription/chat", { method: "POST", body: JSON.stringify({ model: "subscriptions/anthropic/sonnet", conversationId, prompt: "What code word did I ask you to remember? Reply with the code word only." }) });
check("5 model switch", first.body.alias === "haiku" && second.body.alias === "sonnet" && first.body.model !== second.body.model, `${first.body.model} -> ${second.body.model}`);
check("6 conversation resume", /GIRAFFE-731/i.test(second.body.text ?? ""), JSON.stringify(second.body.text ?? second.body.error));
const other = await json("/api/claude-subscription/chat", { method: "POST", body: JSON.stringify({ model: "subscriptions/anthropic/haiku", conversationId: "new", prompt: "Did I give you a code word earlier in this conversation? If yes, write it; if no, reply NONE." }) });
check("  conversations isolated", !/GIRAFFE/i.test(other.body.text ?? "") && other.body.sessionId !== second.body.sessionId, JSON.stringify(other.body.text ?? other.body.error));
for (const id of [conversationId, other.body.conversationId]) if (id) await json(`/api/claude-subscription/conversations/${id}`, { method: "DELETE" });

// 7. No separately billed API key
const after = (await json("/api/claude-subscription/status?refresh=1")).body;
check("7 no API key", after.auth?.subscription === true && !/api.?key|console/i.test(after.auth?.authMethod ?? ""), `authMethod=${after.auth?.authMethod}; the transport aborts any turn whose init reports apiKeySource != none`);

// 8. Limit handling + automatic fallback (simulated limit, real routing)
const autoParams = { providerMode: "auto", prompt: "Reply with one word: READY", routingPolicy: { localModels: "exclude" } };
await json("/api/claude-subscription/quota/simulate-exhausted", { method: "POST", body: JSON.stringify({ seconds: 120 }) });
const limited = await json("/api/claude-subscription/chat", { method: "POST", body: JSON.stringify({ model: "subscriptions/anthropic/haiku", prompt: "hi" }) });
check("8 limit reported", limited.status === 429 && limited.body.error?.code === "SUBSCRIPTION_LIMIT_REACHED", `${limited.status} ${limited.body.error?.message ?? ""}`);
const fallback = await runText(autoParams);
const fellBack = fallback.output.provider !== "claude_subscription";
check("  auto routing skips exhausted subscription", fellBack, fallback.status === "succeeded"
  ? `fallback ${fallback.output.provider}/${fallback.output.model}, cost ${fallback.output.actualCost ?? fallback.output.estimatedCost}`
  : `no free route, paid not used: ${String(fallback.error?.message ?? fallback.error).slice(0, 160)}`);
await json("/api/claude-subscription/quota/simulate-exhausted", { method: "DELETE" });
const restored = await runText(autoParams);
console.log("INFO auto routing after reset:", restored.output.provider ?? restored.error?.message ?? restored.error, restored.output.model ?? "");

const usage = (await json("/api/claude-subscription/status")).body.usage24h;
console.log("USAGE24H", JSON.stringify(usage));
console.log(failures ? `FAILED ${failures}` : "ALL PASSED");
process.exit(failures ? 1 : 0);
