import { z } from "zod";

export const ENGINE_DOMAINS = ["text", "image", "video", "audio", "model", "upscale", "multimodal"] as const;
export const ENGINE_OPERATIONS = ["generate", "edit", "upscale", "classify", "rank", "extract", "tool_call"] as const;

/** Provider-independent, atomic capability taxonomy. Existing dotted names are
 * retained so current catalog and gateway descriptors remain compatible. */
export const ENGINE_CAPABILITIES = [
  "text.generate",
  "text.coding",
  "text.long_context",
  "text.tool_call",
  "text.structured_output",
  "json.generate",
  "image.generate",
  "image.edit",
  "image.reference",
  "image.upscale",
  "video.generate",
  "video.text_to_video",
  "video.image_to_video",
  "video.edit",
  "video.reference",
  "video.multi_reference",
  "video.first_frame",
  "video.last_frame",
  "video.first_last_frame",
  "video.camera_control",
  "video.preserve_motion",
  "video.audio_generation",
  "video.lip_sync",
  "video.character_consistency",
  "video.upscale",
  "audio.generate",
  "model.generate",
  "embedding.create",
  "output.2k"
] as const;

export const EngineDomainSchema = z.enum(ENGINE_DOMAINS);
export const EngineOperationSchema = z.enum(ENGINE_OPERATIONS);
export const EngineCapabilitySchema = z.enum(ENGINE_CAPABILITIES);

export const EngineInputFactsSchema = z.object({
  text: z.boolean().optional(),
  imageCount: z.number().int().nonnegative().optional(),
  videoCount: z.number().int().nonnegative().optional(),
  audioCount: z.number().int().nonnegative().optional(),
  imageRoles: z.array(z.string().min(1)).optional()
}).catchall(z.unknown());

export const EnginePreferenceSchema = z.object({
  quality: z.enum(["draft", "balanced", "high"]).optional(),
  latency: z.enum(["low", "normal"]).optional(),
  cost: z.enum(["low", "normal"]).optional(),
  reasoning: z.enum(["low", "normal", "high"]).optional()
}).catchall(z.unknown());

export const EngineConstraintSchema = z.object({
  durationSeconds: z.number().positive().optional(),
  resolution: z.string().min(1).optional(),
  referenceCount: z.number().int().nonnegative().optional(),
  scale: z.number().positive().optional()
}).catchall(z.unknown());

export const EngineRequirementsSchema = z.object({
  domain: EngineDomainSchema.optional(),
  operation: EngineOperationSchema.optional(),
  inputs: EngineInputFactsSchema.default({}),
  requiredCapabilities: z.array(EngineCapabilitySchema).default([]),
  preferredCapabilities: z.array(EngineCapabilitySchema).default([]),
  preferences: EnginePreferenceSchema.optional(),
  constraints: EngineConstraintSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  decisionBackend: z.string().optional(),
  manualModelRef: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional()
}).catchall(z.unknown());

export type EngineDomain = (typeof ENGINE_DOMAINS)[number];
export type EngineOperation = (typeof ENGINE_OPERATIONS)[number];
export type EngineCapability = (typeof ENGINE_CAPABILITIES)[number];

export interface EngineInputFacts {
  text?: boolean;
  imageCount?: number;
  videoCount?: number;
  audioCount?: number;
  imageRoles?: string[];
}

export interface EnginePreferences {
  quality?: "draft" | "balanced" | "high";
  latency?: "low" | "normal";
  cost?: "low" | "normal";
  reasoning?: "low" | "normal" | "high";
}

export interface EngineConstraints {
  durationSeconds?: number;
  resolution?: string;
  referenceCount?: number;
  scale?: number;
}

export interface EngineRequirements {
  domain?: EngineDomain;
  operation?: EngineOperation;
  inputs: EngineInputFacts;
  requiredCapabilities: EngineCapability[];
  preferredCapabilities: EngineCapability[];
  preferences?: EnginePreferences;
  constraints?: EngineConstraints;
  confidence?: number;
  decisionBackend?: string;
  manualModelRef?: string;
  metadata?: Record<string, unknown>;
}
