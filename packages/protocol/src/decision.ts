import { z } from "zod";

export const DECISION_PROTOCOL = "decision.v1" as const;
export const DECISION_OPERATIONS = ["select_one", "rank", "classify", "score", "extract"] as const;

export type DecisionOperation = (typeof DECISION_OPERATIONS)[number] | (string & {});

export const DecisionCandidateSchema = z.object({
  id: z.string().min(1),
  value: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional()
}).catchall(z.unknown());

export const DecisionConstraintsSchema = z.object({
  topK: z.number().int().positive().optional(),
  allowAbstain: z.boolean().optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  timeoutMs: z.number().int().positive().optional()
}).catchall(z.unknown());

export const DecisionRequestSchema = z.object({
  operation: z.string().min(1),
  input: z.unknown(),
  candidates: z.array(DecisionCandidateSchema).optional(),
  constraints: DecisionConstraintsSchema.optional(),
  metadata: z.record(z.unknown()).optional()
}).catchall(z.unknown()).superRefine((request, context) => {
  if (!Object.prototype.hasOwnProperty.call(request, "input")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["input"], message: "Decision input is required." });
  }
  const ids = new Set<string>();
  for (const [index, candidate] of (request.candidates ?? []).entries()) {
    if (ids.has(candidate.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates", index, "id"], message: `Duplicate candidate ID "${candidate.id}".` });
    }
    ids.add(candidate.id);
  }
});

export const DecisionStatusSchema = z.enum(["ok", "abstain", "low_confidence", "unsupported", "timeout", "error"]);

export const DecisionResultSchema = z.object({
  id: z.string().min(1),
  score: z.number().optional(),
  label: z.string().optional(),
  value: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional()
}).catchall(z.unknown());

export const DecisionDiagnosticsSchema = z.object({
  reason: z.string().optional(),
  provider: z.string().optional(),
  cost: z.number().optional(),
  raw: z.unknown().optional()
}).catchall(z.unknown());

export const DecisionResponseSchema = z.object({
  status: DecisionStatusSchema,
  results: z.array(DecisionResultSchema).default([]),
  confidence: z.number().min(0).max(1).optional(),
  backend: z.string().optional(),
  message: z.string().optional(),
  diagnostics: DecisionDiagnosticsSchema.optional()
}).catchall(z.unknown());

export interface DecisionCandidate {
  id: string;
  value?: unknown;
  metadata?: Record<string, unknown>;
}

export interface DecisionConstraints {
  topK?: number;
  allowAbstain?: boolean;
  confidenceThreshold?: number;
  timeoutMs?: number;
}

export interface DecisionRequest {
  operation: DecisionOperation;
  input: unknown;
  candidates?: DecisionCandidate[];
  constraints?: DecisionConstraints;
  metadata?: Record<string, unknown>;
}

export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export interface DecisionResult {
  id: string;
  score?: number;
  label?: string;
  value?: unknown;
  metadata?: Record<string, unknown>;
}

export interface DecisionDiagnostics {
  reason?: string;
  provider?: string;
  cost?: number;
  raw?: unknown;
  [key: string]: unknown;
}

export interface DecisionResponse {
  status: DecisionStatus;
  results: DecisionResult[];
  confidence?: number;
  backend?: string;
  message?: string;
  diagnostics?: DecisionDiagnostics;
}
