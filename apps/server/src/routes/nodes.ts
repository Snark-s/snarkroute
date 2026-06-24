import type { FastifyInstance } from "fastify";
import { builtInNodeManifests, getInstalledNodesDirectory, loadInstalledNodeManifests, nodeManifestToCatalogEntry, type SnarkNodeManifest } from "@snarkroute/nodes";
import { providerNodeManifests } from "../providers/provider-node-manifests";
import { loadCanvasActionManifests } from "../canvas-actions/service";

export async function registerNodeCatalogRoutes(app: FastifyInstance) {
app.get("/api/nodes", async () => {
  const installed = await loadInstalledNodeManifests();
  const reservedIds = new Set([...builtInNodeManifests, ...providerNodeManifests()].map((manifest) => manifest.id));
  return {
    nodes: [
      ...builtInNodeManifests.map(nodeManifestToCatalogEntry),
      ...providerNodeManifests().map(nodeManifestToCatalogEntry),
      ...installed.filter((manifest) => manifest.enabled !== false && !reservedIds.has(manifest.id)).map(nodeManifestToCatalogEntry)
    ],
    installedDirectory: getInstalledNodesDirectory()
  };
});

app.get("/api/nodes/canvas-actions", async () => {
  const manifests = [
    ...builtInNodeManifests,
    ...providerNodeManifests(),
    ...await loadInstalledNodeManifests(),
    ...await loadCanvasActionManifests()
  ];
  const seen = new Set<string>();
  return {
    actions: manifests
      .filter(isCanvasActionManifest)
      .filter((manifest) => {
        if (seen.has(manifest.id)) return false;
        seen.add(manifest.id);
        return true;
      })
      .map((manifest) => ({
        id: manifest.id,
        title: manifest.canvasAction?.title?.trim() || manifest.title,
        description: manifest.canvasAction?.description ?? manifest.description ?? "",
        inputType: manifest.inputs[0].type,
        outputs: manifest.outputs.map((output) => ({ id: output.id, type: output.type, label: output.label ?? output.id })),
        params: manifest.params ?? [],
        icon: manifest.canvasAction?.icon ?? (manifest.icon ? { kind: "preset", name: manifest.icon } : undefined),
        node: nodeManifestToCatalogEntry(manifest)
      }))
  };
});
}

function isCanvasActionManifest(manifest: SnarkNodeManifest): boolean {
  return manifest.enabled !== false
    && manifest.canvasAction?.enabled === true
    && manifest.inputs.length === 1
    && isCanvasActionPortType(manifest.inputs[0].type)
    && manifest.outputs.length > 0
    && manifest.outputs.every((output) => isCanvasActionPortType(output.type));
}

function isCanvasActionPortType(value: string): boolean {
  return value === "image" || value === "video" || value === "audio" || value === "text";
}
