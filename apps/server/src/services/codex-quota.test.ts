import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readCodexQuota, parseAppServerQuota } from "./codex-quota";
import { ChatGptSubscriptionService } from "./chatgpt-subscription";
import { QuotaLedger } from "../agent-ops/quota-ledger";

function rpc(accountType = "chatgpt", hang = false) {
  const calls: any[] = [];
  let killed = false, ended = false;
  const spawnImpl = ((command: string, args: string[], options: any) => {
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { killed = true; return true; };
    child.stdin.on("finish", () => { ended = true; child.emit("close", 0); });
    child.stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()); calls.push({ command, args, options, request });
      if (hang || request.id === undefined) return;
      const result = request.method === "initialize" ? { userAgent: "test" }
        : request.method === "account/read" ? { account: { type: accountType, email: "private@example.test", planType: "pro" } }
        : { rateLimitsByLimitId: { codex: { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1793350000 }, secondary: { usedPercent: 76, windowDurationMins: 10080, resetsAt: 1793790000 } } } };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
    });
    return child;
  }) as any;
  return { spawnImpl, calls, cleaned: () => killed || ended };
}

describe("read-only Codex subscription quota", () => {
  it("handshakes, verifies ChatGPT and reads limits without a model turn or credentials", async () => {
    const fake = rpc();
    const result = await readCodexQuota({ command: "codex", spawnImpl: fake.spawnImpl, env: { OPENAI_API_KEY: "secret", CODEX_HOME: "fixture" } });
    expect(fake.calls.map(c => c.request.method)).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read"]);
    expect(fake.calls[0].options).toMatchObject({ windowsHide: true, env: { CODEX_HOME: "fixture" } });
    expect(fake.calls[0].options.env.OPENAI_API_KEY).toBeUndefined();
    expect(fake.calls[0].args).toContain('forced_login_method="chatgpt"');
    expect(result).toMatchObject({ planType: "pro", primary: { usedPercent: 7, windowMinutes: 300 }, secondary: { usedPercent: 76 } });
    expect(JSON.stringify(result)).not.toContain("private@example.test");
    await new Promise(setImmediate);
    expect(fake.cleaned()).toBe(true);
  });
  it("does not request subscription limits for API-key authentication", async () => {
    const fake = rpc("apiKey");
    await expect(readCodexQuota({ command: "codex", spawnImpl: fake.spawnImpl })).rejects.toMatchObject({ code: "NOT_SUBSCRIPTION" });
    expect(fake.calls.some(c => c.request.method === "account/rateLimits/read")).toBe(false);
    await new Promise(setImmediate);
    expect(fake.cleaned()).toBe(true);
  });
  it("times out and stops only its helper", async () => {
    const fake = rpc("chatgpt", true);
    await expect(readCodexQuota({ command: "codex", spawnImpl: fake.spawnImpl, timeoutMs: 10 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(fake.cleaned()).toBe(true);
  });
  it("does not turn missing or another bucket's data into zero usage", () => {
    expect(parseAppServerQuota({ rateLimitsByLimitId: { other: { primary: { usedPercent: 0 } } }, rateLimits: { primary: { usedPercent: 3 } } })).toBeUndefined();
    expect(parseAppServerQuota({ rateLimits: { primary: { usedPercent: null } } })).toBeUndefined();
    expect(parseAppServerQuota({ rateLimits: { primary: { usedPercent: 100 }, rateLimitReachedType: "usageLimit" } })).toMatchObject({ primary: { usedPercent: 100 }, reachedType: "usageLimit" });
  });
  it("shares concurrent refreshes and retries after cache expiry, including failed reads", async () => {
    let now = 1000;
    const readQuota = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(parseAppServerQuota({ rateLimits: { primary: { usedPercent: 4 } } }));
    const service = new ChatGptSubscriptionService({ now: () => now, readQuota });
    await Promise.all([service.refreshQuota(), service.refreshQuota()]);
    expect(readQuota).toHaveBeenCalledTimes(1);
    expect(service.quotaState().lastRateLimit).toBeUndefined();
    now += 60001;
    await Promise.all([service.refreshQuota(), service.refreshQuota()]);
    expect(readQuota).toHaveBeenCalledTimes(2);
    expect(service.quotaState().lastRateLimit?.primary?.usedPercent).toBe(4);
  });
  it("clears an old provider-limit wait only after a fresh provider report", () => {
    const ledger = new QuotaLedger({ now: () => 1000 });
    ledger.recordQuotaReport("codex_cli", { exhausted: true, resetsAt: new Date(1000000).toISOString(), source: "provider" });
    expect(ledger.availability("codex_cli", "subscription").usable).toBe(false);
    ledger.recordQuotaReport("codex_cli", { usedPercent: 10, source: "provider live" });
    expect(ledger.availability("codex_cli", "subscription").usable).toBe(true);
  });
});
