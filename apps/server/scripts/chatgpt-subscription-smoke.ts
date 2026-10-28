/**
 * Live end-to-end smoke for ChatGPT Subscription (Codex CLI behind SnarkRoute).
 * Every call goes through the SnarkRoute API (default 127.0.0.1:4317), never to OpenAI directly.
 *   tsx apps/server/scripts/chatgpt-subscription-smoke.ts
 * Steps: login -> route run (standard ai.text path) -> stream endpoint -> model switch + resume ->
 * conversation isolation -> no API key -> cancellation -> simulated limit + automatic fallback.
 * Uses a few short turns of the ChatGPT plan quota; no paid API.
 */
const BASE = process.env.SNARKROUTE_URL ?? "http://127.0.0.1:4317";
const ROOT = "/api/chatgpt-subscription";
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

async function json(path: string, init?: RequestInit) {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  return { status: response.status, body: await response.json() as any };
}

async function runText(params: Record<string, unknown>) {
  const { body } = await json("/api/routes/run", { method: "POST", body: JSON.stringify({ route: {
    routeVersion: "0.1", route: { id: `chatgpt-sub-smoke-${Date.now()}`, title: "ChatGPT subscription smoke", author: { name: "SnarkRoute" } },
    nodes: [{ id: "chat", type: "ai.text", params }], edges: []
  } }) });
  const node = body.nodeResults?.chat ?? {};
  return { status: body.status as string, output: node.output ?? {}, error: node.error ?? body.error, logs: node.logs ?? [] };
}

const chat = (payload: Record<string, unknown>) => json(`${ROOT}/chat`, { method: "POST", body: JSON.stringify(payload) });

// 1. ChatGPT login
const status = (await json(`${ROOT}/status?refresh=1`)).body;
console.log("AUTH", JSON.stringify({ enabled: status.enabled, ...status.auth }));
console.log("MODELS", (status.models ?? []).map((model: any) => model.alias).join(", "));
check("1 ChatGPT login", status.auth?.subscription === true && status.auth?.authMode === "chatgpt", status.auth?.reason ?? `codex ${status.auth?.version}, ${status.auth?.authMode}`);
check("  provider enabled", status.enabled === true, "CHATGPT_SUBSCRIPTION_ENABLED=1");
if (!status.auth?.subscription || !status.enabled) process.exit(1);
const fast = (status.models ?? []).find((model: any) => /fast|efficient/i.test(model.description ?? ""))?.alias ?? "default";
const other = (status.models ?? []).find((model: any) => model.alias !== fast && model.alias !== "default")?.alias ?? "default";

// 2-3. Standard provider path: ai.text route through the Model Gateway runner
const routed = await runText({ executionProvider: "chatgpt_subscription", model: "subscriptions/openai/default", providerModelId: "subscriptions/openai/default", prompt: "Reply with exactly one word: PONG" });
check("2-3 route run via SnarkRoute -> Codex CLI", routed.status === "succeeded" && /PONG/i.test(routed.output.text ?? ""), `${routed.output.model ?? ""}: ${JSON.stringify(routed.output.text ?? routed.error)}`);
check("  zero booked cost", routed.output.actualCost === 0 && routed.output.pricingSource === "subscription");

// 4. Stream endpoint: Codex exec has no text deltas, so only session/done arrive.
const streamResponse = await fetch(`${BASE}${ROOT}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: `subscriptions/openai/${fast}`, prompt: "Count from 1 to 10, comma separated, nothing else.", stream: true }) });
const events = (await streamResponse.text()).split("\n\n").filter(Boolean).map(block => ({ event: /^event: (.+)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "null") }));
const done = events.find(item => item.event === "done")?.data;
check("4 stream endpoint (final message only)", Boolean(done?.text) && events.some(item => item.event === "session"), `${events.map(item => item.event).join(",")}; deltas ${events.filter(item => item.event === "delta").length} (CLI emits none)`);

// 5-6. Model switch inside one conversation + resume
const first = await chat({ model: `subscriptions/openai/${fast}`, conversationId: "new", prompt: "Remember the code word GIRAFFE-731. Reply only: OK" });
const conversationId = first.body.conversationId as string;
const second = await chat({ model: `subscriptions/openai/${other}`, conversationId, prompt: "What code word did I ask you to remember? Reply with the code word only." });
check("5 model switch", first.body.alias === fast && second.body.alias === other && first.body.model !== second.body.model, `${first.body.model} -> ${second.body.model}`);
check("6 conversation resume", /GIRAFFE-731/i.test(second.body.text ?? "") && second.body.sessionId === first.body.sessionId, JSON.stringify(second.body.text ?? second.body.error));
const isolated = await chat({ model: `subscriptions/openai/${fast}`, conversationId: "new", prompt: "Did I give you a code word earlier in this conversation? If yes, write it; if no, reply NONE." });
check("  conversations isolated", !/GIRAFFE/i.test(isolated.body.text ?? "") && isolated.body.sessionId !== second.body.sessionId, JSON.stringify(isolated.body.text ?? isolated.body.error));
for (const id of [conversationId, isolated.body.conversationId]) if (id) await json(`${ROOT}/conversations/${id}`, { method: "DELETE" });

// 7. No separately billed API key: OPENAI_* is stripped, the CLI is forced to the ChatGPT login,
// and the plan's own rate-limit snapshot (plan_type) is only reported for a ChatGPT login.
const after = (await json(`${ROOT}/status?refresh=1`)).body;
check("7 no API key", after.auth?.authMode === "chatgpt" && Boolean(after.planType), `authMode=${after.auth?.authMode}, plan=${after.planType}, 5h window ${after.quota?.lastRateLimit?.primary?.usedPercent}% used`);

// 8. Cancellation: abort the HTTP request; the Codex process is killed and the turn recorded as cancelled.
const controller = new AbortController();
const cancelled = fetch(`${BASE}${ROOT}/chat`, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
  body: JSON.stringify({ model: `subscriptions/openai/${fast}`, prompt: "Write a 600-word story about a lighthouse." }) }).catch(() => undefined);
setTimeout(() => controller.abort(), 1_500);
await cancelled;
await new Promise(resolve => setTimeout(resolve, 1_500));
const recent = (await json(`${ROOT}/status`)).body.recent ?? [];
check("8 cancellation", recent[0]?.status === "cancelled", `last entry ${recent[0]?.status} ${recent[0]?.errorCode ?? ""}`);

// 9. Limit handling + automatic fallback (simulated limit, real routing)
const autoParams = { providerMode: "auto", prompt: "Reply with one word: READY", routingPolicy: { localModels: "exclude" } };
await json(`${ROOT}/quota/simulate-exhausted`, { method: "POST", body: JSON.stringify({ seconds: 120 }) });
const limited = await chat({ model: "subscriptions/openai/default", prompt: "hi" });
check("9 limit reported", limited.status === 429 && limited.body.error?.code === "SUBSCRIPTION_LIMIT_REACHED", `${limited.status} ${limited.body.error?.message ?? ""}`);
const fallback = await runText(autoParams);
check("  auto routing skips exhausted ChatGPT", fallback.output.provider !== "chatgpt_subscription", fallback.status === "succeeded"
  ? `fallback ${fallback.output.provider}/${fallback.output.model}, cost ${fallback.output.actualCost ?? fallback.output.estimatedCost}`
  : `no free route, paid not used: ${String(fallback.error?.message ?? fallback.error).slice(0, 160)}`);
await json(`${ROOT}/quota/simulate-exhausted`, { method: "DELETE" });
const restored = await runText({ ...autoParams, routingPolicy: { localModels: "exclude", excludeModelRefs: [] } });
console.log("INFO auto routing after reset:", restored.output.provider ?? restored.error?.message ?? restored.error, restored.output.model ?? "");

const usage = (await json(`${ROOT}/status`)).body.usage24h;
console.log("USAGE24H", JSON.stringify(usage));
console.log(failures ? `FAILED ${failures}` : "ALL PASSED");
process.exit(failures ? 1 : 0);
