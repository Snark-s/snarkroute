import { z } from "zod";

export const ModelCapabilitySchema = z.enum([
  "text",
  "vision",
  "image_generation",
  "video_generation",
  "audio",
  "json_output",
  "tool_calling",
  "long_context",
  "embeddings",
  "rerank",
  "moderation"
]);

export const CostClassSchema = z.enum(["free", "cheap", "medium", "expensive", "dangerous", "unknown"]);
export const PrivacyClassSchema = z.enum(["local", "trusted_external", "external", "unknown"]);
export const ModelMediaKindSchema = z.enum(["text", "image", "video", "audio", "file", "json"]);
export const ModelIOItemSchema = z
  .object({
    kind: ModelMediaKindSchema,
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
    required: z.boolean().optional()
  })
  .catchall(z.unknown());
export const ModelIOContractSchema = z
  .object({
    inputs: z.array(ModelIOItemSchema).optional(),
    outputs: z.array(ModelIOItemSchema).optional()
  })
  .catchall(z.unknown());

export const ModelProfileSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    capabilities: z.array(ModelCapabilitySchema).default([]),
    ioContract: ModelIOContractSchema.optional(),
    defaultParams: z.record(z.unknown()).optional(),
    costClass: CostClassSchema.optional(),
    privacyClass: PrivacyClassSchema.optional(),
    limits: z
      .object({
        maxBudgetPerRun: z.number().nonnegative().optional(),
        maxCallsPerRun: z.number().int().positive().optional(),
        requiresConfirmationAbove: z.number().nonnegative().optional()
      })
      .optional(),
    fallbackProfileIds: z.array(z.string().min(1)).optional(),
    description: z.string().optional()
  })
  .catchall(z.unknown());

export const AgentPresetSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    systemPrompt: z.string(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional()
  })
  .catchall(z.unknown());

export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;
export type CostClass = z.infer<typeof CostClassSchema>;
export type PrivacyClass = z.infer<typeof PrivacyClassSchema>;
export type ModelMediaKind = z.infer<typeof ModelMediaKindSchema>;
export type ModelIOItem = z.infer<typeof ModelIOItemSchema>;
export type ModelIOContract = z.infer<typeof ModelIOContractSchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type AgentPreset = z.infer<typeof AgentPresetSchema>;

export interface ModelProviderAdapter {
  id: string;
  displayName: string;
  capabilities: ModelCapability[];
  listProfiles?: () => Promise<ModelProfile[]> | ModelProfile[];
}

export const DEFAULT_MODEL_PROFILES: ModelProfile[] = [
  {
    id: "text.default",
    displayName: "Default Text Model",
    providerId: "openrouter",
    modelId: "text.default",
    capabilities: ["text", "json_output"],
    costClass: "unknown",
    privacyClass: "external",
    description: "Local profile alias for the current default remote text model. Credentials stay in local settings."
  },
  {
    id: "image.nano-banana",
    displayName: "Nano Banana Image",
    providerId: "gemini",
    modelId: "gemini-3.1-flash-image-preview",
    capabilities: ["text", "vision", "image_generation"],
    costClass: "medium",
    privacyClass: "trusted_external",
    description: "Image generation/editing profile mapped through the existing Gemini adapter."
  },
  {
    id: "local.stable-diffusion",
    displayName: "Local Stable Diffusion",
    providerId: "local",
    modelId: "stable-diffusion-webui-compatible",
    capabilities: ["text", "image_generation"],
    costClass: "free",
    privacyClass: "local",
    description: "Local WebUI-compatible image generation profile."
  }
];

export const DEFAULT_AGENT_PRESETS: AgentPreset[] = [
  {
    id: "plain-collaborator",
    displayName: "Plain Collaborator",
    systemPrompt: "Be direct, useful, and explicit about assumptions.",
    tags: ["general"]
  }
];

export function parseModelProfile(input: unknown): ModelProfile {
  return ModelProfileSchema.parse(input);
}

export function validateModelProfile(input: unknown): { ok: true; profile: ModelProfile } | { ok: false; issues: string[] } {
  const parsed = ModelProfileSchema.safeParse(input);
  if (parsed.success) return { ok: true, profile: parsed.data };
  return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`) };
}

export function modelProfileFromLegacyParams(params: Record<string, unknown> | undefined): Pick<ModelProfile, "id" | "providerId" | "modelId" | "capabilities"> | null {
  const model = typeof params?.model === "string" && params.model.trim() ? params.model.trim() : "";
  if (!model) return null;
  const providerMode = typeof params?.providerMode === "string" && params.providerMode.trim() ? params.providerMode.trim() : "";
  const providerId = typeof params?.provider === "string" && params.provider.trim() ? params.provider.trim() : providerMode || providerFromModelId(model);
  return {
    id: typeof params?.modelProfileId === "string" && params.modelProfileId.trim() ? params.modelProfileId.trim() : model,
    providerId,
    modelId: model,
    capabilities: []
  };
}

function providerFromModelId(modelId: string): string {
  if (modelId.startsWith("gemini-")) return "gemini";
  if (modelId.includes("/")) return modelId.split("/")[0] || "unknown";
  if (modelId.startsWith("text.")) return "openrouter";
  if (modelId.startsWith("image.")) return "openrouter";
  return "unknown";
}
