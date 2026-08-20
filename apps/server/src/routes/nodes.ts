import type { FastifyInstance } from "fastify";
import { builtInNodeManifests, getInstalledNodesDirectory, loadInstalledNodeManifests, nodeManifestToCatalogEntry, type PortableToolHost, type SnarkNodeManifest } from "@snarkroute/nodes";
import { providerNodeManifests } from "../providers/provider-node-manifests";
import { loadCanvasActionManifests } from "../canvas-actions/service";
import { publishedTools } from "../tools/catalog";

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

app.get<{ Querystring: { surface?: "livingCanvas" | "brandeshmyg" } }>("/api/nodes/canvas-actions", async (request) => {
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
      .filter((manifest) => supportsCanvasActionSurface(manifest, request.query.surface))
      .filter((manifest) => {
        if (seen.has(manifest.id)) return false;
        seen.add(manifest.id);
        return true;
      })
      .map((manifest) => ({
        id: manifest.id,
        title: manifest.canvasAction?.title?.trim() || manifest.title,
        description: manifest.canvasAction?.description ?? manifest.description ?? "",
        inputType: canvasActionInputType(manifest),
        inputs: manifest.inputs.map((input) => ({ id: input.id, type: input.type, label: input.label ?? input.id, required: input.required })),
        outputs: manifest.outputs.map((output) => ({ id: output.id, type: output.type, label: output.label ?? output.id })),
        params: canvasActionParams(manifest, manifests),
        dialog: manifest.canvasAction?.dialog,
        poseBindings: manifest.canvasAction?.poseBindings,
        icon: manifest.canvasAction?.icon ?? (manifest.icon ? { kind: "preset", name: manifest.icon } : undefined),
        node: nodeManifestToCatalogEntry(manifest)
      }))
  };
});

app.get<{ Querystring: { host?: PortableToolHost } }>("/api/tools", async (request, reply) => {
  if (request.query.host && !["boojumroute", "after_effects", "photoshop"].includes(request.query.host)) return reply.code(400).send({ ok: false, error: "Unsupported tool host." });
  const published = await publishedTools();
  return {
    ok: true,
    schemaVersion: "1.0",
    tools: published.tools.filter((entry) => !request.query.host || entry.tool.hosts.some((contract) => contract.host === request.query.host)),
    diagnostics: published.diagnostics
  };
});

app.get<{ Params: { id: string } }>("/api/tools/:id", async (request, reply) => {
  if (!/^[A-Za-z0-9._-]+$/.test(request.params.id)) return reply.code(400).send({ ok: false, error: "Invalid tool id." });
  const published = await publishedTools();
  const entry = published.tools.find((candidate) => candidate.tool.id === request.params.id);
  if (entry) return { ok: true, ...entry };
  const diagnostic = published.diagnostics.find((candidate) => candidate.id === request.params.id);
  if (diagnostic) return reply.code(422).send({ ok: false, id: request.params.id, diagnostics: diagnostic.issues });
  return reply.code(404).send({ ok: false, error: `Tool "${request.params.id}" was not found.` });
});
}

function isCanvasActionManifest(manifest: SnarkNodeManifest): boolean {
  return manifest.enabled !== false
    && manifest.canvasAction?.enabled === true
    && manifest.inputs.length > 0
    && manifest.inputs.every((input) => isCanvasActionPortType(input.type))
    && manifest.outputs.length > 0
    && manifest.outputs.every((output) => isCanvasActionPortType(output.type));
}

function isCanvasActionPortType(value: string): boolean {
  return value === "image" || value === "video" || value === "audio" || value === "text";
}

function supportsCanvasActionSurface(manifest: SnarkNodeManifest, surface?: "livingCanvas" | "brandeshmyg"): boolean {
  if (!surface) return true;
  const declared = manifest.canvasAction?.surface;
  if (declared) return declared === surface;
  return surface === "brandeshmyg" || manifest.inputs.length === 1;
}

function canvasActionInputType(manifest: SnarkNodeManifest): "image" | "video" | "audio" | "text" {
  return manifest.inputs.find((input) => isCanvasActionPortType(input.type))!.type as "image" | "video" | "audio" | "text";
}

export function canvasActionParams(manifest: SnarkNodeManifest, manifests: SnarkNodeManifest[]): NonNullable<SnarkNodeManifest["params"]> {
  const generated = manifest.generatedWith && typeof manifest.generatedWith === "object"
    ? manifest.generatedWith as { subroute?: { nodes?: Array<{ id?: string; type?: string }> } }
    : undefined;
  const internalTypeById = new Map((generated?.subroute?.nodes ?? []).flatMap((node) =>
    typeof node.id === "string" && typeof node.type === "string" ? [[node.id, node.type] as const] : []
  ));
  const manifestById = new Map(manifests.map((candidate) => [candidate.id, candidate]));
  return (manifest.params ?? []).map((param) => {
    if (param.options?.length || !param.binding) return param;
    const internalType = internalTypeById.get(param.binding.nodeId);
    const declared = internalType
      ? manifestById.get(internalType)?.params?.find((candidate) => candidate.id === param.binding?.paramId)
      : undefined;
    return declared?.options?.length ? { ...param, options: declared.options } : param;
  });
}
