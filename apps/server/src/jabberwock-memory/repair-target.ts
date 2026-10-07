import { createHash } from "node:crypto";
import { z } from "zod";

const argumentIndex = z.number().int().min(0).max(99);
const primitive = z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]);
export const callArgumentSchema = z.union([
  z.object({ index: argumentIndex, equals: primitive }).strict(),
  z.object({ index: argumentIndex, stringContains: z.string().min(1).max(2_000) }).strict()
]);
const callScopeSchema = z.object({ callee: z.string().min(1).max(200), callbackArgument: argumentIndex,
  arguments: z.array(callArgumentSchema).max(20).optional() }).strict();
export const callPredicateSchema = z.object({ callee: z.string().min(1).max(200), minCount: z.number().int().min(1).max(100).optional(),
  arguments: z.array(callArgumentSchema).max(20).optional(), within: callScopeSchema.optional(), topLevel: z.literal(true).optional() }).strict()
  .refine(value => !(value.topLevel && value.within), { message: "A call cannot be both module-level and inside a callback" });
export type CallPredicate = z.infer<typeof callPredicateSchema>;
export type CallArgument = z.infer<typeof callArgumentSchema>;
const expectedConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("call_count"), callee: z.string(), min: z.number().int().min(1), arguments: z.array(callArgumentSchema).optional(), within: callScopeSchema.optional(), topLevel: z.literal(true).optional() }),
  z.object({ type: z.literal("syntax_errors"), max: z.literal(0) }),
  z.object({ type: z.literal("declaration_count"), symbol: z.string(), equals: z.literal(1) }),
  z.object({ type: z.literal("literal_presence"), literal: z.string() }),
  z.object({ type: z.literal("process_receipt"), script: z.string(), exitCode: z.literal(0) })
]);
export const repairTargetSchema = z.object({
  id: z.string().max(100), kind: z.enum(["source_syntax", "symbol_count", "missing_call", "call_predicate", "missing_literal", "process_receipt"]),
  path: z.string().max(500).optional(), subject: z.string().min(1).max(2_000), failure: z.string().min(1).max(2_000),
  criterionReference: z.string().max(500), observedCount: z.number().int().min(0).optional(), expectedCount: z.number().int().min(0).optional(),
  // Optional only for reading historical metadata. New policy-produced targets always carry the contract.
  expectedCondition: expectedConditionSchema.optional(),
  actualEvidence: z.object({ sourceHash: z.string().optional(), observedCount: z.number().int().min(0), totalCount: z.number().int().min(0).optional(), details: z.array(z.string()) }).optional(),
  semanticAnchor: z.union([callScopeSchema, z.object({ callee: z.string(), topLevel: z.literal(true).optional() }).strict()]).optional(),
  repairability: z.enum(["auto", "evidence_only"]).optional(),
  supportingFailures: z.array(z.object({ argumentIndex, location: z.enum(["call", "anchor"]).optional(), expectedCondition: z.union([z.object({ equals: primitive }).strict(), z.object({ stringContains: z.string() }).strict()]), failure: z.string() })).optional()
});
export type RepairTarget = z.infer<typeof repairTargetSchema>;
export type RepairAttempt = { repairTarget: RepairTarget; verificationRunId: string; failedCriterion: string; targetAttemptNumber: number };
export function makeRepairTarget(stepIndex: number, target: Omit<RepairTarget, "id">): RepairTarget {
  const expectedCondition = target.expectedCondition ?? (target.kind === "source_syntax" ? { type: "syntax_errors" as const, max: 0 as const }
    : target.kind === "symbol_count" ? { type: "declaration_count" as const, symbol: target.subject, equals: 1 as const }
    : target.kind === "missing_call" ? { type: "call_count" as const, callee: target.subject, min: 1 }
    : target.kind === "missing_literal" ? { type: "literal_presence" as const, literal: target.subject }
    : target.kind === "process_receipt" ? { type: "process_receipt" as const, script: target.subject, exitCode: 0 as const } : undefined);
  const identity = [stepIndex, target.kind, target.path ?? "", target.subject];
  if (target.kind === "call_predicate") identity.push(JSON.stringify(expectedCondition));
  return { ...target, expectedCondition, actualEvidence: target.actualEvidence ?? { observedCount: target.observedCount ?? 0, details: [target.failure] },
    repairability: target.kind === "missing_literal" ? "evidence_only" : expectedCondition ? "auto" : "evidence_only",
    id: `repair_${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 20)}` };
}
/** Policy order breaks ties. Process work waits until all inspected source prerequisites pass. */
export function selectRepairTarget(targets: RepairTarget[]): RepairTarget | undefined {
  const source = targets.filter(target => target.kind !== "process_receipt");
  const rank = (target: RepairTarget) => ({ source_syntax: 0, symbol_count: 1, missing_call: 2, call_predicate: target.expectedCondition?.type === "call_count" && target.expectedCondition.within ? 3 : 2, missing_literal: 4, process_receipt: 5 })[target.kind];
  return (source.length ? source : targets).map((target, index) => ({ target, index }))
    .filter(({ target }) => target.repairability === "auto" && target.expectedCondition && target.actualEvidence)
    .sort((a, b) => rank(a.target) - rank(b.target) || a.index - b.index)[0]?.target;
}
/** Resolution or a measured reduction in policy violations; file changes alone are not progress. */
export function targetMadeProgress(before: RepairTarget, remaining: RepairTarget | undefined): boolean {
  if (!remaining) return true;
  return before.observedCount !== undefined && remaining.observedCount !== undefined && before.expectedCount !== undefined
    && before.expectedCount === remaining.expectedCount
    && Math.abs(remaining.observedCount - before.expectedCount) < Math.abs(before.observedCount - before.expectedCount);
}
