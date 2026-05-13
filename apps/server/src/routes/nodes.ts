import type { FastifyInstance } from "fastify";
import { builtInNodeManifests, getInstalledNodesDirectory, loadInstalledNodeManifests, nodeManifestToCatalogEntry } from "@snarkroute/nodes";
import { providerNodeManifests } from "../providers/provider-node-manifests";

export async function registerNodeCatalogRoutes(app: FastifyInstance) {
app.get("/api/nodes", async () => {
  const installed = await loadInstalledNodeManifests();
  return {
    nodes: [
      ...builtInNodeManifests.map(nodeManifestToCatalogEntry),
      ...providerNodeManifests().map(nodeManifestToCatalogEntry),
      ...installed.filter((manifest) => manifest.enabled !== false).map(nodeManifestToCatalogEntry)
    ],
    installedDirectory: getInstalledNodesDirectory()
  };
});
}
