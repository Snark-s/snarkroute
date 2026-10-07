import type {
  EngineCapability,
  EngineConstraints,
  EngineDomain,
  EngineInputFacts,
  EngineOperation,
  EnginePreferences,
  EngineRequirements
} from "@snarkroute/protocol";
import type { DecisionExecutor, DecisionStatus } from "../decision-layer";
import {
  ModelGateway,
  ModelRegistry,
  getModelIOContract,
  providerModelRef,
  type ModelInfo,
  type ModelSelectionPreferences
} from "../model-gateway";

export interface ExplicitEngineRequirements {
  domain?: EngineDomain;
  operation?: EngineOperation;
  requiredCapabilities?: EngineCapability[];
  preferredCapabilities?: EngineCapability[];
  preferences?: EnginePreferences;
  constraints?: EngineConstraints;
}

export interface EngineSelectionInput {
  prompt?: string;
  targetDomain?: EngineDomain;
  explicitOperation?: EngineOperation;
  inputs?: EngineInputFacts;
  explicit?: ExplicitEngineRequirements;
  preferences?: EnginePreferences;
  constraints?: EngineConstraints;
  manualModelRef?: string;
  metadata?: Record<string, unknown>;
}

export interface SemanticRequirementPolicy {
  hardConfidenceThreshold?: number;
  softConfidenceThreshold?: number;
}

export interface RequirementDecisionTrace {
  invoked: boolean;
  operation?: "rank";
  backend?: string;
  status?: DecisionStatus;
  confidence?: number;
  latencyMs?: number;
}

export interface EngineRequirementBuildResult {
  requirements: EngineRequirements;
  decision: RequirementDecisionTrace;
}

export interface RejectedEngineTrace {
  engineId: string;
  missingCapabilities: EngineCapability[];
  reasons: string[];
}

export interface CapabilityMatchResult {
  eligible: ModelInfo[];
  rejected: RejectedEngineTrace[];
  preferenceScores: Record<string, number>;
}

export interface EngineSelectionTrace {
  requirements: EngineRequirements;
  hardCapabilities: EngineCapability[];
  softCapabilities: EngineCapability[];
  eligibleEngineIds: string[];
  rejected: RejectedEngineTrace[];
  selectedEngineId?: string;
  selectionReason: "manual_override" | "policy" | "unsupported";
  policyReasons: string[];
  decision: RequirementDecisionTrace;
}

export interface SemanticEngineSelectionResult {
  status: "ok" | "unsupported";
  selected?: ModelInfo;
  eligible: ModelInfo[];
  requirements: EngineRequirements;
  trace: EngineSelectionTrace;
}

export interface SemanticSelectionObservation {
  decisionInvoked: boolean;
  decisionBackend?: string;
  decisionOperation?: "rank";
  decisionLatencyMs?: number;
  decisionStatus?: DecisionStatus;
  decisionConfidence?: number;
  requirements: EngineRequirements;
  hardCapabilities: EngineCapability[];
  softCapabilities: EngineCapability[];
  eligibleEnginesCount: number;
  eligibleEngineIds: string[];
  selectedEngine?: string;
  selectionReason: EngineSelectionTrace["selectionReason"];
}

export interface SemanticEngineSelectorOptions {
  onObservation?: (observation: SemanticSelectionObservation) => void;
}

const DEFAULT_HARD_THRESHOLD = 0.8;
const DEFAULT_SOFT_THRESHOLD = 0.25;

const SEMANTIC_CAPABILITY_CANDIDATES: Array<{
  id: EngineCapability;
  domains: EngineDomain[];
  keywords: string[];
}> = [
  { id: "video.preserve_motion", domains: ["video"], keywords: ["preserve camera", "preserve motion", "original camera", "camera movement"] },
  { id: "video.camera_control", domains: ["video"], keywords: ["camera path", "camera control", "dolly", "pan camera", "orbit camera"] },
  { id: "video.character_consistency", domains: ["video"], keywords: ["replace character", "replace the character", "same character", "referenced character"] },
  { id: "video.audio_generation", domains: ["video"], keywords: ["generate audio", "with sound", "soundtrack", "ambient audio"] },
  { id: "video.lip_sync", domains: ["video"], keywords: ["lip sync", "lipsync", "match speech"] },
  { id: "image.reference", domains: ["image"], keywords: ["reference image", "same character", "match style"] },
  { id: "text.coding", domains: ["text", "multimodal"], keywords: ["typescript", "api handler", "coding", "code"] },
  { id: "text.long_context", domains: ["text", "multimodal"], keywords: ["long document", "large codebase", "entire repository", "long context"] },
  { id: "text.tool_call", domains: ["text", "multimodal"], keywords: ["use tools", "call tool", "execute command", "tool call"] },
  { id: "text.structured_output", domains: ["text", "multimodal"], keywords: ["json", "structured output", "schema", "extract fields"] }
];

export class EngineRequirementBuilder {
  readonly #hardThreshold: number;
  readonly #softThreshold: number;

  constructor(private readonly dispatcher?: DecisionExecutor, policy: SemanticRequirementPolicy = {}) {
    this.#hardThreshold = clampConfidence(policy.hardConfidenceThreshold ?? DEFAULT_HARD_THRESHOLD);
    this.#softThreshold = clampConfidence(policy.softConfidenceThreshold ?? DEFAULT_SOFT_THRESHOLD);
  }

  async build(input: EngineSelectionInput): Promise<EngineRequirementBuildResult> {
    const facts = normalizeInputFacts(input.inputs);
    const deterministic = deterministicRequirements(
      input.explicit?.domain ?? input.targetDomain,
      input.explicit?.operation ?? input.explicitOperation,
      facts,
      input.constraints
    );
    const decision = await this.semanticEnrichment(input, deterministic.domain);
    const semanticRequired: EngineCapability[] = [];
    const semanticPreferred: EngineCapability[] = [];

    for (const result of decision.results) {
      const capability = semanticCapability(result.id);
      if (!capability || deterministic.requiredCapabilities.includes(capability)) continue;
      const confidence = result.score ?? decision.confidence ?? 0;
      if (confidence >= this.#hardThreshold) semanticRequired.push(capability);
      else if (confidence >= this.#softThreshold) semanticPreferred.push(capability);
    }

    const explicit = input.explicit ?? {};
    const requiredCapabilities = uniqueCapabilities([
      ...deterministic.requiredCapabilities,
      ...semanticRequired,
      ...(explicit.requiredCapabilities ?? [])
    ]);
    const requirements: EngineRequirements = {
      domain: explicit.domain ?? deterministic.domain,
      operation: explicit.operation ?? deterministic.operation,
      inputs: facts,
      requiredCapabilities,
      preferredCapabilities: uniqueCapabilities([
        ...semanticPreferred,
        ...(explicit.preferredCapabilities ?? [])
      ]).filter((capability) => !requiredCapabilities.includes(capability)),
      preferences: { ...(input.preferences ?? {}), ...(explicit.preferences ?? {}) },
      constraints: { ...(deterministic.constraints ?? {}), ...(input.constraints ?? {}), ...(explicit.constraints ?? {}) },
      confidence: decision.confidence,
      decisionBackend: decision.backend,
      manualModelRef: input.manualModelRef,
      metadata: input.metadata
    };

    return {
      requirements,
      decision: {
        invoked: decision.invoked,
        operation: decision.invoked ? "rank" : undefined,
        backend: decision.backend,
        status: decision.status,
        confidence: decision.confidence,
        latencyMs: decision.latencyMs
      }
    };
  }

  private async semanticEnrichment(input: EngineSelectionInput, domain: EngineDomain | undefined) {
    if (!this.dispatcher || !input.prompt?.trim() || input.manualModelRef) return { invoked: false, results: [] as Array<{ id: string; score?: number }>, latencyMs: 0 };
    const candidates = SEMANTIC_CAPABILITY_CANDIDATES
      .filter((candidate) => !domain || candidate.domains.includes(domain))
      .map((candidate) => ({ id: candidate.id, metadata: { keywords: candidate.keywords } }));
    if (candidates.length === 0) return { invoked: false, results: [] as Array<{ id: string; score?: number }>, latencyMs: 0 };
    const startedAt = Date.now();
    const response = await this.dispatcher.execute({
      operation: "rank",
      input: {
        prompt: input.prompt,
        domain,
        inputs: normalizeInputFacts(input.inputs),
        explicitOperation: input.explicitOperation
      },
      candidates,
      metadata: { purpose: "engine_requirements" }
    });
    return { invoked: true, results: response.results, backend: response.backend, status: response.status, confidence: response.confidence, latencyMs: Date.now() - startedAt };
  }
}

export class CapabilityMatcher {
  constructor(private readonly registry: ModelRegistry) {}

  match(requirements: EngineRequirements): CapabilityMatchResult {
    const eligible: ModelInfo[] = [];
    const rejected: RejectedEngineTrace[] = [];
    const preferenceScores: Record<string, number> = {};

    for (const engine of this.registry.listEngines()) {
      if (engine.kind === "decision") continue;
      const capabilities = effectiveCapabilities(engine);
      const missingCapabilities = requirements.requiredCapabilities.filter((capability) => !capabilities.has(capability));
      const reasons = [
        ...(engine.availability === "unavailable" ? ["unavailable"] : []),
        ...inputMismatchReasons(engine, requirements.inputs),
        ...constraintMismatchReasons(engine, requirements.constraints)
      ];
      if (requirements.domain && engine.kind && !engineKindMatchesDomain(engine.kind, requirements.domain)) reasons.push(`domain:${requirements.domain}`);
      if (missingCapabilities.length || reasons.length) {
        rejected.push({ engineId: engine.id, missingCapabilities, reasons });
        continue;
      }
      eligible.push(engine);
      preferenceScores[engine.id] = requirements.preferredCapabilities.filter((capability) => capabilities.has(capability)).length;
    }

    return { eligible, rejected, preferenceScores };
  }
}

export class SemanticEngineSelector {
  readonly #matcher: CapabilityMatcher;

  constructor(
    private readonly gateway: ModelGateway,
    private readonly builder: EngineRequirementBuilder,
    private readonly options: SemanticEngineSelectorOptions = {}
  ) {
    this.#matcher = new CapabilityMatcher(gateway.registry);
  }

  async select(input: EngineSelectionInput): Promise<SemanticEngineSelectionResult> {
    const built = await this.builder.build(input);
    const matched = this.#matcher.match(built.requirements);
    let selected: ModelInfo | undefined;
    let selectionReason: EngineSelectionTrace["selectionReason"] = "unsupported";
    const policyReasons: string[] = [];

    if (input.manualModelRef) {
      const manual = this.gateway.registry.findByModelRef(input.manualModelRef);
      if (manual && matched.eligible.some((engine) => engine.id === manual.id)) {
        try {
          selected = this.gateway.resolver.selectCandidate([manual], undefined, matched.preferenceScores);
          selectionReason = "manual_override";
          policyReasons.push("manual override", "capability validation", "availability");
        } catch {
          policyReasons.push("manual override unavailable");
        }
      } else {
        policyReasons.push("manual override failed capability validation");
      }
    } else if (matched.eligible.length > 0) {
      try {
        selected = this.gateway.resolver.selectCandidate(matched.eligible, gatewayPreferences(built.requirements.preferences), matched.preferenceScores);
        selectionReason = "policy";
        policyReasons.push("capability match", "availability", "preferred capabilities", "gateway preferences", "priority");
      } catch {
        policyReasons.push("no enabled provider route");
      }
    }

    const status = selected ? "ok" as const : "unsupported" as const;
    const trace: EngineSelectionTrace = {
      requirements: observableRequirements(built.requirements),
      hardCapabilities: [...built.requirements.requiredCapabilities],
      softCapabilities: [...built.requirements.preferredCapabilities],
      eligibleEngineIds: matched.eligible.map((engine) => engine.id),
      rejected: matched.rejected,
      selectedEngineId: selected?.id,
      selectionReason,
      policyReasons,
      decision: built.decision
    };
    this.options.onObservation?.({
      decisionInvoked: built.decision.invoked,
      decisionBackend: built.decision.backend,
      decisionOperation: built.decision.operation,
      decisionLatencyMs: built.decision.latencyMs,
      decisionStatus: built.decision.status,
      decisionConfidence: built.decision.confidence,
      requirements: observableRequirements(built.requirements),
      hardCapabilities: trace.hardCapabilities,
      softCapabilities: trace.softCapabilities,
      eligibleEnginesCount: trace.eligibleEngineIds.length,
      eligibleEngineIds: trace.eligibleEngineIds,
      selectedEngine: selected?.id,
      selectionReason
    });
    return { status, selected, eligible: matched.eligible, requirements: built.requirements, trace };
  }
}

function deterministicRequirements(
  domain: EngineDomain | undefined,
  explicitOperation: EngineOperation | undefined,
  inputs: EngineInputFacts,
  constraints: EngineConstraints | undefined
): Pick<EngineRequirements, "domain" | "operation" | "requiredCapabilities" | "constraints"> {
  const operation = explicitOperation ?? inferOperation(domain, inputs);
  const required: EngineCapability[] = [];
  const imageCount = inputs.imageCount ?? 0;
  const videoCount = inputs.videoCount ?? 0;
  const roles = new Set(inputs.imageRoles ?? []);

  if (domain === "text") required.push("text.generate");
  if (domain === "image") required.push(operation === "edit" ? "image.edit" : operation === "upscale" ? "image.upscale" : "image.generate");
  if (domain === "video") {
    if (operation === "edit") required.push("video.edit");
    else if (operation === "upscale") required.push("video.upscale");
    else required.push("video.generate");
    if (operation !== "upscale" && videoCount === 0) required.push(imageCount > 0 ? "video.image_to_video" : "video.text_to_video");
    if (roles.has("reference")) required.push("video.reference");
    if (roles.has("reference") && imageCount > 1) required.push("video.multi_reference");
    if (roles.has("firstFrame")) required.push("video.first_frame");
    if (roles.has("lastFrame")) required.push("video.last_frame");
    if (roles.has("firstFrame") && roles.has("lastFrame")) required.push("video.first_last_frame");
  }
  if (domain === "upscale") required.push(videoCount > 0 ? "video.upscale" : "image.upscale");
  if (domain === "audio") required.push("audio.generate");
  if (domain === "model") required.push("model.generate");

  return {
    domain,
    operation,
    requiredCapabilities: uniqueCapabilities(required),
    constraints: {
      ...constraints,
      referenceCount: constraints?.referenceCount ?? (roles.has("reference") ? imageCount : undefined)
    }
  };
}

function inferOperation(domain: EngineDomain | undefined, inputs: EngineInputFacts): EngineOperation | undefined {
  if (domain === "image") return (inputs.imageCount ?? 0) > 0 ? "edit" : "generate";
  if (domain === "video") return (inputs.videoCount ?? 0) > 0 ? "edit" : "generate";
  if (domain === "upscale") return "upscale";
  if (domain === "text" || domain === "audio" || domain === "model") return "generate";
  return undefined;
}

function effectiveCapabilities(engine: ModelInfo): Set<string> {
  const capabilities = new Set<string>(engine.capabilities);
  const contract = getModelIOContract(engine);
  const inputs = new Set(contract?.inputs?.map((item) => item.kind) ?? engine.inputTypes ?? []);
  const outputs = new Set(contract?.outputs?.map((item) => item.kind) ?? engine.outputTypes ?? []);
  if (capabilities.has("video.generate") && outputs.has("video")) {
    if (inputs.has("text")) capabilities.add("video.text_to_video");
    if (inputs.has("image")) capabilities.add("video.image_to_video");
  }
  const imageInput = contract?.inputs?.find((item) => item.kind === "image");
  const roles = new Set([...(imageInput?.roles ?? []), ...(imageInput?.slots ?? []).map((slot) => slot.role)]);
  if (roles.has("reference")) capabilities.add("video.reference");
  if (roles.has("reference") && (imageInput?.maxItems ?? 0) > 1) capabilities.add("video.multi_reference");
  if (roles.has("firstFrame")) capabilities.add("video.first_frame");
  if (roles.has("lastFrame")) capabilities.add("video.last_frame");
  if (roles.has("firstFrame") && roles.has("lastFrame")) capabilities.add("video.first_last_frame");
  return capabilities;
}

function inputMismatchReasons(engine: ModelInfo, inputs: EngineInputFacts): string[] {
  const contract = getModelIOContract(engine);
  const accepted = new Map((contract?.inputs ?? []).map((item) => [item.kind, item]));
  const reasons: string[] = [];
  const counts: Array<["image" | "video" | "audio", number]> = [
    ["image", inputs.imageCount ?? 0],
    ["video", inputs.videoCount ?? 0],
    ["audio", inputs.audioCount ?? 0]
  ];
  for (const [kind, count] of counts) {
    if (count <= 0) continue;
    const item = accepted.get(kind);
    if (!item) reasons.push(`unsupported ${kind} input`);
    else if (item.maxItems !== undefined && count > item.maxItems) reasons.push(`${kind} accepts at most ${item.maxItems}, got ${count}`);
  }
  if (inputs.text && contract?.inputs?.length && !accepted.has("text")) reasons.push("unsupported text input");
  return reasons;
}

function constraintMismatchReasons(engine: ModelInfo, constraints: EngineConstraints | undefined): string[] {
  if (!constraints) return [];
  const limits = { ...(engine.metadata ?? {}), ...(engine.limits ?? {}) };
  const reasons: string[] = [];
  const maxDuration = finiteNumber(limits.maxDurationSeconds ?? limits.maxDuration);
  if (constraints.durationSeconds !== undefined && maxDuration !== undefined && constraints.durationSeconds > maxDuration) reasons.push(`duration exceeds ${maxDuration}s`);
  const maxScale = finiteNumber(limits.maxScale);
  if (constraints.scale !== undefined && maxScale !== undefined && constraints.scale > maxScale) reasons.push(`scale exceeds ${maxScale}x`);
  const maxReferences = getModelIOContract(engine)?.inputs?.find((item) => item.kind === "image")?.maxItems;
  if (constraints.referenceCount !== undefined && maxReferences !== undefined && constraints.referenceCount > maxReferences) reasons.push(`reference count exceeds ${maxReferences}`);
  const allowedResolutions = Array.isArray(limits.allowedResolutions) ? limits.allowedResolutions.map(String) : undefined;
  if (constraints.resolution && allowedResolutions && !allowedResolutions.includes(constraints.resolution)) reasons.push(`unsupported resolution ${constraints.resolution}`);
  return reasons;
}

function engineKindMatchesDomain(kind: string, domain: EngineDomain): boolean {
  if (domain === "upscale") return kind === "upscale" || kind === "image" || kind === "video";
  if (domain === "multimodal") return true;
  return kind === domain || kind === "utility";
}

function gatewayPreferences(preferences: EnginePreferences | undefined): ModelSelectionPreferences | undefined {
  if (!preferences) return undefined;
  return {
    speed: preferences.latency === "low" ? "fast" : preferences.latency === "normal" ? "balanced" : undefined,
    cost: preferences.cost === "low" ? "low" : preferences.cost === "normal" ? "balanced" : undefined,
    quality: preferences.quality === "high" ? "best" : preferences.quality
  };
}

function normalizeInputFacts(inputs: EngineInputFacts | undefined): EngineInputFacts {
  return {
    text: inputs?.text,
    imageCount: nonnegativeInteger(inputs?.imageCount),
    videoCount: nonnegativeInteger(inputs?.videoCount),
    audioCount: nonnegativeInteger(inputs?.audioCount),
    imageRoles: inputs?.imageRoles ? [...new Set(inputs.imageRoles)] : undefined
  };
}

function semanticCapability(value: string): EngineCapability | undefined {
  return SEMANTIC_CAPABILITY_CANDIDATES.some((candidate) => candidate.id === value) ? value as EngineCapability : undefined;
}

function uniqueCapabilities(capabilities: EngineCapability[]): EngineCapability[] {
  return [...new Set(capabilities)];
}

function nonnegativeInteger(value: number | undefined): number | undefined {
  return Number.isFinite(value) && (value ?? -1) >= 0 ? Math.floor(value as number) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function observableRequirements(requirements: EngineRequirements): EngineRequirements {
  return { ...requirements, metadata: undefined };
}

export function selectedEngineRef(engine: ModelInfo): string {
  return providerModelRef(engine);
}
