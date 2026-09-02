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
    canonicalModelId: curated?.canonicalModelId ?? providerModel.canonicalModelId,
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
    metadata: mergeMetadata(providerModel.metadata, curated?.metadata),
    ioContract: curated?.ioContract ?? providerModel.ioContract
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

function selectIconKey(_provider: ModelProviderIdV1, originVendor: ModelOriginVendorV1, curated?: CuratedModelMetadataV1): string {
  if (curated?.iconKey) return curated.iconKey;
  const vendorIcon = iconKeyForVendor(originVendor);
  if (vendorIcon) return vendorIcon;
  const providerIcon = iconKeyForVendor(_provider);
  if (providerIcon) return providerIcon;
  return "unknown";
}

function selectIconPath(provider: ModelProviderIdV1, originVendor: ModelOriginVendorV1, curated?: CuratedModelMetadataV1): string {
  if (curated?.iconPath) return curated.iconPath;
  return `/api/model-icons/${iconFilenameForKey(selectIconKey(provider, originVendor, curated))}`;
}

function iconKeyForVendor(originVendor: ModelOriginVendorV1): string | undefined {
  const icons: Record<string, string> = {
    anthropic: "anthropic",
    "black-forest-labs": "flux-2-pro",
    bytedance: "bytedance",
    google: "gemini",
    kling: "kling",
    minimax: "minimax",
    "nano-banana": "nano-banana",
    openai: "gpt",
    elevenlabs: "elevenlabs",
    qwen: "qwen",
    seedance: "seedance",
    stability: "stability",
    suno: "suno",
    topaz: "topaz",
    wan: "wan",
    "x-ai": "x-ai",
    xai: "x-ai",
    "z-ai": "z-image",
    "tongyi-mai": "z-image"
  };
  return icons[originVendor];
}

function iconFilenameForKey(iconKey: string): string {
  const filenames: Record<string, string> = {
    anthropic: "claude.png",
    "black-forest-labs": "flux-2-pro.png",
    bytedance: "seedream-4-5.png",
    claude: "claude.png",
    elevenlabs: "elevenlabs.svg",
    gemini: "gemini.png",
    google: "gemini.png",
    gpt: "gpt.png",
    local: "local.svg",
    kling: "kling.png",
    kwaivgi: "kling.png",
    kuaishou: "kling.png",
    minimax: "hailuo.png",
    hailuo: "hailuo.png",
    openai: "gpt.png",
    qwen: "qwen.png",
    replicate: "replicate.svg",
    seedance: "seedream-4-5.png",
    seedream: "seedream-4-5.png",
    "seedream-4-5": "seedream-4-5.png",
    "nano-banana": "nano-banana.svg",
    "image.nano-banana": "nano-banana.svg",
    "google/gemini-3.1-flash-image-preview": "nano-banana.svg",
    "google/gemini-3-pro-image-preview": "nano-banana.svg",
    stability: "stability.svg",
    suno: "suno.svg",
    topaz: "topaz.svg",
    unknown: "unknown.svg",
    wan: "wan.svg",
    "x-ai": "grok-image.png",
    xai: "grok-image.png",
    grok: "grok-image.png",
    "z-ai": "z-image.png",
    zai: "z-image.png",
    "z-image": "z-image.png",
    "tongyi-mai": "z-image.png",
    yandex: "yandexart.png"
  };
  return filenames[iconKey] ?? "unknown.svg";
}

function mergeMetadata(providerMetadata?: Record<string, unknown>, curatedMetadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!providerMetadata && !curatedMetadata) return undefined;
  return {
    ...(curatedMetadata ?? {}),
    ...(providerMetadata ? { provider: providerMetadata } : {}),
    ...(curatedMetadata ? { curated: curatedMetadata } : {})
  };
}
