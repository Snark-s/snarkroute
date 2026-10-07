import { z } from "zod";
import { callPredicateSchema } from "./repair-target";

export const routeExecutionConfigSchema = z.object({
  routingMode: z.enum(["default", "auto", "fixed"]).optional(),
  model: z.string().trim().min(1).max(300).optional(),
  runtimeMode: z.enum(["text", "agent"]).optional(),
  permissions: z.enum(["read_only", "read_write"]).optional(),
  maxToolTurns: z.number().int().min(1).max(16).optional(),
  toolProtocol: z.enum(["native", "json", "auto"]).optional(),
  correctiveExecution: z.object({ stepIndexes: z.array(z.number().int().min(0).max(99)).max(100) }).strict().optional(),
  constraints: z.union([z.array(z.string().trim().min(1).max(1_000)).max(20), z.record(z.unknown())]).optional()
}).strict().refine(value => value.routingMode !== "fixed" || Boolean(value.model), { message: "model is required for fixed routing" });
export const routeVerificationConfigSchema = z.object({
  timeoutMs: z.number().int().min(10).max(180_000).optional(),
  executionConfig: z.object({ routingMode: z.enum(["default", "auto", "fixed"]).optional(), model: z.string().trim().min(1).max(300).optional(),
    constraints: z.union([z.array(z.string().trim().min(1).max(1000)).max(20), z.record(z.unknown())]).optional()
  }).strict().refine(value => value.routingMode !== "fixed" || Boolean(value.model), { message: "model is required for fixed verification routing" }).optional(),
  policies: z.array(z.object({ stepIndex: z.number().int().min(0).max(99), commandScope: z.enum(["step", "route"]).optional(),
    requiredCommands: z.array(z.enum(["build", "test", "lint", "typecheck"])).max(4).optional(),
    sources: z.array(z.object({ path: z.string().min(1).max(500), uniqueSymbol: z.string().min(1).max(200).optional(),
      requiredCalls: z.array(z.union([z.string().min(1).max(200), callPredicateSchema])).max(20).optional(), requiredLiterals: z.array(z.string().min(1).max(200)).max(20).optional()
    }).strict()).max(10).optional()
  }).strict()).max(100).optional()
}).strict();
export const createRouteSchema = z.object({
  taskId: z.string().trim().min(1).max(200),
  autoStart: z.boolean().optional(),
  executionConfig: routeExecutionConfigSchema.optional(),
  verificationConfig: routeVerificationConfigSchema.optional(),
  steps: z.array(z.object({
    title: z.string().trim().min(1).max(300),
    instruction: z.string().trim().min(1).max(4_000),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    dependencies: z.array(z.number().int().min(0)).max(100).optional()
  }).strict()).min(1).max(100)
}).strict().superRefine((value, context) => {
  value.steps.forEach((step, index) => {
    if (step.dependencies?.some(dependency => dependency >= index)) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ["steps", index, "dependencies"], message: "Dependencies must reference earlier step indexes." });
  });
});

export const continueRouteSchema = z.object({
  resolution: z.string().trim().min(1).max(4_000),
  additionalAttempts: z.number().int().min(1).max(8).optional(),
  executionConfig: routeExecutionConfigSchema.optional(),
  verificationConfig: routeVerificationConfigSchema.optional(),
  externalResolution: z.object({
    stepId: z.string().trim().min(1).max(200),
    evidence: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
    changedFiles: z.array(z.string().trim().min(1).max(500)).max(100)
  }).strict().optional()
}).strict();
