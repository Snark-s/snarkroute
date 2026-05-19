import type { FastifyInstance } from "fastify";
import { builtInNodeManifests, getInstalledNodesDirectory, loadInstalledNodeManifests, nodeManifestToCatalogEntry } from "@snarkroute/nodes";
import { providerNodeManifests } from "../providers/provider-node-manifests";

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
}
