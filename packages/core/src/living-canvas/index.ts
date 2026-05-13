export type LivingNodeType = "idea" | "entity" | "concept" | (string & {});
export type CandidateMediaType = "text" | "image" | "video" | "audio" | "file" | "data" | (string & {});
export type CandidateStatus = "draft" | "generating" | "ready" | "failed" | "archived";
export type InputLinkMode = "live" | "pinned";
export type ToolActionMode = "addCandidate" | "createNode" | "service";

export interface LivingNode {
  id: string;
  type: LivingNodeType;
  title: string;
  description?: string;
  inputs: InputLink[];
  candidates: CandidateCard[];
  activeCandidateId?: string;
  context?: LivingContext;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateCard {
  id: string;
  parentNodeId: string;
  mediaType: CandidateMediaType;
  fileRef?: string;
  dataRef?: string;
  thumbnailRef?: string;
  status: CandidateStatus;
  provenance?: CandidateProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface InputLink {
  sourceNodeId: string;
  sourceCandidateId?: string | "active";
  mode: InputLinkMode;
  role?: string;
  weight?: number;
  options?: Record<string, unknown>;
}

export interface LivingContext {
  style?: string;
  atmosphere?: string;
  world?: string;
  format?: string;
  inheritedFrom?: string[];
}

export interface CandidateProvenance {
  operationId?: string;
  toolActionId?: string;
  inputSnapshots?: unknown[];
  contextSnapshot?: LivingContext;
  params?: Record<string, unknown>;
  provider?: string;
  model?: string;
  prompt?: string;
  seed?: string | number;
  createdAt: string;
}

export interface ToolAction {
  id: string;
  title: string;
  mode: ToolActionMode;
  inputTypes: string[];
  outputTypes: string[];
  paramsSchema?: unknown;
  executorRef: string;
}
