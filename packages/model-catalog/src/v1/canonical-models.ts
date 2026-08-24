import type { ModelIOContract, ModelIOInputSlot, ModelIOItem } from "@snarkroute/protocol";
import type { ModelCatalogEntryV1, ModelOptionForNodeV1, ModelProviderRouteV1 } from "./types.js";

type ProviderIdentity = Pick<ModelCatalogEntryV1, "provider" | "providerModelId" | "originVendor" | "displayName" | "canonicalModelId">;

const explicitCanonicalIds = new Map<string, string>([
  ["kie:gpt-5-2", "gpt-5.2"],
  ["openrouter:openai/gpt-5.2", "gpt-5.2"],
  ["kie:bytedance/seedance-2", "seedance-2.0"],
  ["polza:bytedance/seedance-2", "seedance-2.0"],
  ["openrouter:bytedance/seedance-2", "seedance-2.0"],
  ["openrouter:bytedance/seedance-2.0", "seedance-2.0"],
  ["polza:bytedance/seedance-2.0", "seedance-2.0"],
  ["openrouter:kwaivgi/kling-3.0-pro", "kling-3.0-pro"],
  ["openrouter:kwaivgi/kling-v3.0-pro", "kling-3.0-pro"],
  ["polza:kling-v3-pro", "kling-3.0-pro"],
  ["kie:kling-3.0/video", "kling-3.0-pro"],
  ["kie:kling-3-pro", "kling-3.0-pro"],
  ["openrouter:kwaivgi/kling-3.0-std", "kling-3.0-standard"],
  ["openrouter:kwaivgi/kling-v3.0-std", "kling-3.0-standard"],
  ["polza:kling/v3", "kling-3.0-standard"],
  ["openrouter:google/gemini-3.1-flash-image-preview", "nano-banana-2"],
  ["openrouter:google/gemini-3.1-flash-image", "nano-banana-2"],
  ["polza:google/gemini-3.1-flash-image-preview", "nano-banana-2"],
  ["polza:google/gemini-3.1-flash-image", "nano-banana-2"],
  ["gemini:image.nano-banana", "nano-banana-2"],
  ["gemini:gemini-3.1-flash-image-preview", "nano-banana-2"],
  ["openrouter:google/gemini-3-pro-image-preview", "nano-banana-pro"],
  ["openrouter:google/gemini-3-pro-image", "nano-banana-pro"],
  ["polza:google/gemini-3-pro-image-preview", "nano-banana-pro"],
  ["polza:google/gemini-3-pro-image", "nano-banana-pro"],
  ["gemini:gemini-3-pro-image-preview", "nano-banana-pro"],
  ["kie:nano-banana-pro", "nano-banana-pro"],
  ["openrouter:bytedance/seedream-5-lite", "seedream-5-lite"],
  ["polza:bytedance/seedream-5-lite", "seedream-5-lite"],
  ["kie:bytedance/seedream-5-lite", "seedream-5-lite"],
  ["kie:wan/2-6-text-to-video", "wan-2.6"],
  ["kie:wan/2-6-image-to-video", "wan-2.6"],
  ["polza:wan/2.6", "wan-2.6"],
  ["openrouter:alibaba/wan-2.6", "wan-2.6"],
  ["openrouter:google/veo-3.1", "veo-3.1"],
  ["openrouter:google/veo-3.1-fast", "veo-3.1-fast"],
  ["polza:google/veo-3.1", "veo-3.1"],
  ["polza:google/veo-3.1-fast", "veo-3.1-fast"]
]);

const canonicalDisplayNames = new Map<string, string>([
  ["kling-3.0-standard", "Kling 3.0 Standard"],
  ["wan-2.6", "Wan 2.6"]
]);

export function canonicalModelIdForProviderModelV1(model: ProviderIdentity): string {
  if (model.canonicalModelId?.trim()) return model.canonicalModelId.trim();
  const key = `${String(model.provider).toLowerCase()}:${model.providerModelId.trim().toLowerCase()}`;
  return explicitCanonicalIds.get(key) ?? `${String(model.originVendor || model.provider).toLowerCase()}:${model.providerModelId.trim().toLowerCase()}`;
}

export function legacyProviderRouteForModelV1(model: ModelOptionForNodeV1): ModelProviderRouteV1 {
  return {
    provider: model.provider,
    providerModelId: model.providerModelId,
    storedModelId: model.storedModelId,
    availability: model.availability,
    inputTypes: [...model.inputTypes],
    outputTypes: [...model.outputTypes],
    capabilities: [...model.capabilities],
    parameters: model.parameters.map((parameter) => ({ ...parameter })),
    pricing: model.pricing,
    constraints: objectRecord(model.metadata?.providerConstraints),
    metadata: model.metadata,
    ioContract: model.ioContract
  };
}

export function groupCanonicalModelOptionsV1(options: ModelOptionForNodeV1[]): ModelOptionForNodeV1[] {
  const groups = new Map<string, ModelOptionForNodeV1[]>();
  for (const option of options) {
    const canonicalModelId = canonicalModelIdForProviderModelV1(option);
    const current = groups.get(canonicalModelId) ?? [];
    current.push({ ...option, canonicalModelId });
    groups.set(canonicalModelId, current);
  }
  return [...groups.entries()].map(([canonicalModelId, entries]) => {
    const ordered = [...entries].sort((left, right) => providerOrder(left.provider) - providerOrder(right.provider));
    const representative = ordered[0];
    const providerRoutes = ordered.map(legacyProviderRouteForModelV1);
    const hasMultipleRoutes = providerRoutes.length > 1;
    const hasDeclaredCanonicalIdentity = hasMultipleRoutes || ordered.some((entry) => canonicalModelId !== fallbackCanonicalModelId(entry));
    const ioContract = mergeIOContracts(ordered.map((entry) => entry.ioContract ?? entry.inputContract));
    const image = ioContract?.inputs?.find((item) => item.kind === "image");
    const requiredImageInputs = itemMinimum(image);
    const maximumImageInputs = image?.maxItems;
    return {
      ...representative,
      id: hasDeclaredCanonicalIdentity ? canonicalModelId : representative.storedModelId || representative.id,
      canonicalModelId,
      displayName: canonicalDisplayNames.get(canonicalModelId) ?? representative.displayName,
      storedModelId: representative.storedModelId,
      providerRoutes,
      capabilities: union(ordered.map((entry) => entry.capabilities)),
      inputTypes: union(ordered.map((entry) => entry.inputTypes)),
      outputTypes: union(ordered.map((entry) => entry.outputTypes)),
      roles: union(ordered.map((entry) => entry.roles)),
      ioContract,
      inputContract: ioContract,
      requiredImageInputs,
      maximumImageInputs,
      optionalImageInputs: image ? maximumImageInputs === undefined ? undefined : Math.max(0, maximumImageInputs - requiredImageInputs) : 0,
      inputRoles: union((image?.slots ?? []).map((slot) => [slot.role])),
      runnableWithSuppliedInputs: (ioContract?.inputs ?? []).every((item) => !["image", "video", "audio"].includes(item.kind) || itemMinimum(item) === 0),
      pricing: hasMultipleRoutes ? undefined : representative.pricing,
      metadata: { ...(representative.metadata ?? {}), canonical: true, providerCount: providerRoutes.length }
    };
  });
}

function fallbackCanonicalModelId(model: ProviderIdentity): string {
  return `${String(model.originVendor || model.provider).toLowerCase()}:${model.providerModelId.trim().toLowerCase()}`;
}

function union<T>(sets: T[][]): T[] {
  return [...new Set(sets.flat())];
}

function mergeIOContracts(contracts: Array<ModelIOContract | undefined>): ModelIOContract | undefined {
  if (!contracts.some(Boolean)) return undefined;
  return {
    inputs: mergeIOItems(contracts.map((contract) => contract?.inputs ?? [])),
    outputs: mergeIOItems(contracts.map((contract) => contract?.outputs ?? []))
  };
}

function mergeIOItems(itemSets: ModelIOItem[][]): ModelIOItem[] {
  const kinds = union(itemSets.map((items) => items.map((item) => item.kind)));
  return kinds.map((kind) => {
    const matching = itemSets.map((items) => items.find((item) => item.kind === kind));
    const present = matching.filter((item): item is ModelIOItem => Boolean(item));
    const base = present[0];
    const { minItems: _minItems, maxItems: _maxItems, required: _required, roles: _roles, slots: _slots, ...rest } = base;
    const minItems = Math.min(...matching.map(itemMinimum));
    const maxItems = present.some((item) => item.maxItems === undefined)
      ? undefined
      : Math.max(0, ...present.map((item) => item.maxItems ?? 0));
    const roles = union(present.map((item) => item.roles ?? []));
    const slots = mergeIOSlots(matching.map((item) => item?.slots ?? []));
    return {
      ...rest,
      kind,
      minItems,
      ...(maxItems === undefined ? {} : { maxItems }),
      required: minItems > 0,
      ...(roles.length ? { roles } : {}),
      ...(slots.length ? { slots } : {})
    };
  });
}

function mergeIOSlots(slotSets: ModelIOInputSlot[][]): ModelIOInputSlot[] {
  const identities = union(slotSets.map((slots) => slots.map((slot) => `${slot.id}\u0000${slot.role}`)));
  return identities.map((identity) => {
    const matching = slotSets.map((slots) => slots.find((slot) => `${slot.id}\u0000${slot.role}` === identity));
    const present = matching.filter((slot): slot is ModelIOInputSlot => Boolean(slot));
    const base = present[0];
    const { minItems: _minItems, maxItems: _maxItems, required: _required, ...rest } = base;
    const minItems = Math.min(...matching.map(itemMinimum));
    const maxItems = present.some((slot) => slot.maxItems === undefined)
      ? undefined
      : Math.max(0, ...present.map((slot) => slot.maxItems ?? 0));
    return {
      ...rest,
      minItems,
      ...(maxItems === undefined ? {} : { maxItems }),
      required: minItems > 0
    };
  });
}

function itemMinimum(item: { minItems?: number; required?: boolean } | undefined): number {
  return item?.minItems ?? (item?.required ? 1 : 0);
}

function providerOrder(provider: string): number {
  if (provider === "kie") return 0;
  if (provider === "polza") return 1;
  if (provider === "openrouter") return 2;
  return 3;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
