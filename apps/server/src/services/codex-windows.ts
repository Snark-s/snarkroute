import type { CodexRateLimitInfo } from "./codex-cli";

/** Codex reports a short (5-hour) and a long (weekly) window; name them by their length, not their slot. */
export function codexQuotaWindows(info: CodexRateLimitInfo): Array<{ id: string; label: string; usedPercent: number; resetsAt?: string }> {
  const named = (window: NonNullable<CodexRateLimitInfo["primary"]>, fallback: "five_hour" | "week") => {
    const minutes = window.windowMinutes;
    const id = minutes === undefined ? fallback : minutes <= 6 * 60 ? "five_hour" : minutes >= 6 * 1440 ? "week" : `h${Math.round(minutes / 60)}`;
    const label = id === "five_hour" ? "5 ч" : id === "week" ? "неделя" : `${Math.round((minutes ?? 0) / 60)} ч`;
    return { id, label, usedPercent: Math.max(0, Math.min(100, Math.round(window.usedPercent))), ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) };
  };
  return [info.primary ? named(info.primary, "five_hour") : undefined, info.secondary ? named(info.secondary, "week") : undefined].filter((item): item is NonNullable<typeof item> => Boolean(item));
}
