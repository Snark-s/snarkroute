import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  classifyCodexFailure,
  codexCliEnv,
  codexExecArgs,
  CodexCliError,
  codexLimitReached,
  interpretLoginStatus,
  parseCodexRateLimits,
  runCodexExec,
  type CodexAuthStatus,
  type CodexExecResult
} from "./codex-cli";
import { ChatGptSubscriptionService } from "./chatgpt-subscription";
import { modelCostTier } from "./model-routing-policy";

type Call = { command: string; args: string[]; env: NodeJS.ProcessEnv; stdin: string };

function fakeSpawn(lines: (call: Call) => unknown[], calls: Call[] = [], options: { hang?: boolean; exitCode?: number } = {}) {
  return ((command: string, args: string[], spawnOptions: { env: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; kill: () => boolean };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    const call: Call = { command, args, env: spawnOptions.env, stdin: "" };
    calls.push(call);
    const finish = (code: number | null) => { if (child.exitCode !== null) return; child.exitCode = code ?? 1; child.stdout.end(); setImmediate(() => child.emit("close", code)); };
    child.kill = () => { finish(null); return true; };
    if (args[0] !== "exec") { setImmediate(() => finish(0)); return child; }
    child.stdin.on("data", chunk => { call.stdin += String(chunk); });
    child.stdin.on("finish", () => {
      for (const line of lines(call)) child.stdout.write(`${JSON.stringify(line)}\n`);
      if (!options.hang) finish(options.exitCode ?? 0);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

const THREAD = "01a1839c-a36c-7b03-bc3f-d7aa4dca1636";
const started = { type: "thread.started", thread_id: THREAD };
const message = (text: string) => ({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
const completed = { type: "turn.completed", usage: { input_tokens: 3181, cached_input_tokens: 100, output_tokens: 84, reasoning_output_tokens: 14 } };
const rateLimits = (primary: number, extra: Record<string, unknown> = {}) => ({
  limit_id: "codex", primary: { used_percent: primary, window_minutes: 300, resets_at: 1_793_223_485 },
  secondary: { used_percent: 11, window_minutes: 10080, resets_at: 1_793_790_777 }, credits: { has_credits: false, unlimited: false, balance: "0" },
  plan_type: "plus", rate_limit_reached_type: null, ...extra
});
const subscriber: CodexAuthStatus = { installed: true, command: "codex", loggedIn: true, authMode: "chatgpt", subscription: true, checkedAt: "" };

async function temp() { return mkdtemp(join(tmpdir(), "chatgpt-sub-")); }

/** A session file shaped like the one Codex writes into CODEX_HOME/sessions/YYYY/MM/DD. */
async function codexHomeWithSession(model: string, limits: Record<string, unknown>) {
  const home = await temp();
  const now = new Date();
  const directory = join(home, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `rollout-2026-10-28T20-44-03-${THREAD}.jsonl`), [
    { type: "session_meta", payload: { id: THREAD } },
    { type: "turn_context", payload: { model } },
    { type: "event_msg", payload: { type: "token_count", info: {}, rate_limits: limits } }
  ].map(line => JSON.stringify(line)).join("\n"));
  return home;
}

describe("Codex CLI transport", () => {
  it("runs plain text with user config, rules, MCP, skills, web search and shell tools off", () => {
    const args = codexExecArgs({ model: "gpt-5.6-luna" }, "C:\\data\\prompts\\p.txt", "C:\\data\\workspace");
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toEqual(expect.arrayContaining(["--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-s", "read-only", "-C", "C:\\data\\workspace", "-m", "gpt-5.6-luna",
      'model_instructions_file="C:/data/prompts/p.txt"', 'forced_login_method="chatgpt"', "mcp_servers={}", 'web_search="disabled"', "skills.include_instructions=false",
      "features.shell_tool=false", "features.unified_exec=false", "features.apps=false", "features.plugins=false"]));
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("--disable");
    const resume = codexExecArgs({ resumeSessionId: THREAD }, "p.txt", "w");
    expect(resume.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(resume.slice(-2)).toEqual([THREAD, "-"]);
    expect(resume).not.toContain("-m");
    expect(resume).not.toContain("-C");
    expect(resume).toContain('sandbox_mode="read-only"');
  });

  it("strips OpenAI API keys and host Codex variables but keeps CODEX_HOME", () => {
    const env = codexCliEnv({ PATH: "p", OPENAI_API_KEY: "sk-x", OPENAI_BASE_URL: "http://x", CODEX_API_KEY: "k", CODEX_ACCESS_TOKEN: "t", CODEX_THREAD_ID: "1", AZURE_OPENAI_API_KEY: "a", CODEX_HOME: "h" });
    expect(env).toMatchObject({ PATH: "p", CODEX_HOME: "h" });
    expect(Object.keys(env).filter(key => /OPENAI|^CODEX_(?!HOME$)/.test(key))).toEqual([]);
  });

  it("accepts only a ChatGPT login", () => {
    const base = { command: "codex", checkedAt: "" };
    expect(interpretLoginStatus("Logged in using ChatGPT", 0, base)).toMatchObject({ subscription: true, authMode: "chatgpt" });
    expect(interpretLoginStatus("Logged in using an API key - sk-proj-***abc", 0, base)).toMatchObject({ subscription: false, loggedIn: true, authMode: "api_key" });
    expect(interpretLoginStatus("Not logged in", 1, base)).toMatchObject({ subscription: false, loggedIn: false });
    expect(interpretLoginStatus("Not logged in", 1, base).reason).toContain("codex login");
  });

  it("sends the prompt on stdin, returns the final message and reads model and quota from Codex's session file", async () => {
    const calls: Call[] = [];
    const home = await codexHomeWithSession("gpt-5.6-sol", rateLimits(3));
    const out = await runCodexExec({ prompt: "hi", systemPrompt: "be brief" },
      { command: "codex", env: { CODEX_HOME: home }, workspace: join(await temp(), "workspace"), spawnImpl: fakeSpawn(() => [started, { type: "turn.started" }, message("PONG"), completed], calls) });
    expect(out).toMatchObject({ text: "PONG", sessionId: THREAD, model: "gpt-5.6-sol", usage: { inputTokens: 3181, cachedInputTokens: 100, outputTokens: 84, reasoningOutputTokens: 14 } });
    expect(out.rateLimit).toMatchObject({ planType: "plus", primary: { usedPercent: 3, windowMinutes: 300 }, hasCredits: false });
    expect(calls[0].stdin).toBe("hi");
    expect(calls[0].args).not.toContain("hi");
    expect(calls[0].env.OPENAI_API_KEY).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 20));
    // One-shot turns leave nothing in the owner's Codex session list.
    expect(calls.some(call => call.args.join(" ") === `delete --force ${THREAD}`)).toBe(true);
  });

  it("keeps persisted turns and treats notice items as warnings", async () => {
    const calls: Call[] = [];
    const notice = { type: "item.completed", item: { id: "item_0", type: "error", message: "This session was recorded with model `a` but is resuming with `b`." } };
    const out = await runCodexExec({ prompt: "again", resumeSessionId: THREAD, model: "b" },
      { command: "codex", env: { CODEX_HOME: await temp() }, workspace: join(await temp(), "workspace"), spawnImpl: fakeSpawn(() => [started, notice, message("ZEBRA-41"), completed], calls) });
    expect(out).toMatchObject({ text: "ZEBRA-41", model: "b" });
    expect(out.warnings[0]).toContain("resuming");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls.some(call => call.args[0] === "delete")).toBe(false);
  });

  it("stops a turn that tries to run a command", async () => {
    const command = { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "dir" } };
    await expect(runCodexExec({ prompt: "x", persist: true }, { command: "codex", env: { CODEX_HOME: await temp() }, workspace: join(await temp(), "w"), spawnImpl: fakeSpawn(() => [started, command], [], { hang: true }) }))
      .rejects.toMatchObject({ code: "CLI_ERROR" });
  });

  it("maps unsupported models, usage limits and logouts to typed errors", async () => {
    const notFound = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.", code: "model_not_found" } });
    await expect(runCodexExec({ prompt: "x", model: "gpt-x", persist: true }, { command: "codex", env: { CODEX_HOME: await temp() }, workspace: join(await temp(), "w"),
      spawnImpl: fakeSpawn(() => [started, { type: "error", message: notFound }, { type: "turn.failed", error: { message: notFound } }], [], { exitCode: 1 }) }))
      .rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    const limited = parseCodexRateLimits(rateLimits(100));
    const error = classifyCodexFailure("You've hit your usage limit. Upgrade to Pro or try again at 8:05 PM.", limited, 1);
    expect(error).toMatchObject({ code: "SUBSCRIPTION_LIMIT_REACHED", details: { resetsAt: new Date(1_793_223_485_000).toISOString() } });
    expect(classifyCodexFailure("unexpected status 401 Unauthorized", undefined, 1).code).toBe("NOT_LOGGED_IN");
  });

  it("treats a used-up window or spend control as the limit", () => {
    expect(codexLimitReached(parseCodexRateLimits(rateLimits(40)))).toBe(false);
    expect(codexLimitReached(parseCodexRateLimits(rateLimits(100)))).toBe(true);
    expect(codexLimitReached(parseCodexRateLimits(rateLimits(10, { rate_limit_reached_type: "primary" })))).toBe(true);
  });

  it("cancels the process on abort", async () => {
    const controller = new AbortController();
    const pending = runCodexExec({ prompt: "hi", signal: controller.signal, persist: true }, { command: "codex", env: { CODEX_HOME: await temp() }, workspace: join(await temp(), "w"), spawnImpl: fakeSpawn(() => [started], [], { hang: true }) });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(CodexCliError);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("ChatGPT subscription service", () => {
  const models = async () => [{ slug: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", priority: 6 }, { slug: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", description: "Older fast and efficient model.", priority: 9 }];
  const reply = (request: { model?: string; prompt: string; resumeSessionId?: string }, sessionId: string, limits?: ReturnType<typeof parseCodexRateLimits>): CodexExecResult => ({
    text: `reply to ${request.prompt}`, sessionId: request.resumeSessionId ?? sessionId, model: request.model ?? "gpt-5.6-sol",
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, durationMs: 1, rateLimit: limits, warnings: []
  });

  it("lists default plus the live models and resumes each conversation with its own session", async () => {
    const dataDirectory = await temp();
    const calls: Array<{ model?: string; resumeSessionId?: string; persist?: boolean; prompt: string }> = [];
    let next = 0;
    const service = new ChatGptSubscriptionService({
      dataDirectory, listModels: models, authStatus: async () => subscriber,
      run: async request => { calls.push(request); return reply(request, `session-${++next}`); }
    });
    expect((await service.models()).map(model => model.alias)).toEqual(["default", "gpt-5.6-sol", "gpt-5.6-luna"]);
    await service.chat({ modelRef: "subscriptions/openai/gpt-5.6-luna", prompt: "a1", conversationId: "A" });
    await service.chat({ modelRef: "subscriptions/openai/default", prompt: "b1", conversationId: "B" });
    const switched = await service.chat({ modelRef: "subscriptions/openai/gpt-5.6-sol", prompt: "a2", conversationId: "A" });
    await service.chat({ modelRef: "subscriptions/openai/default", prompt: "once" });
    const [a1, b1, a2, once] = calls;
    expect(a1).toMatchObject({ model: "gpt-5.6-luna", resumeSessionId: undefined, persist: true });
    expect(b1).toMatchObject({ model: undefined, resumeSessionId: undefined });
    expect(a2).toMatchObject({ model: "gpt-5.6-sol", resumeSessionId: "session-1" });
    expect(once).toMatchObject({ persist: false, resumeSessionId: undefined });
    expect(switched).toMatchObject({ alias: "gpt-5.6-sol", sessionId: "session-1" });
    const saved = JSON.parse(await readFile(join(dataDirectory, "conversations.json"), "utf8")) as Array<{ id: string; turns: number; sessionId: string }>;
    expect(saved.find(item => item.id === "A")).toMatchObject({ turns: 2, sessionId: "session-1" });
    expect((await service.status()).usage24h.requests).toBe(4);
  });

  it("forgets a conversation together with its Codex session", async () => {
    const deleted: string[] = [];
    const service = new ChatGptSubscriptionService({ dataDirectory: await temp(), listModels: models, authStatus: async () => subscriber,
      run: async request => reply(request, "s-9"), deleteSession: async id => { deleted.push(id); return true; } });
    await service.chat({ modelRef: "subscriptions/openai/default", prompt: "x", conversationId: "C" });
    expect(await service.forgetConversation("C")).toBe(true);
    expect(deleted).toEqual(["s-9"]);
    expect(await service.listConversations()).toEqual([]);
  });

  it("blocks further calls once a plan window is used up, until it resets", async () => {
    let now = Date.parse("2026-10-28T10:00:00Z");
    const service = new ChatGptSubscriptionService({ dataDirectory: await temp(), now: () => now, listModels: models, authStatus: async () => subscriber,
      run: async request => reply(request, "s", parseCodexRateLimits(rateLimits(100))) });
    await service.chat({ modelRef: "subscriptions/openai/default", prompt: "x" });
    expect(service.quotaState()).toMatchObject({ exhausted: true, exhaustedUntil: new Date(1_793_223_485_000).toISOString() });
    await expect(service.chat({ modelRef: "subscriptions/openai/default", prompt: "y" })).rejects.toMatchObject({ code: "SUBSCRIPTION_LIMIT_REACHED" });
    now = 1_793_223_486_000;
    expect(service.quotaState().exhausted).toBe(false);
  });

  it("refuses an API-key login, unknown models and records limit failures", async () => {
    const apiKey: CodexAuthStatus = { ...subscriber, authMode: "api_key", subscription: false, reason: "api key" };
    const refused = new ChatGptSubscriptionService({ dataDirectory: await temp(), listModels: models, authStatus: async () => apiKey, run: async () => { throw new Error("must not run"); } });
    await expect(refused.chat({ modelRef: "subscriptions/openai/default", prompt: "x" })).rejects.toMatchObject({ code: "NOT_SUBSCRIPTION" });
    await expect(refused.chat({ modelRef: "subscriptions/openai/gpt-unknown", prompt: "x" })).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    const limited = new ChatGptSubscriptionService({ dataDirectory: await temp(), listModels: models, authStatus: async () => subscriber,
      run: async () => { throw new CodexCliError("SUBSCRIPTION_LIMIT_REACHED", "limit", { resetsAt: "2099-01-01T00:00:00.000Z" }); } });
    await expect(limited.chat({ modelRef: "subscriptions/openai/default", prompt: "x" })).rejects.toMatchObject({ code: "SUBSCRIPTION_LIMIT_REACHED" });
    expect(limited.quotaState()).toMatchObject({ exhausted: true, exhaustedUntil: "2099-01-01T00:00:00.000Z" });
    expect((await limited.status()).usage24h.limited).toBe(1);
  });

  it("puts ChatGPT subscription models in the subscription cost tier", () => {
    expect(modelCostTier("chatgpt_subscription", "subscriptions/openai/default", {}, undefined, ["text"])).toBe("subscription");
  });
});
