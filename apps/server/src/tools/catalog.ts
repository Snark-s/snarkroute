import { builtInNodeManifests, loadInstalledNodeManifests, portableToolFromManifest } from "@snarkroute/nodes";
import { loadCanvasActionManifests } from "../canvas-actions/service";
import { providerNodeManifests } from "../providers/provider-node-manifests";

export async function publishedTools() {
  const manifests = [
    ...builtInNodeManifests,
    ...providerNodeManifests(),
    ...await loadInstalledNodeManifests(),
    ...await loadCanvasActionManifests()
  ];
  const seen = new Set<string>();
  const tools: Array<{ tool: NonNullable<ReturnType<typeof portableToolFromManifest>["tool"]>; source: "explicit" | "legacy" }> = [];
  const diagnostics: Array<{ id: string; title: string; source: "explicit" | "legacy"; issues: ReturnType<typeof portableToolFromManifest>["issues"] }> = [];
  for (const manifest of manifests) {
    if (manifest.enabled === false || seen.has(manifest.id)) continue;
    seen.add(manifest.id);
    const result = portableToolFromManifest(manifest);
    if (result.source === "none") continue;
    if (result.ok && result.tool) tools.push({ tool: result.tool, source: result.source });
    else diagnostics.push({ id: manifest.id, title: manifest.title, source: result.source, issues: result.issues });
  }
  return { tools, diagnostics };
}

export async function publishedTool(id: string) {
  const catalog = await publishedTools();
  return catalog.tools.find((candidate) => candidate.tool.id === id) ?? null;
}
