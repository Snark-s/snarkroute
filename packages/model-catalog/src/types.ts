export type ModelProviderId =
  | "anthropic"
  | "gemini"
  | "local"
  | "openai"
  | "openrouter"
  | "polza"
  | "replicate"
  | "seedance"
  | "unknown"
  | (string & {});

export type ModelOutputType = "text" | "image" | "video" | "audio" | "embedding" | "json" | "unknown";
export type ModelInputType = "text" | "image" | "video" | "audio" | "file" | "json";

export type ModelParameterValue = string | number | boolean;

export interface ModelParameterOption {
  value: string;
  label?: string;
}

export interface ModelParameterDefinition {
  id: string;
  label?: string;
  type: "select" | "number" | "text" | "boolean";
  default?: ModelParameterValue;
  options?: ModelParameterOption[];
  min?: number;
  max?: number;
  step?: number;
}

export interface ModelCatalogEntry {
  provider: ModelProviderId;
  providerModelId: string;
  displayName: string;
  outputType: ModelOutputType;
  inputTypes?: ModelInputType[];
  parameters?: ModelParameterDefinition[];
  iconKey: string;
  iconPath?: string;
  aliases?: string[];
  capabilities?: string[];
  maxImageInputs?: number;
  metadata?: Record<string, unknown>;
}

export interface UnifiedModelInfo extends ModelCatalogEntry {
  id: string;
  inputTypes: ModelInputType[];
  parameters: ModelParameterDefinition[];
  iconPath: string;
  catalogStatus: "known" | "unknown";
}

export type ProviderModelLike = Record<string, unknown>;
