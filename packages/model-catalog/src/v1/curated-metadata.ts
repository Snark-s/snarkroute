import type { CuratedModelMetadataV1, ModelProviderIdV1 } from "./types.js";

const curatedModelMetadata = defineCuratedModelMetadataV1([
  {
    provider: "polza",
    providerModelId: "topaz/image-upscale",
    displayName: "Topaz Image Upscale",
    originVendor: "topaz",
    iconKey: "topaz",
    iconPath: "/api/model-icons/topaz.svg",
    outputTypes: ["image"],
    capabilities: ["image.upscale"],
    roles: ["upscaler"]
  },
  {
    provider: "polza",
    providerModelId: "openai/gpt-5.4-image-2",
    displayName: "GPT-5.4 Image 2",
    originVendor: "openai",
    iconKey: "openai",
    iconPath: "/api/model-icons/gpt.png",
    outputTypes: ["image"],
    roles: ["generator"]
  },
  {
    provider: "polza",
    providerModelId: "openai/gpt-image-1.5",
    displayName: "GPT Image 1.5",
    originVendor: "openai",
    iconKey: "openai",
    iconPath: "/api/model-icons/gpt.png",
    outputTypes: ["image"],
    roles: ["generator", "editor"]
  },
  {
    provider: "polza",
    providerModelId: "openai/gpt-5-image",
    displayName: "GPT-5 Image",
    originVendor: "openai",
    iconKey: "openai",
    iconPath: "/api/model-icons/gpt.png",
    outputTypes: ["image"],
    roles: ["generator"]
  },
  {
    provider: "polza",
    providerModelId: "openai/gpt-5-image-mini",
    displayName: "GPT-5 Image Mini",
    originVendor: "openai",
    iconKey: "openai",
    iconPath: "/api/model-icons/gpt.png",
    outputTypes: ["image"],
    roles: ["generator"]
  },
  {
    provider: "polza",
    providerModelId: "qwen/image-2",
    displayName: "Qwen Image 2",
    originVendor: "qwen",
    iconKey: "qwen",
    iconPath: "/api/model-icons/qwen.png",
    outputTypes: ["image"],
    roles: ["generator"]
  },
  {
    provider: "polza",
    providerModelId: "yandex/yandex-art",
    displayName: "Yandex Art",
    originVendor: "yandex",
    iconKey: "yandex",
    iconPath: "/api/model-icons/yandexart.png",
    outputTypes: ["image"],
    roles: ["generator"]
  },
  {
    provider: "polza",
    providerModelId: "black-forest-labs/flux.2-pro",
    displayName: "FLUX.2 Pro",
    originVendor: "black-forest-labs",
    iconKey: "black-forest-labs",
    iconPath: "/api/model-icons/flux-2-pro.png",
    outputTypes: ["image"],
    roles: ["generator"]
  },
  {
    provider: "polza",
    providerModelId: "black-forest-labs/flux.2-flex",
    displayName: "FLUX.2 Flex",
    originVendor: "black-forest-labs",
    iconKey: "black-forest-labs",
    iconPath: "/api/model-icons/flux-2-pro.png",
    outputTypes: ["image"],
    roles: ["generator"],
    aliases: ["polza.flux-2-flex"]
  }
]);

export function listCuratedModelMetadataV1(): CuratedModelMetadataV1[] {
  return curatedModelMetadata.map((entry) => ({ ...entry, aliases: entry.aliases ? [...entry.aliases] : undefined }));
}

export function getCuratedModelMetadataV1(provider: ModelProviderIdV1, providerModelId: string): CuratedModelMetadataV1 {
  const metadata = findCuratedModelMetadataV1(provider, providerModelId);
  if (!metadata) throw new Error(`Curated model metadata not found: ${provider}:${providerModelId}`);
  return metadata;
}

export function findCuratedModelMetadataV1(provider: ModelProviderIdV1, providerModelId: string): CuratedModelMetadataV1 | undefined {
  return curatedModelMetadata.find((entry) =>
    entry.provider === provider
    && (entry.providerModelId === providerModelId || Boolean(entry.aliases?.includes(providerModelId)))
  );
}

export function listCuratedAliasesV1(): Array<{ provider: ModelProviderIdV1; providerModelId: string; alias: string }> {
  return curatedModelMetadata.flatMap((entry) =>
    (entry.aliases ?? []).map((alias) => ({ provider: entry.provider, providerModelId: entry.providerModelId, alias }))
  );
}

function defineCuratedModelMetadataV1(entries: CuratedModelMetadataV1[]): CuratedModelMetadataV1[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.provider}:${entry.providerModelId}`;
    if (seen.has(key)) throw new Error(`Duplicate curated model metadata: ${key}`);
    seen.add(key);
  }
  return entries;
}
