import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { claudeEventWindow, claudeUsageReport, parseClaudeUsage, readClaudeUsage } from "./claude-quota";
import { codexQuotaWindows } from "./codex-windows";
import { mergeQuotaWindows } from "../agent-ops/quota-ledger";

describe("Claude plan usage (5-hour and weekly windows)", () => {
  const dirs: string[] = [];
  afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  async function home(expiresAt: number) {
    const dir = await mkdtemp(join(tmpdir(), "claude-quota-")); dirs.push(dir);
    await mkdir(join(dir, ".claude"));
    await writeFile(join(dir, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test-token", expiresAt } }));
    return dir;
  }

  it("reads both windows and lets the used-up one decide", () => {
    const usage = parseClaudeUsage({ five_hour: { utilization: 100, resets_at: "2026-11-04T14:20:00Z" }, seven_day: { utilization: 77, resets_at: "2026-11-10T05:00:00Z" } })!;
    expect(claudeUsageReport(usage)).toMatchObject({ usedPercent: 100, resetsAt: "2026-11-04T14:20:00.000Z", exhausted: true, detail: "5 ч: 100% · неделя: 77%",
      windows: [{ id: "five_hour", usedPercent: 100 }, { id: "week", usedPercent: 77, resetsAt: "2026-11-10T05:00:00.000Z" }] });
    expect(claudeUsageReport(parseClaudeUsage({ five_hour: { utilization: 12 }, seven_day: { utilization: 40, resets_at: "2026-11-10T05:00:00Z" } })!))
      .toMatchObject({ usedPercent: 40, exhausted: false, resetsAt: "2026-11-10T05:00:00.000Z" });
    expect(parseClaudeUsage({ error: "x" })).toBeUndefined();
  });

  it("names Codex windows by length and keeps a window a later report did not mention", () => {
    expect(codexQuotaWindows({ primary: { usedPercent: 1, windowMinutes: 300, resetsAt: "2026-11-04T16:00:00Z" }, secondary: { usedPercent: 0, windowMinutes: 10080 } } as never))
      .toEqual([{ id: "five_hour", label: "5 ч", usedPercent: 1, resetsAt: "2026-11-04T16:00:00Z" }, { id: "week", label: "неделя", usedPercent: 0 }]);
    const first = mergeQuotaWindows(undefined, [{ id: "week", label: "неделя", usedPercent: 77 }, { id: "five_hour", label: "5 ч", usedPercent: 100 }], "2026-11-04T14:00:00.000Z")!;
    expect(first.map(window => window.id)).toEqual(["five_hour", "week"]);
    const next = mergeQuotaWindows(first, [claudeEventWindow("five_hour", 0.2, undefined)!], "2026-11-04T15:00:00.000Z")!;
    expect(next).toMatchObject([{ id: "five_hour", usedPercent: 20, observedAt: "2026-11-04T15:00:00.000Z" }, { id: "week", usedPercent: 77, observedAt: "2026-11-04T14:00:00.000Z" }]);
    expect(mergeQuotaWindows(first, undefined, "x")).toBe(first);
  });

  it("asks the usage endpoint only with a valid token and never refreshes it", async () => {
    const now = Date.parse("2026-11-04T14:00:00Z");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 5 }, seven_day: { utilization: 70 } })));
    expect(await readClaudeUsage({ home: await home(now + 3_600_000), now, fetchImpl: fetchImpl as never })).toMatchObject({ fiveHour: { usedPercent: 5 }, sevenDay: { usedPercent: 70 } });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: "Bearer test-token" });
    expect(await readClaudeUsage({ home: await home(now - 1000), now, fetchImpl: fetchImpl as never })).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const denied = vi.fn(async () => new Response("{}", { status: 401 }));
    expect(await readClaudeUsage({ home: await home(now + 3_600_000), now, fetchImpl: denied as never })).toBeUndefined();
  });
});
