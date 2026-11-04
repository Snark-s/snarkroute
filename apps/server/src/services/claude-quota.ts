import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Live usage of the owner's Claude plan: the same two windows claude.ai shows (5-hour session and week).
 * Read-only: it uses the access token Claude Code keeps on this computer and only while that token is
 * still valid; it never refreshes or writes credentials (Claude Code does that itself on its next use).
 * The token is sent only to api.anthropic.com and is never logged or returned.
 */
export type ClaudeUsageWindow = { usedPercent: number; resetsAt?: string };
export type ClaudeUsage = { fiveHour?: ClaudeUsageWindow; sevenDay?: ClaudeUsageWindow; sevenDayOpus?: ClaudeUsageWindow };

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function window(value: unknown): ClaudeUsageWindow | undefined {
  const raw = value as { utilization?: unknown; resets_at?: unknown } | null | undefined;
  if (!raw || typeof raw.utilization !== "number" || !Number.isFinite(raw.utilization)) return undefined;
  const used = raw.utilization <= 1 && raw.utilization > 0 && !Number.isInteger(raw.utilization) ? raw.utilization * 100 : raw.utilization;
  return { usedPercent: Math.max(0, Math.min(100, Math.round(used))), ...(typeof raw.resets_at === "string" && Number.isFinite(Date.parse(raw.resets_at)) ? { resetsAt: new Date(raw.resets_at).toISOString() } : {}) };
}

export function parseClaudeUsage(body: unknown): ClaudeUsage | undefined {
  const data = body as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return undefined;
  const usage: ClaudeUsage = { fiveHour: window(data.five_hour), sevenDay: window(data.seven_day), sevenDayOpus: window(data.seven_day_opus) };
  return usage.fiveHour || usage.sevenDay ? usage : undefined;
}

export async function readClaudeUsage(options: { home?: string; fetchImpl?: typeof fetch; now?: number } = {}): Promise<ClaudeUsage | undefined> {
  let token: string | undefined;
  try {
    const credentials = JSON.parse(await readFile(join(options.home ?? homedir(), ".claude", ".credentials.json"), "utf8")) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
    const oauth = credentials.claudeAiOauth;
    // An expired token would need a refresh, which is Claude Code's job: report nothing instead.
    if (typeof oauth?.accessToken !== "string" || typeof oauth.expiresAt !== "number" || oauth.expiresAt <= (options.now ?? Date.now()) + 60_000) return undefined;
    token = oauth.accessToken;
  } catch { return undefined; }
  try {
    const response = await (options.fetchImpl ?? fetch)(USAGE_URL, { headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return undefined;
    return parseClaudeUsage(await response.json());
  } catch { return undefined; }
}

/** The ledger keeps one number: the busiest window decides availability; both are named in the detail. */
export function claudeUsageReport(usage: ClaudeUsage): { usedPercent: number; resetsAt?: string; exhausted: boolean; detail: string; windows: Array<{ id: string; label: string; usedPercent: number; resetsAt?: string }> } {
  const present: Array<{ id: string; label: string; item: ClaudeUsageWindow }> = [];
  if (usage.fiveHour) present.push({ id: "five_hour", label: "5 ч", item: usage.fiveHour });
  if (usage.sevenDay) present.push({ id: "week", label: "неделя", item: usage.sevenDay });
  const windows = present.map(entry => ({ id: entry.id, label: entry.label, usedPercent: entry.item.usedPercent, ...(entry.item.resetsAt ? { resetsAt: entry.item.resetsAt } : {}) }));
  if (!present.length) return { usedPercent: 0, exhausted: false, detail: "", windows };
  const busiest = present.reduce((a, b) => (b.item.usedPercent > a.item.usedPercent ? b : a));
  const exhausted = present.filter(entry => entry.item.usedPercent >= 100);
  // When a window is used up, the plan is back only after the latest of the exhausted windows resets.
  const resetsAt = exhausted.length ? exhausted.map(entry => entry.item.resetsAt).filter((at): at is string => Boolean(at)).sort().at(-1) : busiest.item.resetsAt;
  return { usedPercent: busiest.item.usedPercent, ...(resetsAt ? { resetsAt } : {}), exhausted: exhausted.length > 0, detail: present.map(entry => `${entry.label}: ${entry.item.usedPercent}%`).join(" · "), windows };
}

/** A rate_limit_event from a Claude Code run names its window; it refreshes that one window only. */
export function claudeEventWindow(rateLimitType: string | undefined, utilization: number | undefined, resetsAt: string | undefined): { id: string; label: string; usedPercent: number; resetsAt?: string } | undefined {
  if (utilization === undefined || !Number.isFinite(utilization)) return undefined;
  const id = rateLimitType === "five_hour" ? "five_hour" : rateLimitType === "seven_day" ? "week" : undefined;
  if (!id) return undefined;
  const used = Math.round(utilization <= 1 ? utilization * 100 : utilization);
  return { id, label: id === "five_hour" ? "5 ч" : "неделя", usedPercent: Math.max(0, Math.min(100, used)), ...(resetsAt ? { resetsAt } : {}) };
}
