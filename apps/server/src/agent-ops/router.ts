import type { ExecutorAdapter, ExecutorProbe } from "./executors";
import type { AgentPolicy, TaskSpec } from "./types";

/**
 * Chooses who should do a task, not whether it may start now (the dispatcher
 * decides that). Suitability is a hard filter: a free local model is never
 * chosen for work it cannot do, and an explicitly preferred executor that does
 * not fit is reported, not silently replaced.
 */

export type RouteCandidate = { executorId: string; label: string; suitable: boolean; reasons: string[]; tier: "local" | "subscription"; installed: boolean; authenticated: boolean | null };

export type RoutingInput = { spec: TaskSpec; policy: AgentPolicy; adapters: ExecutorAdapter[]; probes: Map<string, ExecutorProbe> };

export function inferTaskKind(spec: TaskSpec): NonNullable<NonNullable<TaskSpec["requirements"]>["kind"]> {
  if (spec.requirements?.kind) return spec.requirements.kind;
  if (spec.checks?.some(check => check.type === "command") || spec.workspace && spec.permissions?.fileWrite !== false) return "code_edit";
  if (/\b(review|audit)\b|ревью|проверь код/i.test(spec.goal)) return "code_review";
  if (spec.workspace) return "analysis";
  return "text";
}

const qualityRank = { basic: 0, normal: 1, high: 2 } as const;

export function rankExecutors(input: RoutingInput): RouteCandidate[] {
  const kind = inferTaskKind(input.spec);
  const quality = input.spec.requirements?.quality ?? (kind === "code_edit" || kind === "code_review" ? "high" : "normal");
  const context = input.spec.requirements?.contextTokens ?? estimateTokens(input.spec);
  const needsEdits = kind === "code_edit" && input.spec.permissions?.fileWrite !== false;
  const allowed = new Set(input.spec.allowedExecutors?.length ? input.spec.allowedExecutors.filter(id => input.policy.allowedExecutors.includes(id)) : input.policy.allowedExecutors);
  const preferred = input.spec.executor && input.spec.executor !== "auto" ? input.spec.executor : undefined;

  const candidates = input.adapters.map(adapter => {
    const probe = input.probes.get(adapter.id);
    const reasons: string[] = [];
    let suitable = true;
    if (!allowed.has(adapter.id)) { suitable = false; reasons.push("не разрешён политикой агента или поручения"); }
    if (!adapter.profile.kinds.includes(kind)) { suitable = false; reasons.push(`не выполняет задачи типа ${kind}`); }
    if (needsEdits && !adapter.profile.editsFiles) { suitable = false; reasons.push("не умеет менять файлы"); }
    if (input.spec.checks?.some(check => check.type !== "command") && !adapter.profile.editsFiles && input.spec.workspace) { suitable = false; reasons.push("проверки требуют файлов в рабочей папке"); }
    if (context > adapter.profile.maxContextTokens) { suitable = false; reasons.push(`контекст ~${context} токенов больше ${adapter.profile.maxContextTokens}`); }
    if (qualityRank[quality] > qualityRank[adapter.profile.quality]) { suitable = false; reasons.push(`качество ${adapter.profile.quality} ниже требуемого ${quality}`); }
    if (suitable) reasons.push(adapter.profile.costTier === "local" ? "подходит, локально и бесплатно" : "подходит, по подписке без доплат");
    return { executorId: adapter.id, label: adapter.label, suitable, reasons, tier: adapter.profile.costTier, order: adapter.profile.order,
      installed: probe?.installed ?? false, authenticated: probe?.authenticated ?? null };
  });

  return candidates
    .sort((a, b) => Number(b.suitable) - Number(a.suitable)
      || Number(b.executorId === preferred) - Number(a.executorId === preferred)
      || (a.tier === b.tier ? 0 : a.tier === "local" ? -1 : 1)
      || Number(b.installed && b.authenticated !== false) - Number(a.installed && a.authenticated !== false)
      || a.order - b.order)
    .map(({ order: _order, ...candidate }) => candidate);
}

/** Rough size of the task text; agents pass requirements.contextTokens for large inputs. */
export function estimateTokens(spec: TaskSpec): number {
  const text = [spec.goal, ...(spec.acceptance ?? []), ...(spec.constraints ?? []), ...(spec.inputs ?? [])].join("\n");
  return Math.ceil(text.length / 3);
}
