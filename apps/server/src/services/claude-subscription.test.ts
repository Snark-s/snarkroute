import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { claudeCliEnv, claudeCodeArgs, ClaudeCliError, interpretAuthStatus, runClaudeCode, type ClaudeAuthStatus } from "./claude-code-cli";
import { ClaudeSubscriptionService } from "./claude-subscription";
import { modelCostTier } from "./model-routing-policy";
import { promptFromParams } from "../providers/claude-subscription";

type Call = { command: string; args: string[]; env: NodeJS.ProcessEnv; stdin: string };

function fakeSpawn(lines: (call: Call) => unknown[], calls: Call[] = [], options: { hang?: boolean } = {}) {
  return ((command: string, args: string[], spawnOptions: { env: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; kill: () => boolean };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    const call: Call = { command, args, env: spawnOptions.env, stdin: "" };
    calls.push(call);
    const finish = (code: number | null) => { if (child.exitCode !== null) return; child.exitCode = code ?? 1; child.stdout.end(); setImmediate(() => child.emit("close", code)); };
    child.kill = () => { finish(null); return true; };
    child.stdin.on("data", chunk => { call.stdin += String(chunk); });
    child.stdin.on("finish", () => {
      for (const line of lines(call)) child.stdout.write(`${JSON.stringify(line)}\n`);
      if (!options.hang) finish(0);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

const init = (extra: Record<string, unknown> = {}) => ({ type: "system", subtype: "init", session_id: "s-1", model: "claude-sonnet-5", apiKeySource: "none", ...extra });
const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const result = (text: string, extra: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", is_error: false, result: text, session_id: "s-1", total_cost_usd: 0.0123, num_turns: 1, usage: { input_tokens: 10, output_tokens: 3 }, ...extra });
const subscriber: ClaudeAuthStatus = { installed: true, command: "claude", loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", subscription: true, checkedAt: "" };

async function workspace() { return mkdtemp(join(tmpdir(), "claude-sub-")); }

describe("Claude Code CLI transport", () => {
  it("runs plain text generation without tools, MCP, settings or skills", () => {
    const args = claudeCodeArgs({ model: "opus" }, "sys.txt");
    expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--include-partial-messages", "--model", "opus", "--tools", "", "--strict-mcp-config", "--setting-sources", "--disable-slash-commands", "--no-session-persistence"]));
    expect(claudeCodeArgs({ model: "opus", resumeSessionId: "abc" }, "sys.txt")).toEqual(expect.arrayContaining(["--resume", "abc"]));
    expect(claudeCodeArgs({ model: "opus", sessionId: "new" }, "sys.txt")).toEqual(expect.arrayContaining(["--session-id", "new"]));
  });

  it("strips API keys and host session variables from the child environment", () => {
    const env = claudeCliEnv({ PATH: "p", ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: "http://x", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "c" });
    expect(env).toMatchObject({ PATH: "p", CLAUDE_CONFIG_DIR: "c" });
    expect(Object.keys(env).filter(key => key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE")).toEqual([]);
  });

  it("accepts only a first-party subscription login", () => {
    const base = { command: "claude", checkedAt: "" };
    expect(interpretAuthStatus({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }, base).subscription).toBe(true);
    expect(interpretAuthStatus({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }, base).subscription).toBe(false);
    expect(interpretAuthStatus({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }, base).subscription).toBe(false);
    expect(interpretAuthStatus({ loggedIn: false, authMethod: "none" }, base).reason).toContain("claude auth login");
  });

  it("streams deltas, sends the prompt on stdin and reports API-equivalent cost separately", async () => {
    const calls: Call[] = [];
    const deltas: string[] = [];
    const out = await runClaudeCode({ model: "sonnet", prompt: "hi", systemPrompt: "be brief", onEvent: event => { if (event.type === "delta") deltas.push(event.text); } },
      { workspace: await workspace(), spawnImpl: fakeSpawn(() => [init(), delta("Hel"), delta("lo"), result("Hello")], calls) });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(out).toMatchObject({ text: "Hello", sessionId: "s-1", model: "claude-sonnet-5", apiEquivalentCostUsd: 0.0123, usage: { inputTokens: 10, outputTokens: 3 } });
    expect(calls[0].stdin).toBe("hi");
    expect(calls[0].args).not.toContain("hi");
  });

  it("stops before inference when Claude Code would use an API key", async () => {
    await expect(runClaudeCode({ model: "sonnet", prompt: "hi" }, { workspace: await workspace(), spawnImpl: fakeSpawn(() => [init({ apiKeySource: "ANTHROPIC_API_KEY" })], [], { hang: true }) }))
      .rejects.toMatchObject({ code: "NOT_SUBSCRIPTION" });
  });

  it("maps authentication and usage-limit failures to typed errors", async () => {
    const authError = { type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } };
    await expect(runClaudeCode({ model: "sonnet", prompt: "hi" }, { workspace: await workspace(), spawnImpl: fakeSpawn(() => [init(), authError, result("", { is_error: true })]) }))
      .rejects.toMatchObject({ code: "NOT_LOGGED_IN" });
    const limit = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_900_000_000, rateLimitType: "five_hour" } };
    const limitError = { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "Claude usage limit reached" }] } };
    await expect(runClaudeCode({ model: "sonnet", prompt: "hi" }, { workspace: await workspace(), spawnImpl: fakeSpawn(() => [init(), limit, limitError, result("", { is_error: true })]) }))
      .rejects.toMatchObject({ code: "SUBSCRIPTION_LIMIT_REACHED", details: { resetsAt: new Date(1_900_000_000_000).toISOString() } });
  });

  it("cancels the process on abort", async () => {
    const controller = new AbortController();
    const pending = runClaudeCode({ model: "sonnet", prompt: "hi", signal: controller.signal }, { workspace: await workspace(), spawnImpl: fakeSpawn(() => [init()], [], { hang: true }) });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(ClaudeCliError);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("Claude subscription service", () => {
  it("keeps conversations apart and resumes each with its own session", async () => {
    const dataDirectory = await workspace();
    const calls: Array<{ model: string; sessionId?: string; resumeSessionId?: string; prompt: string }> = [];
    const service = new ClaudeSubscriptionService({
      dataDirectory,
      authStatus: async () => subscriber,
      run: async request => {
        calls.push({ model: request.model, sessionId: request.sessionId, resumeSessionId: request.resumeSessionId, prompt: request.prompt });
        const sessionId = request.resumeSessionId ?? request.sessionId ?? "one-shot";
        return { text: `reply to ${request.prompt}`, sessionId, model: `resolved-${request.model}`, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, durationMs: 1 };
      }
    });
    await service.chat({ modelRef: "subscriptions/anthropic/sonnet", prompt: "a1", conversationId: "A" });
    await service.chat({ modelRef: "subscriptions/anthropic/haiku", prompt: "b1", conversationId: "B" });
    await service.chat({ modelRef: "subscriptions/anthropic/opus", prompt: "a2", conversationId: "A" });
    const [a1, b1, a2] = calls;
    expect(a1.sessionId).toBeTruthy();
    expect(b1.sessionId).toBeTruthy();
    expect(b1.sessionId).not.toBe(a1.sessionId);
    expect(a2).toMatchObject({ resumeSessionId: a1.sessionId, model: "opus" });
    const saved = JSON.parse(await readFile(join(dataDirectory, "conversations.json"), "utf8")) as Array<{ id: string; turns: number }>;
    expect(saved.find(item => item.id === "A")?.turns).toBe(2);
    expect((await service.status()).usage24h.requests).toBe(3);
  });

  it("blocks further calls until the quota resets and refuses unknown aliases", async () => {
    let now = Date.parse("2026-10-28T10:00:00Z");
    const service = new ClaudeSubscriptionService({
      dataDirectory: await workspace(), now: () => now, authStatus: async () => subscriber,
      run: async () => { throw new ClaudeCliError("SUBSCRIPTION_LIMIT_REACHED", "limit", { resetsAt: "2026-10-28T12:00:00.000Z" }); }
    });
    await expect(service.chat({ modelRef: "subscriptions/anthropic/sonnet", prompt: "x" })).rejects.toMatchObject({ code: "SUBSCRIPTION_LIMIT_REACHED" });
    expect(service.quotaState()).toMatchObject({ exhausted: true, exhaustedUntil: "2026-10-28T12:00:00.000Z" });
    now = Date.parse("2026-10-28T12:00:01Z");
    expect(service.quotaState().exhausted).toBe(false);
    await expect(service.chat({ modelRef: "subscriptions/anthropic/unknown", prompt: "x" })).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
  });
});

describe("routing integration", () => {
  it("puts subscription models in their own cost tier", () => {
    expect(modelCostTier("claude_subscription", "subscriptions/anthropic/opus", {}, undefined, ["text"])).toBe("subscription");
  });

  it("sends only the newest turn inside a persisted conversation", () => {
    const messages = [{ role: "system", content: "S" }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "user", content: "u2" }];
    expect(promptFromParams({ messages }, {}, true)).toEqual({ systemPrompt: "S", prompt: "u2" });
    expect(promptFromParams({ messages }, {}, false).prompt).toContain("<assistant>\na1\n</assistant>");
  });
});
