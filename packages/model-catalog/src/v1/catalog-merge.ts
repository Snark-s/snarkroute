import type {
  CuratedModelMetadataV1,
  ModelCatalogEntryV1,
  ModelOriginVendorV1,
  ModelProviderIdV1,
  ProviderModelInfoV1
} from "./types.js";

import { createUnifiedModelId } from "./provider-normalization.js";

export function mergeProviderModelWithCuratedMetadata(
  providerModel: ProviderModelInfoV1,
  curatedMetadata?: CuratedModelMetadataV1
): ModelCatalogEntryV1 {
  const curated = curatedMetadata && curatedMetadataMatchesProviderModel(curatedMetadata, providerModel) ? curatedMetadata : undefined;
  return {
    id: createUnifiedModelId(providerModel.provider, providerModel.providerModelId),
    provider: providerModel.provider,
    providerModelId: providerModel.providerModelId,
    originVendor: curated?.originVendor ?? providerModel.originVendor,
    originModelId: curated?.originModelId,
    displayName: curated?.displayName ?? providerModel.displayName,
    description: curated?.description,
    iconKey: selectIconKey(providerModel.provider, curated?.originVendor ?? providerModel.originVendor, curated),
    iconPath: selectIconPath(providerModel.provider, curated?.originVendor ?? providerModel.originVendor, curated),
    inputTypes: curated?.inputTypes ?? providerModel.inputTypes,
    outputTypes: curated?.outputTypes ?? providerModel.outputTypes,
    capabilities: curated?.capabilities ?? providerModel.capabilities,
    roles: curated?.roles ?? providerModel.roles,
    availability: providerModel.availability,
    parameters: curated?.parameters ?? [],
    pricing: curated?.pricing,
    catalogStatus: curated ? "known" : "unknown",
    aliases: curated?.aliases,
    metadata: mergeMetadata(providerModel.metadata, curated?.metadata)
  };
}

export function mergeProviderModelsWithCuratedMetadata(
  providerModels: ProviderModelInfoV1[],
  curatedMetadata: CuratedModelMetadataV1[] = []
): ModelCatalogEntryV1[] {
  return providerModels.map((providerModel) =>
    mergeProviderModelWithCuratedMetadata(
      providerModel,
      findCuratedMetadataForProviderModel(providerModel, curatedMetadata)
    )
  );
}

export function createUnknownCatalogEntryFromProviderModel(providerModel: ProviderModelInfoV1): ModelCatalogEntryV1 {
  return mergeProviderModelWithCuratedMetadata(providerModel);
}

export function findCuratedMetadataForProviderModel(
  providerModel: Pick<ProviderModelInfoV1, "provider" | "providerModelId">,
  curatedMetadata: CuratedModelMetadataV1[]
): CuratedModelMetadataV1 | undefined {
  return curatedMetadata.find((curated) => curatedMetadataMatchesProviderModel(curated, providerModel));
}

function curatedMetadataMatchesProviderModel(
  curated: CuratedModelMetadataV1,
  providerModel: Pick<ProviderModelInfoV1, "provider" | "providerModelId">
): boolean {
  return curated.provider === providerModel.provider
    && (curated.providerModelId === providerModel.providerModelId || Boolean(curated.aliases?.includes(providerModel.providerModelId)));
}

function selectIconKey(provider: ModelProviderIdV1, originVendor: ModelOriginVendorV1, curated?: CuratedModelMetadataV1): string {
  if (curated?.iconKey) return curated.iconKey;
  const vendorIcon = iconKeyForVendor(originVendor);
  if (vendorIcon) return vendorIcon;
  return iconKeyForProvider(provider);
}

function selectIconPath(provider: ModelProviderIdV1, originVendor: ModelOriginVendorV1, curated?: CuratedModelMetadataV1): string {
  if (curated?.iconPath) return curated.iconPath;
  return `/api/model-icons/${selectIconKey(provider, originVendor, curated)}.svg`;
}

function iconKeyForVendor(originVendor: ModelOriginVendorV1): string | undefined {
  const icons: Record<string, string> = {
    "black-forest-labs": "flux-2-pro",
    google: "gemini",
    openai: "gpt",
    qwen: "qwen",
    topaz: "topaz"
  };
  return icons[originVendor];
}

function iconKeyForProvider(provider: ModelProviderIdV1): string {
  const icons: Record<string, string> = {
    gemini: "gemini",
    local: "local",
    openrouter: "openrouter",
    polza: "polza",
    replicate: "replicate",
    seedance: "seedream-4-5"
  };
  return icons[provider] ?? "unknown";
}

function mergeMetadata(providerMetadata?: Record<string, unknown>, curatedMetadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!providerMetadata && !curatedMetadata) return undefined;
  return {
    ...(providerMetadata ? { provider: providerMetadata } : {}),
    ...(curatedMetadata ? { curated: curatedMetadata } : {})
  };
}
