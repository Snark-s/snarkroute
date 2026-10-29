import { createHash } from "node:crypto";
import type { AcceptanceDecision, AcceptanceState, TaskSpec } from "./types";

/**
 * Acceptance of a delegated task: machine checks first, then a model reviewer
 * for the original criteria. The reviewer may only point at criteria of the
 * task itself; anything else it "wants" is ignored. Reworks are bounded by
 * count, budget, progress and repetition of the same failure.
 */

export type ReviewInput = {
  taskId: string;
  goal: string;
  criteria: string[];
  executorSummary: string;
  evidence: { changedFiles: string[]; checks: Array<{ check: string; ok: boolean; detail: string }>; diff: string; artifact?: string };
  history: Array<{ attempt: number; decision: string; unmet: string[]; reason: string }>;
  budget: { reworksLeft: number; wallMinutesLeft: number; subscriptionRunsLeft: number };
  executor?: string;
};

export type ReviewVerdict =
  | { status: "ok"; decision: "accept" | "rework" | "blocked" | "owner_action"; unmet: number[]; reason: string; ownerAction?: string; reviewer: { provider: string; model: string } }
  | { status: "unavailable"; reason: string };

export type Reviewer = (input: ReviewInput) => Promise<ReviewVerdict>;

export const DEFAULT_MAX_REWORKS = 3;
export const MAX_REWORKS_CAP = 5;

/** Criterion 0 is the goal itself; the rest are the submitted acceptance criteria, verbatim. */
export function criteriaOf(spec: TaskSpec): string[] {
  return [`The goal is achieved: ${spec.goal.slice(0, 600)}`, ...(spec.acceptance ?? [])];
}

export function newAcceptanceState(spec: TaskSpec): AcceptanceState {
  return { reworks: 0, maxReworks: Math.max(0, Math.min(MAX_REWORKS_CAP, spec.budget?.maxReworks ?? DEFAULT_MAX_REWORKS)), reviews: 0, decisions: [] };
}

export function reviewPrompt(input: ReviewInput): string {
  const section = (title: string, body: string) => `\n## ${title}\n${body.trim() || "(none)"}\n`;
  return [
    "You are the acceptance reviewer for a delegated task in SnarkRoute.",
    "Decide only whether the ORIGINAL goal and the listed criteria are met, judging by the evidence.",
    "Rules: do not add requirements that are not in the criteria; the executor's own claims are not evidence;",
    "machine checks that passed are strong evidence; if a criterion cannot be judged from the evidence and nothing contradicts it, do not fail it for style or taste.",
    "Use \"owner_action\" only when continuing truly requires the owner (credentials, payment, a decision only they can make); use \"blocked\" when the task cannot be completed as specified.",
    section("Task goal", input.goal),
    section("Criteria (refer to them by number)", input.criteria.map((criterion, index) => `${index}. ${criterion}`).join("\n")),
    section("Machine checks run by SnarkRoute", input.evidence.checks.map(check => `- ${check.ok ? "PASS" : "FAIL"} ${check.check}: ${check.detail.split(/\r?\n/).slice(0, 3).join(" ")}`).join("\n")),
    section("Changed files", input.evidence.changedFiles.slice(0, 60).join("\n")),
    section("Diff / file excerpts", input.evidence.diff.slice(0, 14_000)),
    input.evidence.artifact ? section("Result text produced by the executor", input.evidence.artifact.slice(0, 8000)) : "",
    section("Executor's summary (a claim, not proof)", input.executorSummary.slice(0, 3000)),
    section("Previous acceptance decisions", input.history.map(item => `- attempt ${item.attempt}: ${item.decision}${item.unmet.length ? ` — unmet: ${item.unmet.join("; ")}` : ""}${item.reason ? ` (${item.reason})` : ""}`).join("\n")),
    "\nReply with one JSON object only, no prose:",
    '{"decision":"accept|rework|blocked|owner_action","unmet":[criterion numbers that are not met],"reason":"one or two sentences","owner_action":"only for owner_action"}'
  ].join("\n");
}

export function parseReviewReply(text: string, criteriaCount: number): { decision: "accept" | "rework" | "blocked" | "owner_action"; unmet: number[]; reason: string; ownerAction?: string } | undefined {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return undefined;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[0]) as Record<string, unknown>; } catch { return undefined; }
  const decision = typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
  if (!["accept", "rework", "blocked", "owner_action"].includes(decision)) return undefined;
  // Only numbers of real criteria survive; invented requirements have no number to point at.
  const unmet = (Array.isArray(parsed.unmet) ? parsed.unmet : []).map(Number).filter(value => Number.isInteger(value) && value >= 0 && value < criteriaCount);
  return { decision: decision as "accept" | "rework" | "blocked" | "owner_action", unmet: [...new Set(unmet)], reason: String(parsed.reason ?? "").slice(0, 600),
    ...(typeof parsed.owner_action === "string" && parsed.owner_action.trim() ? { ownerAction: parsed.owner_action.slice(0, 600) } : {}) };
}

export function unmetSignature(unmet: string[]): string {
  return createHash("sha256").update([...unmet].map(item => item.replace(/\d+(\.\d+)?\s*(ms|s)\b/g, "").trim()).sort().join("\n")).digest("hex").slice(0, 16);
}

/** May the task go back for one more rework? Stops endless "continue" loops. */
export function reworkGate(state: AcceptanceState, signature: string, lastAttemptChangedFiles: boolean, budget: { wallMinutesLeft: number; subscriptionRunsLeft: number; needsSubscription: boolean }):
  { allowed: true } | { allowed: false; reason: string } {
  if (state.reworks >= state.maxReworks) return { allowed: false, reason: `Лимит доработок исчерпан (${state.reworks} из ${state.maxReworks}).` };
  const reworks = state.decisions.filter((decision: AcceptanceDecision) => decision.decision === "rework");
  const previous = reworks.at(-1);
  if (previous && previous.signature === signature && !lastAttemptChangedFiles) return { allowed: false, reason: "Нет прогресса: доработка не изменила файлов, невыполненные критерии те же." };
  if (reworks.length >= 2 && reworks.slice(-2).every(decision => decision.signature === signature)) return { allowed: false, reason: "Одна и та же ошибка повторяется третий раз подряд." };
  if (budget.wallMinutesLeft <= 0) return { allowed: false, reason: "Бюджет времени цепочки исчерпан." };
  if (budget.needsSubscription && budget.subscriptionRunsLeft <= 0) return { allowed: false, reason: "Бюджет подписочных запусков цепочки исчерпан." };
  return { allowed: true };
}
