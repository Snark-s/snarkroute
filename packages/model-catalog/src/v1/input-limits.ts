import type { ModelCatalogEntryV1, ModelCapabilityV1, ModelOutputTypeV1, ModelProviderIdV1 } from "./types.js";
import type { ModelIOContract } from "@snarkroute/protocol";
import { modelIOContractV1 } from "./input-contracts.js";

type ModelImageInputLimitSource = {
  provider?: ModelProviderIdV1 | string;
  providerModelId?: string;
  id?: string;
  storedModelId?: string;
  nodeType?: string;
  capabilities?: ModelCapabilityV1[] | string[];
  outputTypes?: ModelOutputTypeV1[] | string[];
  metadata?: Record<string, unknown>;
  ioContract?: ModelIOContract;
};

export function modelMaxImageInputsV1(model: ModelImageInputLimitSource): number | undefined {
  const contractLimit = modelIOContractV1(model)?.inputs?.find((item) => item.kind === "image")?.maxItems;
  if (contractLimit !== undefined) return contractLimit;
  const explicitLimit = positiveInteger(model.metadata?.maxImageInputs) ?? positiveInteger(model.metadata?.maxImages);
  if (explicitLimit !== undefined) return explicitLimit;
  if (isPolzaVideoGenerationModel(model)) {
    return polzaVideoMaxImageInputsV1(model.providerModelId || model.storedModelId || model.id || "");
  }
  return undefined;
}

export function polzaVideoMaxImageInputsV1(modelId: string): number {
  const normalized = modelId.toLowerCase();
  if (normalized === "wan/2.6") return 1;
  return 14;
}

export function withDefaultModelInputLimitsV1(entry: ModelCatalogEntryV1): ModelCatalogEntryV1 {
  const maxImageInputs = modelMaxImageInputsV1(entry);
  if (maxImageInputs === undefined || entry.metadata?.maxImageInputs === maxImageInputs) return entry;
  return {
    ...entry,
    metadata: {
      ...(entry.metadata ?? {}),
      maxImageInputs
    }
  };
}

function isPolzaVideoGenerationModel(model: ModelImageInputLimitSource): boolean {
  if (model.provider !== "polza") return false;
  if (model.nodeType === "polza.video.generate") return true;
  return includesValue(model.capabilities, "video.generate") || includesValue(model.outputTypes, "video");
}

function includesValue(values: string[] | undefined, expected: string): boolean {
  return Boolean(values?.some((value) => value.toLowerCase() === expected));
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}
