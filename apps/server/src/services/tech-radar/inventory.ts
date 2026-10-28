import { join } from "node:path";
import { repoRoot } from "../../server-paths";
import { serviceEndpointRegistry } from "../local-service-endpoints";
import { providerNodeManifests } from "../../providers/provider-node-manifests";
import type { CapabilityEntry, Catalog, InventoryTool } from "./types";

export const CAPABILITIES: Record<string, string> = {
  "image-generation": "Генерация изображений", "image-editing": "Редактирование изображений по референсам",
  "image-to-video": "Видео по изображению", "text-to-video": "Видео по тексту", "multi-character-video": "Видео с несколькими персонажами",
  "camera-control": "Управление камерой", "character-consistency": "Сохранение идентичности персонажей",
  "storyboarding": "Автоматическая раскадровка", "music-shot-planning": "Планирование кадров под музыку",
  "music-generation": "Генерация музыки", "local-tts": "Локальный синтез речи", "automatic-editing": "Автоматический монтаж",
  "blender-agents": "Управление Blender через агентов", "unreal-agents": "Управление Unreal Engine через агентов",
  "touchdesigner-agents": "Управление TouchDesigner через агентов", "image-upscale": "Увеличение изображений",
  "video-upscale": "Увеличение видео", "fulldome": "Fulldome и сферическое видео", "projection-mapping": "Проекционный мэппинг",
  "generative-graphics": "Генеративная графика", "autonomous-agents": "Автономные агенты"
};

/** Mapping describes declared adapter functionality, never health, installed weights or a successful run. */
export async function workshopInventory(): Promise<InventoryTool[]> {
  const registry = serviceEndpointRegistry();
  const mapping: Record<string, { name: string; caps: string[]; file: string }> = {
    flux3_native: { name: "FLUX.3 Native", caps: ["image-generation", "image-editing"], file: "apps/server/src/providers/flux3-native.ts" },
    qwen_edit: { name: "Qwen Image Edit", caps: ["image-editing"], file: "apps/server/src/providers/qwen-edit-local.ts" },
    h3_worker: { name: "MiniMax H3", caps: ["text-to-video", "image-to-video", "multi-character-video", "camera-control"], file: "packages/adapters/h3/src/index.ts" },
    yue2: { name: "YuE2", caps: ["music-generation"], file: "apps/server/src/services/yue2-local.ts" },
    local_upscale: { name: "Local Upscale", caps: ["image-upscale"], file: "packages/adapters/local-upscale/src/index.ts" },
    mixar_bridge: { name: "Mixar / Blender bridge", caps: ["blender-agents"], file: "docs/CONNECTING-NEW-ENTITY.md" },
    factory: { name: "Factory", caps: ["autonomous-agents"], file: "docs/CONNECTING-NEW-ENTITY.md" }
  };
  const tools: InventoryTool[] = Object.entries(mapping).filter(([id]) => id in registry.services).map(([id, entry]) => ({
    id: `local:${id}`, name: entry.name, capabilityIds: entry.caps, evidence: "declared", source: join(repoRoot, entry.file), availability: "unverified"
  }));
  // Some local processors have a declarative node but no long-lived service/port.
  const nodeCapabilities: Record<string, string[]> = { local_video_upscale: ["video-upscale"] };
  for (const node of providerNodeManifests()) if (nodeCapabilities[node.id]) tools.push({ id: `node:${node.id}`, name: node.title, capabilityIds: nodeCapabilities[node.id], evidence: "declared", source: join(repoRoot, "apps/server/src/providers/provider-node-manifests.ts"), availability: "unverified" });
  return tools;
}

export function capabilityCatalog(state: Catalog): CapabilityEntry[] {
  const entries = new Map<string, CapabilityEntry>(Object.entries(CAPABILITIES).map(([id, name]) => [id, { id, name, providers: [] }]));
  for (const tool of state.inventory) for (const id of tool.capabilityIds) {
    const entry = entries.get(id) ?? { id, name: id, providers: [] };
    entry.providers.push({ id: tool.id, name: tool.name, local: true, evidence: tool.evidence, source: tool.source }); entries.set(id, entry);
  }
  for (const project of state.projects) {
    const research = project.research.at(-1); if (!research) continue;
    for (const capability of research.analysis.capabilities) {
      const entry = entries.get(capability.id) ?? { id: capability.id, name: capability.name, providers: [] };
      entry.providers.push({ id: project.id, name: project.name, local: false, evidence: capability.evidence, source: project.canonicalUrl }); entries.set(entry.id, entry);
    }
  }
  return [...entries.values()];
}
