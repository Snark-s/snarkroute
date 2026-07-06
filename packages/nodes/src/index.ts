import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, join, parse } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { NodeRunner, RouteExecutor } from "@snarkroute/executor";
import type { RouteNode, ValidationIssue } from "@snarkroute/protocol";
import {
  buildDialogueWorkbenchOutputs,
  normalizeDialogueWorkbenchState,
  type DialogueWorkbenchState
} from "@snarkroute/protocol";
export * from "./package-system";
import type { SnarkNodeManifest } from "./package-system";

export interface NodeDefinition {
  type: string;
  title: string;
  description: string;
  economics?: NodeEconomicsMetadata;
  capabilities?: Array<{ id: string; title?: string; defaultParams?: Record<string, unknown>; priority?: number }>;
  manifest?: SnarkNodeManifest;
}

export interface NodeEconomicsMetadata {
  author?: {
    id?: string;
    name?: string;
    wallet?: string | null;
    did?: string | null;
  };
  license?: string;
  suggestedShare?: number;
  pricingHint?: string;
  notes?: string;
}

export interface PromptLibraryPrompt {
  id: string;
  title: string;
  category: string;
  description?: string;
  negativePrompt?: string;
  tags?: string[];
  kind?: string;
  status?: string;
  previewImage?: string;
  source?: Record<string, unknown>;
  modelHints?: string[];
  ref: string;
  path: string;
  text: string;
}

export interface PromptLibraryCategory {
  id: string;
  title: string;
  prompts: PromptLibraryPrompt[];
}

export interface PromptLibrary {
  categories: PromptLibraryCategory[];
  diagnostics: PromptLibraryDiagnostic[];
}

export interface PromptLibraryDiagnostic {
  path: string;
  message: string;
  severity: "warning" | "error";
}

export type ResourceLibraryKind = "character" | "location" | "style" | "promptPreset";

export interface ResourceLibraryItem {
  id: string;
  kind: ResourceLibraryKind | string;
  title: string;
  description?: string;
  tags?: string[];
  prompt?: string;
  ref: string;
  path: string;
}

export interface ResourceLibrary {
  resources: ResourceLibraryItem[];
  diagnostics: PromptLibraryDiagnostic[];
}

export const builtInNodeDefinitions: NodeDefinition[] = [
  { type: "input.text", title: "Text Input", description: "Produces a text value from params.value.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "input.file", title: "Input File", description: "Reads metadata for a local file path.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "input.image", title: "Input Image", description: "Reads metadata and dimensions for a local image path.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "input.video", title: "Input Video", description: "Reads metadata for a local video path.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "capability.image.create", title: "Create Image", description: "User-facing image creation task that selects a supporting provider at execution time.", economics: { license: "AGPL-3.0-or-later", notes: "Capability layer only; provider economics are preserved." } },
  { type: "capability.image.edit", title: "Edit Image", description: "User-facing image editing task that selects a supporting provider at execution time.", economics: { license: "AGPL-3.0-or-later", notes: "Capability layer only; provider economics are preserved." } },
  { type: "capability.image.upscale", title: "Upscale Image", description: "User-facing image upscale task that selects a supporting provider at execution time.", economics: { license: "AGPL-3.0-or-later", notes: "Capability layer only; provider economics are preserved." } },
  { type: "capability.video.animate", title: "Animate Video", description: "User-facing video animation task that selects a supporting provider at execution time.", economics: { license: "AGPL-3.0-or-later", notes: "Capability layer only; provider economics are preserved." } },
  { type: "capability.character.create", title: "Create Character", description: "Creates or resolves a reusable character resource for routes.", economics: { license: "AGPL-3.0-or-later", notes: "Local resource metadata only; no marketplace or payment execution." } },
  { type: "capability.location.create", title: "Create Location", description: "Creates or resolves a reusable location resource for routes.", economics: { license: "AGPL-3.0-or-later", notes: "Local resource metadata only; no marketplace or payment execution." } },
  { type: "library.prompt", title: "Prompt Library", description: "Outputs a saved local prompt or embedded text snippet.", economics: { license: "AGPL-3.0-or-later", notes: "Local library only; no marketplace or payment execution." } },
  { type: "dialogue.workbench", title: "Dialogue Workbench", description: "Stores a large manual/model-assisted conversation and exposes transcript, capsule, and selected outputs.", economics: { license: "AGPL-3.0-or-later", notes: "Manual artifact node by default; no hidden model calls during graph execution." } },
  { type: "text.promptCompose", title: "Prompt Compose", description: "Combines multiple text inputs into one prompt.", economics: { license: "AGPL-3.0-or-later", notes: "Local text transform only; no payment execution." } },
  { type: "preview.image", title: "Image Preview", description: "Passes through an image value for Studio preview.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "preview.panorama360", title: "360 Panorama Viewer", description: "Passes through an equirectangular panorama image for interactive Studio viewing.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "transform.chooseCameraPoint", title: "Выбрать точку камеры", description: "Creates a cached World Labs Marble draft world from a 360 equirectangular panorama, stores camera pose, and emits a perspective image artifact.", economics: { license: "AGPL-3.0-or-later", notes: "World Labs provider metadata only; API keys are read from server environment variables." } },
  { type: "transform.imageResize", title: "Resize Image", description: "Resizes a local PNG image with optional aspect-ratio preservation.", economics: { license: "AGPL-3.0-or-later", notes: "Local image transform only; no payment execution." } },
  { type: "transform.panorama360ToFisheye", title: "360 Panorama to Fisheye", description: "Projects a local equirectangular 360 panorama PNG into a circular fisheye image with a configurable field of view.", economics: { license: "AGPL-3.0-or-later", notes: "Local image transform only; no payment execution." } },
  { type: "transform.template", title: "Template Transform", description: "Produces text from params.template after route template resolution.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "debug.log", title: "Debug Log", description: "Logs a message or value and passes the value through.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "utility.null", title: "Null", description: "Passes any input through unchanged.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "http.request", title: "HTTP Request", description: "Calls an arbitrary HTTP API through the backend.", economics: { license: "AGPL-3.0-or-later", notes: "Generic API executor; no tokens are stored by this node." } },
  {
    type: "local.stableDiffusion.textToImage",
    title: "Local Stable Diffusion",
    description: "Calls a local Stable Diffusion WebUI-compatible txt2img API.",
    economics: { license: "AGPL-3.0-or-later", notes: "Local executor metadata only; no payment execution." },
    capabilities: [{ id: "image.create", title: "Create Image", priority: 10 }]
  },
  {
    type: "ai.image.sd15.qr_monster_hidden_control",
    title: "Double Image Illusion",
    description: "Generates double-image hidden-picture or QR illusions through a local Automatic1111 API with ControlNet QR Code Monster.",
    economics: { license: "AGPL-3.0-or-later", notes: "Local executor metadata only; no payment execution." },
    capabilities: [{ id: "image.create", title: "Create Image", priority: 9 }]
  },
  { type: "output.text", title: "Text Output", description: "Displays text or JSON output without writing a file.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "output.file", title: "Output File", description: "Writes text or JSON to the local run folder.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } }
];

export const builtInNodeManifests: SnarkNodeManifest[] = builtInNodeDefinitions.map((definition) => ({
  kind: "snarkroute.node",
  schemaVersion: "0.1",
  id: definition.type,
  title: definition.title,
  version: "0.1.0",
  author: { name: "SnarkRoute maintainers" },
  license: definition.economics?.license ?? "AGPL-3.0-or-later",
  origin: "bundled",
  source: "snarkroute-core",
  category: builtInNodeCategory(definition.type),
  description: definition.description,
  permissions: builtInPermissions(definition.type),
  executor: { type: "builtin", runtime: "builtin", builtinRunner: definition.type },
  inputs: builtInInputs(definition.type),
  outputs: builtInOutputs(definition.type),
  params: builtInParams(definition.type),
  ui: builtInUi(definition.type),
  capabilities: definition.capabilities
}));

for (const definition of builtInNodeDefinitions) {
  definition.manifest = builtInNodeManifests.find((manifest) => manifest.id === definition.type);
}

export const inputTextRunner: NodeRunner = ({ params }) => ({
  output: {
    text: String(params.value ?? "")
  }
});

export const inputFileRunner: NodeRunner = async ({ params }) => ({
  output: await getLocalAssetMetadata(String(params.path ?? ""), "file")
});

export const inputImageRunner: NodeRunner = async ({ params }) => ({
  output: await getLocalAssetMetadata(String(params.path ?? ""), "image")
});

export const inputVideoRunner: NodeRunner = async ({ params }) => ({
  output: await getLocalAssetMetadata(String(params.path ?? ""), "video")
});

export const promptLibraryRunner: NodeRunner = async ({ params }) => ({
  output: {
    text: await resolvePromptLibraryText(params)
  }
});

export const promptComposeRunner: NodeRunner = ({ params, inputs }) => ({
  output: {
    text: composePromptText(params, inputs)
  }
});

export const dialogueWorkbenchRunner: NodeRunner = ({ node, params, inputs }) => {
  const state = normalizeDialogueWorkbenchState(params.state, {
    nodeId: node.id,
    defaultModelProfileId: stringParam(params.defaultModelProfileId)
  });
  const parentConversationCapsules = [
    ...(state.parentConversationCapsules ?? []),
    ...inputTextParts(inputs.context).flatMap((value) => {
      if (value && typeof value === "object" && "compactSummary" in value && "conversationId" in value) return [value];
      return [];
    })
  ] as DialogueWorkbenchState["parentConversationCapsules"];
  const outputState: DialogueWorkbenchState = parentConversationCapsules?.length ? { ...state, parentConversationCapsules } : state;
  const outputs = buildDialogueWorkbenchOutputs({
    nodeId: node.id,
    nodeTitle: node.title,
    state: outputState,
    inputs
  });
  return {
    output: outputs,
    logs: ["Dialogue Workbench emitted saved transcript, capsule, and selected outputs. No model calls were made during route execution."],
    provenance: { dialogueWorkbench: true, conversationId: outputState.conversationId }
  };
};

export const previewImageRunner: NodeRunner = ({ params, inputs }) => {
  const image = normalizePreviewImage(params.image ?? firstInputValue(inputs));
  return {
    output: { image }
  };
};

export const previewPanorama360Runner: NodeRunner = async ({ node, params, inputs, context }) => {
  const sourceValue = params.image ?? firstInputValue(inputs);
  const panorama = normalizePreviewImage(sourceValue);
  const source = await readLocalPngImage(sourceValue, "preview.panorama360");
  const fov = clampedNumberParam(params.fov, 55, 1, 120, "fov");
  const yaw = numberParam(params.yaw, 0);
  const pitch = clampedNumberParam(params.pitch, 0, -89, 89, "pitch");
  const width = Math.max(1, source.height);
  const height = Math.max(1, Math.round(width * 9 / 16));
  const frame = projectEquirectangularToPerspective(source, { width, height, fovDegrees: fov, yawDegrees: yaw, pitchDegrees: pitch });
  const bytes = encodeRgbaPng(width, height, frame.data);
  const assetsDirectory = join(context.outputDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const filename = `${sanitizeFilename(node.id)}-view-${Date.now()}.png`;
  const localPath = join(assetsDirectory, filename);
  await writeFile(localPath, bytes);
  return { output: { image: { localPath, path: localPath, filename, mimeType: "image/png", width, height }, panorama, view: { yaw, pitch, fov } } };
};

export const chooseCameraPointRunner: NodeRunner = ({ params, inputs }) => {
  const rawRenderedImage = params.renderedImage ?? params.outputImage;
  const renderedImage = rawRenderedImage ? normalizePreviewImage(rawRenderedImage) : null;
  const rawPanoramaImage = params.renderedPanorama ?? params.panoramaImage ?? params.outputPanorama;
  const renderedPanorama = rawPanoramaImage ? normalizePreviewImage(rawPanoramaImage) : null;
  const marbleWorld = params.pinnedMarbleWorld ?? params.marbleWorld;
  const worldPanoUrl = marbleWorldPanoramaUrl(marbleWorld);
  if (String(params.outputMode ?? "perspective") === "equirectangular" && worldPanoUrl) {
    const image = normalizePreviewImage({ originalUrl: worldPanoUrl, filename: "world-panorama.jpg" });
    return {
      output: {
        image,
        view: renderedImage,
        panorama: image,
        panoramaMetadata: { projection: "equirectangular" },
        cameraPose: params.cameraPose,
        output: { mode: "equirectangular" },
        marbleWorld
      },
      provenance: { provider: "worldlabs-marble", transform: "chooseCameraPoint", renderMode: "equirectangular" }
    };
  }
  const inputImage = normalizePreviewImage(params.image ?? inputs.image ?? firstInputValue(inputs));
  if (renderedImage) {
    return {
      output: {
        image: renderedImage,
        view: renderedImage,
        panorama: renderedPanorama,
        panoramaMetadata: renderedPanorama ? { projection: "equirectangular" } : undefined,
        cameraPose: params.cameraPose,
        output: params.output,
        marbleWorld
      },
      provenance: { provider: "worldlabs-marble", transform: "chooseCameraPoint", renderMode: "perspective" }
    };
  }
  return {
    output: {
      image: inputImage,
      view: inputImage,
      panorama: renderedPanorama,
      panoramaMetadata: renderedPanorama ? { projection: "equirectangular" } : undefined,
      warning: "Choose Camera Point has no rendered perspective image yet. Use the Studio viewer to render a frame.",
      cameraPose: params.cameraPose,
      output: params.output,
      marbleWorld
    },
    provenance: { provider: "worldlabs-marble", transform: "chooseCameraPoint", renderMode: "pending" }
  };
};

function marbleWorldPanoramaUrl(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const assets = record.assets && typeof record.assets === "object" && !Array.isArray(record.assets) ? record.assets as Record<string, unknown> : {};
  const imagery = assets.imagery && typeof assets.imagery === "object" && !Array.isArray(assets.imagery) ? assets.imagery as Record<string, unknown> : {};
  const url = record.panoUrl ?? record.pano_url ?? imagery.pano_url ?? imagery.panoUrl;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

export const imageResizeRunner: NodeRunner = async ({ node, params, inputs, context }) => {
  const source = await readLocalPngImage(params.image ?? inputs.image ?? firstInputValue(inputs), "transform.imageResize");
  const preserveAspectRatio = params.preserveAspectRatio !== false;
  const requestedWidth = optionalNumberParam(params.width, "width");
  const requestedHeight = optionalNumberParam(params.height, "height");
  const { width, height } = resolveResizeDimensions(source, {
    width: requestedWidth,
    height: requestedHeight,
    preserveAspectRatio
  });
  const resized = resizeRgbaImage(source, width, height, "Just Resize");
  const bytes = encodeRgbaPng(resized.width, resized.height, resized.data);
  const assetsDirectory = join(context.outputDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const filename = `${sanitizeFilename(node.id)}-resize-${Date.now()}.png`;
  const localPath = join(assetsDirectory, filename);
  await writeFile(localPath, bytes);

  const upscaled = width > source.width || height > source.height;
  const warnings = upscaled
    ? [`Upscaling from ${source.width}x${source.height} to ${width}x${height} can soften details and reduce perceived image quality.`]
    : [];
  const image = {
    localPath,
    path: localPath,
    filename,
    mimeType: "image/png",
    sizeBytes: bytes.length,
    width,
    height,
    sourceNodeId: node.id,
    transform: "imageResize"
  };
  await writeFile(join(assetsDirectory, `${filename}.json`), JSON.stringify(image, null, 2), "utf8");
  return {
    output: {
      image,
      localPath,
      metadata: {
        sourceWidth: source.width,
        sourceHeight: source.height,
        requestedWidth: requestedWidth ?? null,
        requestedHeight: requestedHeight ?? null,
        width,
        height,
        preserveAspectRatio,
        upscaled
      },
      warnings,
      status: "succeeded"
    },
    logs: [
      `Resized PNG from ${source.width}x${source.height} to ${width}x${height} at ${localPath}.`,
      ...warnings
    ],
    provenance: { transform: "imageResize", preserveAspectRatio, upscaled }
  };
};

export const panorama360ToFisheyeRunner: NodeRunner = async ({ node, params, inputs, context }) => {
  const source = await readLocalPngImage(params.image ?? inputs.image ?? firstInputValue(inputs), "transform.panorama360ToFisheye");
  if (source.width < 2 || source.height < 1) throw new Error("transform.panorama360ToFisheye requires a valid equirectangular panorama image.");
  const fovDegrees = clampedNumberParam(params.fovDegrees ?? params.angleDegrees ?? params.angle, 200, 1, 360, "fovDegrees");
  const outputSize = integerParam(params.outputSize ?? params.size, Math.max(1, source.height), "outputSize");
  const yawDegrees = numberParam(params.yawDegrees ?? params.yaw, 0);
  const pitchDegrees = clampedNumberParam(params.pitchDegrees ?? params.pitch, -90, -90, 90, "pitchDegrees");
  const background = parseRgbaParam(params.background, [0, 0, 0, 0]);
  const fisheye = projectEquirectangularToFisheye(source, {
    outputSize,
    fovDegrees,
    yawDegrees,
    pitchDegrees,
    background
  });
  const bytes = encodeRgbaPng(fisheye.width, fisheye.height, fisheye.data);
  const assetsDirectory = join(context.outputDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const filename = `${sanitizeFilename(node.id)}-fisheye-${Date.now()}.png`;
  const localPath = join(assetsDirectory, filename);
  await writeFile(localPath, bytes);
  const image = {
    localPath,
    path: localPath,
    filename,
    mimeType: "image/png",
    sizeBytes: bytes.length,
    width: fisheye.width,
    height: fisheye.height,
    sourceNodeId: node.id,
    transform: "panorama360ToFisheye",
    projection: "fisheye",
    fovDegrees,
    yawDegrees,
    pitchDegrees
  };
  await writeFile(join(assetsDirectory, `${filename}.json`), JSON.stringify(image, null, 2), "utf8");
  return {
    output: {
      image,
      localPath,
      metadata: {
        sourceProjection: "equirectangular",
        outputProjection: "fisheye",
        fovDegrees,
        yawDegrees,
        pitchDegrees,
        outputSize
      },
      status: "succeeded"
    },
    logs: [`Projected 360 panorama to fisheye PNG at ${localPath}`],
    provenance: { transform: "panorama360ToFisheye", sourceProjection: "equirectangular", outputProjection: "fisheye" }
  };
};

export const transformTemplateRunner: NodeRunner = ({ params }) => ({
  output: {
    text: String(params.template ?? "")
  }
});

export const debugLogRunner: NodeRunner = ({ params, context }) => {
  const value = params.value ?? params.message ?? null;
  const message = params.message ? String(params.message) : JSON.stringify(value);
  context.log(message, undefined);
  return {
    output: { value },
    logs: [message]
  };
};

export const nullRunner: NodeRunner = ({ inputs }) => ({
  output: firstInputValue(inputs) ?? {}
});

export const createResourceCapabilityRunner: NodeRunner = async ({ node, params }) => {
  const kind = node.type === "capability.location.create" ? "location" : "character";
  const linkedRef = stringParam(params.resource ?? params.resourceRef);
  if (linkedRef) {
    const resource = await resolveResourceLibraryItem(linkedRef);
    return {
      output: { resource },
      logs: [`Resolved ${resource.kind} resource "${resource.ref}".`],
      provenance: { resourceRef: resource.ref, resourcePath: resource.path }
    };
  }
  const title = stringParam(params.title ?? params.name) ?? titleFromId(node.id);
  const description = stringParam(params.description);
  const prompt = stringParam(params.prompt);
  const resource: ResourceLibraryItem = {
    id: stringParam(params.id) ?? node.id,
    kind,
    title,
    description,
    prompt,
    tags: Array.isArray(params.tags) ? params.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())) : undefined,
    ref: `${kind}/${stringParam(params.id) ?? node.id}`,
    path: "<route>"
  };
  return {
    output: { resource },
    logs: [`Created route-local ${kind} resource "${resource.ref}".`],
    provenance: { resourceRef: resource.ref, local: true }
  };
};

export const outputTextRunner: NodeRunner = ({ params, inputs }) => {
  const from = params.from ?? firstInputValue(inputs) ?? "";
  const text = typeof from === "string" ? from : JSON.stringify(from, null, 2);
  return {
    output: {
      text
    }
  };
};

export const outputFileRunner: NodeRunner = async ({ params, inputs, context }) => {
  const filename = sanitizeFilename(basename(String(params.filename ?? "output.json")));
  const from = params.from ?? firstInputValue(inputs) ?? {};
  const path = join(context.outputDirectory, filename);
  const data = typeof from === "string" ? from : JSON.stringify(from, null, 2);
  await writeFile(path, data, "utf8");
  return {
    output: {
      path,
      filename,
      contentPreview: data.length > 500 ? `${data.slice(0, 500)}...` : data
    },
    logs: [`Wrote ${filename}`]
  };
};

export const httpRequestRunner: NodeRunner = async ({ node, params, inputs, context }) => {
  const method = normalizeHttpMethod(params.method);
  const url = buildRequestUrl(requiredString(params.url, "http.request requires params.url."), parseJsonObject(params.query ?? params.queryParams, "query"));
  const headers = parseJsonObject(params.headers, "headers");
  const bodyMode = String(params.bodyMode ?? "none");
  const timeoutMs = numberParam(params.timeoutMs, 30000);
  const body = buildHttpBody(bodyMode, params.body, inputs);

  let response: Response;
  try {
    response = await fetchWithTimeout(url, { method, headers, body }, timeoutMs);
  } catch (error) {
    context.log(`HTTP request failed for ${node.id}: ${errorMessage(error)}`, node.id);
    throw new Error(`HTTP request failed: ${errorMessage(error)}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const responseMode = String(params.responseMode ?? "json");
  const responseText = responseMode === "binary" ? "" : await response.text();
  let responseJson: unknown = null;
  if (responseMode === "json" || contentType.includes("application/json")) {
    responseJson = responseText.trim() ? parseJsonText(responseText, "response") : null;
  }

  if (!response.ok) {
    context.log(`HTTP ${method} ${url} returned ${response.status}: ${truncate(responseText, 1000)}`, node.id);
    throw new Error(`HTTP request returned ${response.status} ${response.statusText}`.trim());
  }

  return {
    output: {
      status: response.status,
      statusText: response.statusText,
      responseJson,
      responseText,
      headers: Object.fromEntries(response.headers.entries())
    },
    logs: [`HTTP ${method} ${url} -> ${response.status}`],
    provenance: { provider: "http", url },
    providerUsage: { provider: "http", nodeId: node.id, nodeType: node.type, status: String(response.status), estimatedCost: null, actualCost: null }
  };
};

export const localStableDiffusionTextToImageRunner: NodeRunner = async ({ node, params, inputs, context }) => {
  const endpoint = trimTrailingSlash(requiredString(params.endpoint ?? "http://127.0.0.1:7860", "local.stableDiffusion.textToImage requires params.endpoint."));
  const prompt = firstInputText(inputs.prompt) ?? requiredString(params.prompt, "local.stableDiffusion.textToImage requires params.prompt.");
  const negativePrompt = firstInputText(inputs.negativePrompt) ?? stringParam(params.negativePrompt) ?? "";
  const width = positiveNumberParam(params.width, 512, "width");
  const height = positiveNumberParam(params.height, 512, "height");
  const steps = positiveNumberParam(params.steps, 20, "steps");
  const cfgScale = positiveNumberParam(params.cfgScale, 7, "cfgScale");
  const batchSize = positiveNumberParam(params.batchSize, 1, "batchSize");
  const timeoutMs = numberParam(params.timeoutMs, 180000);
  const model = stringParam(params.model ?? params.sdModelCheckpoint);
  const requestBody = filterDefined({
    prompt,
    negative_prompt: negativePrompt,
    width,
    height,
    steps,
    seed: numberParam(params.seed, -1),
    cfg_scale: cfgScale,
    sampler_name: stringParam(params.samplerName),
    batch_size: batchSize,
    restore_faces: optionalBoolean(params.restoreFaces),
    enable_hr: optionalBoolean(params.enableHrFix),
    override_settings: model ? { sd_model_checkpoint: model } : undefined,
    override_settings_restore_afterwards: model ? true : undefined
  });

  let response: Response;
  try {
    response = await fetchWithTimeout(`${endpoint}/sdapi/v1/txt2img`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    }, timeoutMs);
  } catch (error) {
    context.log(`Local Stable Diffusion request failed at ${endpoint}: ${errorMessage(error)}`, node.id);
    throw new Error(`Local Stable Diffusion server is not reachable at ${endpoint}`);
  }

  if (response.status === 404) {
    throw new Error("Stable Diffusion WebUI API endpoint is not available. Make sure API mode is enabled.");
  }
  const responseText = await response.text();
  if (!response.ok) {
    context.log(`Stable Diffusion WebUI returned ${response.status}: ${truncate(responseText, 1000)}`, node.id);
    throw new Error(`Stable Diffusion WebUI request failed (${response.status}).`);
  }

  const result = parseJsonText(responseText, "Stable Diffusion response") as { images?: unknown[]; info?: unknown; parameters?: unknown };
  const firstImage = result.images?.find((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (!firstImage) throw new Error("Stable Diffusion WebUI response did not include an image.");
  const imageAsset = await writeBase64Image(firstImage, {
    outputDirectory: context.outputDirectory,
    sourceNodeId: node.id,
    endpoint
  });
  const info = typeof result.info === "string" && result.info.trim() ? parseJsonText(result.info, "Stable Diffusion info") : result.info;
  const seed = info && typeof info === "object" && "seed" in info ? (info as Record<string, unknown>).seed : params.seed;

  return {
    output: {
      image: imageAsset,
      localPath: imageAsset.localPath,
      metadata: {
        seed,
        endpoint,
        width,
        height,
        steps,
        cfgScale,
        samplerName: stringParam(params.samplerName) ?? null,
        model: model ?? null,
        localBackend: "stable-diffusion-webui-compatible"
      },
      info,
      parameters: result.parameters,
      status: "succeeded"
    },
    logs: [`Generated local Stable Diffusion image at ${imageAsset.localPath}`],
    provenance: { provider: "local", localBackend: "stable-diffusion-webui-compatible", endpoint },
    providerUsage: { provider: "local", model: model ?? "stable-diffusion-webui-compatible", nodeId: node.id, nodeType: node.type, status: "succeeded", estimatedCost: null, actualCost: null }
  };
};

export const stableDiffusionHiddenControlImageRunner: NodeRunner = async ({ node, params, inputs, context }) => {
  const endpoint = trimTrailingSlash(requiredString(params.endpoint ?? "http://127.0.0.1:7860", "ai.image.sd15.qr_monster_hidden_control requires params.endpoint."));
  const timeoutMs = numberParam(params.timeoutMs, 180000);
  const controlNetModel = await preflightStableDiffusionQrMonster(endpoint, timeoutMs);
  const payload = await buildStableDiffusionHiddenControlPayload(params, inputs, controlNetModel);

  let response: Response;
  try {
    response = await fetchWithTimeout(`${endpoint}/sdapi/v1/txt2img`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, timeoutMs);
  } catch (error) {
    context.log(`Automatic1111 txt2img request failed at ${endpoint}: ${errorMessage(error)}`, node.id);
    throw new Error(`Automatic1111 txt2img request failed: ${errorMessage(error)}`);
  }

  const responseText = await response.text();
  if (!response.ok) {
    context.log(`Automatic1111 returned ${response.status}: ${truncate(responseText, 1000)}`, node.id);
    throw new Error(`Automatic1111 API returned ${response.status}: ${truncate(responseText, 300)}`);
  }

  const result = parseJsonText(responseText, "Automatic1111 txt2img response") as { images?: unknown[]; info?: unknown; parameters?: unknown };
  const images = (result.images ?? []).filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (images.length === 0) throw new Error("Automatic1111 txt2img response did not include an output image.");
  const imageAssets = [];
  for (let index = 0; index < images.length; index += 1) {
    imageAssets.push(await writeBase64Image(images[index], {
      outputDirectory: context.outputDirectory,
      sourceNodeId: images.length === 1 ? node.id : `${node.id}-${index + 1}`,
      endpoint
    }));
  }
  const info = typeof result.info === "string" && result.info.trim() ? parseJsonText(result.info, "Automatic1111 generation info") : result.info;
  const seed = info && typeof info === "object" && "seed" in info ? (info as Record<string, unknown>).seed : payload.seed;
  const warnings: string[] = [];
  if (String(params.mode ?? "hidden_image") === "qr_code" && payload.alwayson_scripts.controlnet.args[0].weight < 1) {

    warnings.push("QR code mode usually needs illusion strength near or above 1.0 for readability.");
  }

  return {
    output: {
      image: imageAssets[0],
      images: imageAssets,
      localPath: imageAssets[0].localPath,
      seed,
      usedPrompt: payload.prompt,
      usedNegativePrompt: payload.negative_prompt,
      controlNetModel,
      rawGenerationInfo: result.info,
      metadata: {
        seed,
        endpoint,
        width: payload.width,
        height: payload.height,
        steps: payload.steps,
        cfgScale: payload.cfg_scale,
        samplerName: payload.sampler_name,
        batchSize: payload.batch_size,
        controlNetModel,
        controlWeight: payload.alwayson_scripts.controlnet.args[0].weight,
        guidanceStart: payload.alwayson_scripts.controlnet.args[0].guidance_start,
        guidanceEnd: payload.alwayson_scripts.controlnet.args[0].guidance_end,
        controlMode: payload.alwayson_scripts.controlnet.args[0].control_mode,
        resizeMode: payload.alwayson_scripts.controlnet.args[0].resize_mode,
        pixelPerfect: payload.alwayson_scripts.controlnet.args[0].pixel_perfect,
        mode: String(params.mode ?? "hidden_image"),
        localBackend: "automatic1111-controlnet"
      },
      parameters: result.parameters,
      warnings,
      status: "succeeded"
    },

    logs: [`Generated ${imageAssets.length} double-image illusion image(s) with ControlNet model "${controlNetModel}".`],

    provenance: { provider: "local", localBackend: "automatic1111-controlnet", endpoint, controlNetModel },
    providerUsage: { provider: "local", model: controlNetModel, nodeId: node.id, nodeType: node.type, status: "succeeded", estimatedCost: null, actualCost: null }
  };
};

export function registerBuiltInNodeRunners(executor: RouteExecutor): void {
  executor.registerNodeRunner("input.text", inputTextRunner);
  executor.registerNodeRunner("input.file", inputFileRunner);
  executor.registerNodeRunner("input.image", inputImageRunner);
  executor.registerNodeRunner("input.video", inputVideoRunner);
  executor.registerNodeRunner("capability.character.create", createResourceCapabilityRunner);
  executor.registerNodeRunner("capability.location.create", createResourceCapabilityRunner);
  executor.registerNodeRunner("library.prompt", promptLibraryRunner);
  executor.registerNodeRunner("dialogue.workbench", dialogueWorkbenchRunner);
  executor.registerNodeRunner("text.promptCompose", promptComposeRunner);
  executor.registerNodeRunner("preview.image", previewImageRunner);
  executor.registerNodeRunner("preview.panorama360", previewPanorama360Runner);
  executor.registerNodeRunner("transform.chooseCameraPoint", chooseCameraPointRunner);
  executor.registerNodeRunner("transform.imageResize", imageResizeRunner);
  executor.registerNodeRunner("transform.panorama360ToFisheye", panorama360ToFisheyeRunner);
  executor.registerNodeRunner("transform.template", transformTemplateRunner);
  executor.registerNodeRunner("debug.log", debugLogRunner);
  executor.registerNodeRunner("utility.null", nullRunner);
  executor.registerNodeRunner("http.request", httpRequestRunner);
  executor.registerNodeRunner("local.stableDiffusion.textToImage", localStableDiffusionTextToImageRunner);
  executor.registerNodeRunner("ai.image.sd15.qr_monster_hidden_control", stableDiffusionHiddenControlImageRunner);
  executor.registerCapabilityProvider("image.create", "local.stableDiffusion.textToImage", { priority: 10 });
  executor.registerCapabilityProvider("image.create", "ai.image.sd15.qr_monster_hidden_control", { priority: 9 });
  executor.registerNodeRunner("output.text", outputTextRunner);
  executor.registerNodeRunner("output.file", outputFileRunner);
}

function builtInNodeCategory(type: string): string {
  if (type === "ai.image.sd15.qr_monster_hidden_control") return "Local / Stable Diffusion";
  if (type.startsWith("input.")) return "Input";
  if (type.startsWith("output.")) return "Output";
  if (type.startsWith("preview.")) return "Preview";
  if (type.startsWith("capability.")) return "Capability";
  if (type.startsWith("http.")) return "API / HTTP";
  if (type.startsWith("local.")) return "Local";
  if (type.startsWith("dialogue.")) return "Dialogue";
  if (type.startsWith("text.")) return "Text / Prompt";
  if (type.startsWith("debug.")) return "Debug";
  if (type.startsWith("utility.")) return "Debug";
  if (type.startsWith("library.")) return "Text";
  return "Transform";
}

function builtInPermissions(type: string) {
  return {
    network: type === "http.request" || type === "transform.chooseCameraPoint" || type === "local.stableDiffusion.textToImage" || type === "ai.image.sd15.qr_monster_hidden_control",
    networkHosts: type === "transform.chooseCameraPoint" ? ["api.worldlabs.ai"] : type === "local.stableDiffusion.textToImage" || type === "ai.image.sd15.qr_monster_hidden_control" ? ["127.0.0.1", "localhost"] : [],
    readFiles: type === "input.file" || type === "input.image" || type === "input.video" || type === "transform.imageResize" || type === "transform.panorama360ToFisheye" || type === "ai.image.sd15.qr_monster_hidden_control",
    writeOutputs: type === "output.file" || type === "local.stableDiffusion.textToImage" || type === "transform.imageResize" || type === "transform.panorama360ToFisheye" || type === "ai.image.sd15.qr_monster_hidden_control",
    shell: false,
    env: []
  };
}

function builtInInputs(type: string) {
  if (type === "text.promptCompose") {
    return [
      { id: "subject", type: "text", required: false, label: "Subject" },
      { id: "style", type: "text", required: false, label: "Style" },
      { id: "scene", type: "text", required: false, label: "Scene" }
    ];
  }
  if (type === "dialogue.workbench") {
    return [
      { id: "text", type: "text", required: false, label: "Text" },
      { id: "image", type: "image", required: false, label: "Image" },
      { id: "json", type: "json", required: false, label: "JSON" },
      { id: "context", type: "conversation_context", required: false, label: "Context" }
    ];
  }
  if (type === "preview.image" || type === "preview.panorama360" || type === "transform.chooseCameraPoint" || type === "transform.imageResize" || type === "transform.panorama360ToFisheye") return [{ id: "image", type: "image", required: true, label: "Image" }];
  if (type === "debug.log") return [{ id: "value", type: "data", required: false, label: "Value" }];
  if (type === "utility.null") return [{ id: "input", type: "data", required: false, label: "Any" }];
  if (type === "output.text") return [{ id: "from", type: "data", required: false, label: "From" }];
  if (type === "output.file") return [{ id: "from", type: "data", required: false, label: "From" }];
  if (type === "local.stableDiffusion.textToImage") return [{ id: "prompt", type: "text", required: false, label: "Prompt" }];
  if (type === "ai.image.sd15.qr_monster_hidden_control") {
    return [
      { id: "controlImage", type: "image", required: true, label: "Image", description: "Hidden picture, silhouette, pattern, or QR code passed to ControlNet." },
      { id: "prompt", type: "text", required: false, label: "Prompt" },
      { id: "negativePrompt", type: "text", required: false, label: "Negative Prompt" }
    ];
  }
  if (type === "capability.image.edit" || type === "capability.image.upscale") return [{ id: "image", type: "image", required: true, label: "Image" }];
  if (type === "capability.video.animate") return [{ id: "image", type: "image", required: false, label: "Image" }];
  return [];
}

function builtInOutputs(type: string) {
  if (type === "input.text" || type === "library.prompt" || type === "text.promptCompose" || type === "transform.template" || type === "output.text") return [{ id: "text", type: "text", label: "Text" }];
  if (type === "dialogue.workbench") return [
    { id: "conversation_text", type: "text", label: "conversation_text" },
    { id: "conversation_json", type: "json", label: "conversation_json" },
    { id: "conversation_capsule", type: "conversation_context", label: "conversation_capsule" }
  ];
  if (type === "input.file" || type === "output.file") return [{ id: "file", type: "file", label: "File" }];
  if (type === "transform.chooseCameraPoint") return [
    { id: "view", type: "image", label: "View" },
    { id: "panorama", type: "image", label: "360" }
  ];
  if (type === "input.image" || type === "preview.image" || type === "preview.panorama360" || type === "transform.imageResize" || type === "transform.panorama360ToFisheye" || type === "local.stableDiffusion.textToImage" || type === "ai.image.sd15.qr_monster_hidden_control") return [{ id: "image", type: "image", label: "Image" }];
  if (type === "capability.image.create" || type === "capability.image.edit" || type === "capability.image.upscale") return [{ id: "image", type: "image", label: "Image" }];
  if (type === "capability.video.animate") return [{ id: "video", type: "video", label: "Video" }];
  if (type === "capability.character.create" || type === "capability.location.create") return [{ id: "resource", type: "json", label: "Resource" }];
  if (type === "input.video") return [{ id: "video", type: "video", label: "Video" }];
  if (type === "http.request") return [{ id: "responseJson", type: "json", label: "JSON" }, { id: "responseText", type: "text", label: "Text" }];
  if (type === "debug.log") return [{ id: "value", type: "data", label: "Value" }];
  if (type === "utility.null") return [{ id: "output", type: "data", label: "Output" }];
  return [{ id: "output", type: "data", label: "Output" }];
}

function builtInParams(type: string) {
  if (type === "input.text") return [{ id: "value", type: "text", label: "Value", default: "" }];
  if (type === "text.promptCompose") {
    return [
      { id: "manualText", type: "text", label: "Prompt", default: "", description: "Manual prompt text included before connected or slot text." },
      { id: "separator", type: "text", label: "Separator", default: "\n\n", description: "String used to separate non-empty text blocks." },
      { id: "trimParts", type: "boolean", label: "Trim parts", default: true, description: "Trim whitespace and empty lines from the start/end of each block." },
      { id: "skipEmpty", type: "boolean", label: "Skip empty", default: true, description: "Do not include empty blocks." },
      { id: "prefix", type: "text", label: "Prefix", default: "", description: "Text added to the beginning of the result." },
      { id: "suffix", type: "text", label: "Suffix", default: "", description: "Text added to the end of the result." }
    ];
  }
  if (type === "dialogue.workbench") {
    return [
      { id: "defaultModelProfileId", type: "text", label: "Default Model Profile", default: "text.default" },
      { id: "agentPresetId", type: "text", label: "Agent Preset", default: "" },
      { id: "state", type: "json", label: "Workbench State", default: { conversationId: "", messages: [], selectedOutputs: [] } }
    ];
  }
  if (type === "input.file" || type === "input.image" || type === "input.video") return [{ id: "path", type: "file", label: "Path", default: "" }];
  if (type === "preview.panorama360") return [
    { id: "yaw", type: "number", label: "Yaw", default: 0, description: "Horizontal view direction in degrees." },
    { id: "pitch", type: "number", label: "Pitch", default: 0, description: "Vertical view direction in degrees." },
    { id: "fov", type: "number", label: "FOV", default: 55, description: "Perspective field of view in degrees." }
  ];
  if (type === "transform.imageResize") {
    return [
      { id: "width", type: "number", label: "Width", default: 1024, description: "Target width in pixels." },
      { id: "height", type: "number", label: "Height", default: 1024, description: "Target height in pixels." },
      { id: "preserveAspectRatio", type: "boolean", label: "Keep proportions", default: true, description: "Fit inside the target size without stretching the image." }
    ];
  }
  if (type === "transform.panorama360ToFisheye") {
    return [
      { id: "fovDegrees", type: "number", label: "Angle", default: 200, description: "Fisheye field of view in degrees, from 1 to 360." },
      { id: "yawDegrees", type: "number", label: "Yaw", default: 0, description: "Horizontal view direction in degrees." },
      { id: "pitchDegrees", type: "number", label: "Pitch", default: -90, description: "Vertical view direction in degrees." }
    ];
  }
  if (type === "transform.chooseCameraPoint") {
    return [
      { id: "provider", type: "text", label: "Provider", default: "worldlabs-marble" },
      { id: "model", type: "enum", label: "Marble model", default: "marble-1.0-draft" },
      { id: "regenerateWorld", type: "boolean", label: "Regenerate world", default: false },
      { id: "resolution", type: "enum", label: "Resolution", default: "1536x864" },
      { id: "fov", type: "number", label: "FOV", default: 70 },
      { id: "marbleWorld", type: "json", label: "Cached Marble world", default: { provider: "worldlabs-marble", model: "marble-1.0-draft", generationStatus: "no world" } },
      { id: "cameraPose", type: "json", label: "Camera pose", default: { position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0, roll: 0 }, fov: 70 } },
      { id: "output", type: "json", label: "Output settings", default: { mode: "perspective", width: 1536, height: 864 } }
    ];
  }
  if (type.startsWith("capability.")) return [{ id: "prompt", type: "text", label: "Prompt", default: "" }, { id: "provider", type: "text", label: "Provider", default: "" }];
  if (type === "transform.template") return [{ id: "template", type: "text", label: "Template", default: "" }];
  if (type === "http.request") {
    return [
      { id: "url", type: "text", label: "URL", default: "" },
      { id: "method", type: "text", label: "Method", default: "GET" }
    ];
  }
  if (type === "ai.image.sd15.qr_monster_hidden_control") {
    return [
      { id: "prompt", type: "text", label: "Prompt", default: "" },
      { id: "negativePrompt", type: "text", label: "Negative Prompt", default: "" },
      { id: "mode", type: "enum", label: "Mode", default: "hidden_image" },
      { id: "controlWeight", type: "number", label: "Illusion Strength", default: 1.2, description: "Higher = hidden image / QR more readable; lower = image more creative." },
      { id: "endpoint", type: "text", label: "Automatic1111 Endpoint", default: "http://127.0.0.1:7860", description: "Requires local Automatic1111 with --api, ControlNet extension, and QR Code Monster model." },
      { id: "steps", type: "number", label: "Steps", default: 30 },
      { id: "cfgScale", type: "number", label: "CFG Scale", default: 7 },
      { id: "samplerName", type: "text", label: "Sampler", default: "DPM++ 2M Karras" },
      { id: "seed", type: "number", label: "Seed", default: -1 },
      { id: "batchSize", type: "number", label: "Batch Size", default: 1 },
      { id: "guidanceStart", type: "number", label: "Guidance Start", default: 0 },
      { id: "guidanceEnd", type: "number", label: "Guidance End", default: 1 },
      { id: "controlMode", type: "enum", label: "Control Mode", default: "Balanced" },
      { id: "resizeMode", type: "enum", label: "Resize Mode", default: "Just Resize" },
      { id: "pixelPerfect", type: "boolean", label: "Pixel Perfect", default: true },
      { id: "preprocessGrayscale", type: "boolean", label: "Grayscale", default: true },
      { id: "preprocessInvert", type: "boolean", label: "Invert", default: false },
      { id: "preprocessThreshold", type: "number", label: "Threshold" },
      { id: "preprocessContrast", type: "number", label: "Contrast" }
    ];
  }
  return [];
}

function builtInUi(type: string) {
  if (type === "transform.imageResize") {
    return {
      params: {
        width: { control: "number", min: 1, step: 1 },
        height: { control: "number", min: 1, step: 1 },
        preserveAspectRatio: { control: "checkbox" }
      }
    };
  }
  if (type === "transform.chooseCameraPoint") {
    return {
      params: {
        model: {
          control: "select",
          options: [
            { value: "marble-1.0-draft", label: "Draft" },
            { value: "marble-1.1", label: "Standard" }
          ]
        },
        resolution: {
          control: "select",
          options: ["1024x576", "1536x864", "2048x1152", "custom"]
        },
        fov: { control: "slider", min: 35, max: 120, step: 1 },
        marbleWorld: { advanced: true },
        cameraPose: { advanced: true },
        output: { advanced: true }
      }
    };
  }
  if (type === "ai.image.sd15.qr_monster_hidden_control") {
    return {
      params: {
        prompt: { control: "textarea", size: "compact", placeholder: "Describe the visible image" },
        negativePrompt: { control: "textarea", size: "compact" },
        mode: {
          control: "select",
          options: [
            { value: "hidden_image", label: "Hidden image" },
            { value: "qr_code", label: "QR code" }
          ]
        },
        controlWeight: { control: "slider", min: 0, max: 2, step: 0.05, helperText: "Higher = hidden image / QR more readable; lower = image more creative." },
        endpoint: { advanced: true },
        steps: { control: "slider", min: 1, max: 80, step: 1, advanced: true },
        cfgScale: { control: "slider", min: 1, max: 20, step: 0.5, advanced: true },
        samplerName: {
          control: "select",
          advanced: true,
          options: ["DPM++ 2M Karras", "DPM++ SDE Karras", "Euler a", "Euler", "DDIM"]
        },
        seed: { advanced: true },
        batchSize: { control: "slider", min: 1, max: 8, step: 1, advanced: true },
        guidanceStart: { control: "slider", min: 0, max: 1, step: 0.05, advanced: true },
        guidanceEnd: { control: "slider", min: 0, max: 1, step: 0.05, advanced: true },
        controlMode: {
          control: "select",
          advanced: true,
          options: ["Balanced", "My prompt is more important", "ControlNet is more important"]
        },
        resizeMode: {
          control: "select",
          advanced: true,
          options: ["Just Resize", "Scale to Fit (Inner Fit)", "Envelope (Outer Fit)"]
        },
        pixelPerfect: { advanced: true },
        preprocessGrayscale: { advanced: true },
        preprocessInvert: { advanced: true },
        preprocessThreshold: { control: "slider", min: 0, max: 255, step: 1, advanced: true },
        preprocessContrast: { control: "slider", min: 0, max: 4, step: 0.1, advanced: true }
      }
    };
  }
  return undefined;
}

export function composePromptText(params: Record<string, unknown>, inputs: Record<string, unknown>): string {
  const trimParts = params.trimParts !== false;
  const skipEmpty = params.skipEmpty !== false;
  const separator = String(params.separator ?? "\n\n");
  const manualText = params.manualText === undefined || params.manualText === null ? "" : String(params.manualText);
  const slotParts = promptComposeFixedSlots().flatMap((slot) =>
    inputTextParts(inputs[slot.id]).map((raw, index) => ({ slot, raw, index }))
  );
  const legacyInputParts = inputTextParts(inputs.texts).map((raw, index) => ({ slot: { id: "text", label: "Text" }, raw, index }));
  const paramParts = [1, 2, 3, 4, 5, 6].flatMap((index) => {
    const raw = params[`text${index}`];
    return raw === undefined ? [] : [{ slot: { id: "text", label: "Text" }, raw, index: index - 1 }];
  });
  const hasSlotInputs = slotParts.length > 0;
  const values = hasSlotInputs ? slotParts : legacyInputParts.length > 0 ? legacyInputParts : paramParts;
  const parts = [
    { label: "Prompt", index: 1, value: trimParts ? manualText.trim() : manualText },
    ...values
    .map(({ slot, raw, index }) => {
      const text = raw === undefined || raw === null ? "" : String(raw);
      const value = trimParts ? text.trim() : text;
      return { label: slot.label || titleFromId(slot.id), index: index + 1, value };
    })
  ]
    .filter((part) => !skipEmpty || part.value !== "");
  const body = parts
    .map((part) => hasSlotInputs && part.label !== "Prompt" ? `${part.label}${part.index > 1 ? ` ${part.index}` : ""}:\n${part.value}` : part.value)
    .join(separator);
  return `${String(params.prefix ?? "")}${body}${String(params.suffix ?? "")}`;
}

export interface StableDiffusionHiddenControlPayload {
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  steps: number;
  cfg_scale: number;
  sampler_name: string;
  seed: number;
  batch_size: number;
  alwayson_scripts: {
    controlnet: {
      args: [{
        enabled: true;
        image: string;
        module: "none";
        model: string;
        weight: number;
        resize_mode: string;
        guidance_start: number;
        guidance_end: number;
        control_mode: string;
        pixel_perfect: boolean;
      }];
    };
  };
}

export async function buildStableDiffusionHiddenControlPayload(
  params: Record<string, unknown>,
  inputs: Record<string, unknown>,
  controlNetModel: string
): Promise<StableDiffusionHiddenControlPayload> {
  const controlMode = enumParam(params.controlMode, "Balanced", ["Balanced", "My prompt is more important", "ControlNet is more important"], "controlMode");
  const resizeMode = enumParam(params.resizeMode, "Just Resize", ["Just Resize", "Scale to Fit (Inner Fit)", "Envelope (Outer Fit)"], "resizeMode");
  const image = await readLocalPngImage(params.controlImage ?? inputs.controlImage ?? inputs.image ?? firstInputValue(inputs), "ai.image.sd15.qr_monster_hidden_control");
  const width = integerParam(params.width, image.width, "width");
  const height = integerParam(params.height, image.height, "height");
  const processed = preprocessControlImage(image, {
    width,
    height,
    resizeMode,
    grayscale: params.preprocessGrayscale !== false,
    invert: params.preprocessInvert === true,
    threshold: optionalNumberParam(params.preprocessThreshold, "preprocessThreshold"),
    contrast: optionalNumberParam(params.preprocessContrast, "preprocessContrast")
  });
  return {
    prompt: firstInputText(inputs.prompt) ?? requiredString(params.prompt, "ai.image.sd15.qr_monster_hidden_control requires params.prompt."),
    negative_prompt: firstInputText(inputs.negativePrompt) ?? stringParam(params.negativePrompt) ?? "",
    width,
    height,
    steps: integerParam(params.steps, 30, "steps"),
    cfg_scale: positiveNumberParam(params.cfgScale, 7, "cfgScale"),
    sampler_name: stringParam(params.samplerName) ?? "DPM++ 2M Karras",
    seed: Math.round(numberParam(params.seed, -1)),
    batch_size: integerParam(params.batchSize, 1, "batchSize"),
    alwayson_scripts: {
      controlnet: {
        args: [{
          enabled: true,
          image: encodeRgbaPng(processed.width, processed.height, processed.data).toString("base64"),
          module: "none",
          model: controlNetModel,
          weight: clampedNumberParam(params.controlWeight, 1.2, 0, 2, "controlWeight"),
          resize_mode: resizeMode,
          guidance_start: clampedNumberParam(params.guidanceStart, 0, 0, 1, "guidanceStart"),
          guidance_end: clampedNumberParam(params.guidanceEnd, 1, 0, 1, "guidanceEnd"),
          control_mode: controlMode,
          pixel_perfect: params.pixelPerfect !== false
        }]
      }
    }
  };
}

export async function preflightStableDiffusionQrMonster(endpoint: string, timeoutMs = 30000): Promise<string> {
  try {
    const version = await fetchWithTimeout(`${endpoint}/controlnet/version`, { method: "GET" }, timeoutMs);
    if (!version.ok) throw new Error(`HTTP ${version.status}`);
  } catch (error) {
    throw new Error(`Automatic1111 is not reachable at ${endpoint}, or it is running without --api / without the ControlNet extension. GET /controlnet/version failed: ${errorMessage(error)}`);
  }

  let modelList: unknown;
  try {
    const response = await fetchWithTimeout(`${endpoint}/controlnet/model_list`, { method: "GET" }, timeoutMs);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${truncate(text, 300)}`);
    modelList = parseJsonText(text, "ControlNet model_list response");
  } catch (error) {
    throw new Error(`ControlNet extension is not reachable at ${endpoint}. GET /controlnet/model_list failed: ${errorMessage(error)}`);
  }

  const model = findQrMonsterControlNetModel(modelList);
  if (!model) throw new Error("ControlNet QR Code Monster model is not installed. Install a model whose name contains control_v1p_sd15_qrcode_monster or qrcode_monster.");
  return model;
}

export function findQrMonsterControlNetModel(modelList: unknown): string | null {
  const candidates = extractControlNetModelNames(modelList);
  const needles = ["control_v1p_sd15_qrcode_monster", "qrcode_monster"];
  return candidates.find((model) => needles.some((needle) => model.toLowerCase().includes(needle))) ?? null;
}

export function encodeStableDiffusionControlImageBase64(image: RgbaImage, options: {
  width: number;
  height: number;
  resizeMode?: string;
  grayscale?: boolean;
  invert?: boolean;
  threshold?: number;
  contrast?: number;
}): string {
  const processed = preprocessControlImage(image, {
    width: options.width,
    height: options.height,
    resizeMode: options.resizeMode ?? "Just Resize",
    grayscale: options.grayscale ?? true,
    invert: options.invert ?? false,
    threshold: options.threshold,
    contrast: options.contrast
  });
  return encodeRgbaPng(processed.width, processed.height, processed.data).toString("base64");
}

function promptComposeFixedSlots(): Array<{ id: string; label: string }> {
  return [
    { id: "subject", label: "Subject" },
    { id: "style", label: "Style" },
    { id: "scene", label: "Scene" }
  ];
}

function inputTextParts(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function normalizePreviewImage(value: unknown): unknown {
  if (Array.isArray(value)) return normalizePreviewImage(value[0]);
  if (typeof value === "string") {
    const dataUrlMatch = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (dataUrlMatch) return { base64: dataUrlMatch[2], mimeType: dataUrlMatch[1], filename: "image.png" };
    if (/^https?:\/\//i.test(value)) return { originalUrl: value };
    if (/\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(value)) return { localPath: value, path: value };
    throw new Error("preview.image expected an image URL or image file path.");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const image = record.image ? normalizePreviewImage(record.image) : record;
    const candidate = image as Record<string, unknown>;
    if (typeof candidate.base64 === "string") {
      const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : "image/png";
      if (!mimeType.startsWith("image/")) throw new Error(`preview.image expected image input, got ${mimeType}.`);
      return image;
    }
    const path = candidate.localPath ?? candidate.path ?? candidate.originalUrl ?? candidate.url;
    if (typeof path !== "string") throw new Error("preview.image expected an image object with localPath, path, originalUrl, or url.");
    const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : path.startsWith("http") ? "image/remote" : getMimeType(path);
    if (mimeType !== "image/remote" && !mimeType.startsWith("image/")) {
      throw new Error(`preview.image expected image input, got ${mimeType}.`);
    }
    return image;
  }
  throw new Error("preview.image requires an image input.");
}

export function getPromptLibraryPath(): string {
  if (process.env.SNARKROUTE_PROMPT_LIBRARY_PATH) return process.env.SNARKROUTE_PROMPT_LIBRARY_PATH;
  let directory = process.cwd();
  while (true) {
    const candidate = join(directory, "data", "prompt-library");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) return join(process.cwd(), "data", "prompt-library");
    directory = parent;
  }
}

export async function loadPromptLibrary(directory = getPromptLibraryPath()): Promise<PromptLibrary> {
  const diagnostics: PromptLibraryDiagnostic[] = [];
  const prompts: PromptLibraryPrompt[] = [];
  const seen = new Set<string>();

  const files = await findPromptFiles(directory, diagnostics);
  for (const file of files) {
    let parsed: { prompt: PromptLibraryPrompt } | { diagnostic: PromptLibraryDiagnostic };
    try {
      parsed = file.endsWith(".prompt.png")
        ? parsePromptPngFile(await readFile(file), file)
        : parsePromptFile(await readFile(file, "utf8"), file);
    } catch (error) {
      diagnostics.push({ path: file, severity: "error", message: `Could not read prompt file: ${errorMessage(error)}` });
      continue;
    }
    if ("diagnostic" in parsed) {
      diagnostics.push(parsed.diagnostic);
      continue;
    }

    const key = `${parsed.prompt.category}/${parsed.prompt.id}`;
    if (seen.has(key)) {
      diagnostics.push({ path: file, severity: "error", message: `Duplicate prompt ref "${key}". Keeping the first discovered file.` });
      continue;
    }
    seen.add(key);
    prompts.push(parsed.prompt);
  }

  prompts.sort((left, right) => left.category.localeCompare(right.category) || left.title.localeCompare(right.title));
  const categories = new Map<string, PromptLibraryPrompt[]>();
  for (const prompt of prompts) categories.set(prompt.category, [...(categories.get(prompt.category) ?? []), prompt]);

  return {
    categories: [...categories.entries()].map(([id, categoryPrompts]) => ({ id, title: titleFromId(id), prompts: categoryPrompts })),
    diagnostics
  };
}

export async function loadPromptLibraryOrEmpty(path = getPromptLibraryPath()): Promise<PromptLibrary> {
  try {
    return await loadPromptLibrary(path);
  } catch {
    return { categories: [], diagnostics: [] };
  }
}

export function getResourceLibraryPath(): string {
  if (process.env.SNARKROUTE_RESOURCE_LIBRARY_PATH) return process.env.SNARKROUTE_RESOURCE_LIBRARY_PATH;
  let directory = process.cwd();
  while (true) {
    const candidate = join(directory, "data", "resource-library");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) return join(process.cwd(), "data", "resource-library");
    directory = parent;
  }
}

export async function loadResourceLibrary(directory = getResourceLibraryPath()): Promise<ResourceLibrary> {
  const diagnostics: PromptLibraryDiagnostic[] = [];
  const resources: ResourceLibraryItem[] = [];
  const files = await findResourceFiles(directory, diagnostics);
  const seen = new Set<string>();

  for (const file of files) {
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      diagnostics.push({ path: file, severity: "error", message: `Could not read resource file: ${errorMessage(error)}` });
      continue;
    }
    const parsed = parseResourceFile(text, file);
    if ("diagnostic" in parsed) {
      diagnostics.push(parsed.diagnostic);
      continue;
    }
    if (seen.has(parsed.resource.ref)) {
      diagnostics.push({ path: file, severity: "error", message: `Duplicate resource ref "${parsed.resource.ref}". Keeping the first discovered file.` });
      continue;
    }
    seen.add(parsed.resource.ref);
    resources.push(parsed.resource);
  }

  return { resources: resources.sort((left, right) => left.kind.localeCompare(right.kind) || left.title.localeCompare(right.title)), diagnostics };
}

export async function loadResourceLibraryOrEmpty(path = getResourceLibraryPath()): Promise<ResourceLibrary> {
  try {
    return await loadResourceLibrary(path);
  } catch {
    return { resources: [], diagnostics: [] };
  }
}

export function parseResourceFile(text: string, path = "<resource>"): { resource: ResourceLibraryItem } | { diagnostic: PromptLibraryDiagnostic } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/u.exec(text);
  if (!match) return { diagnostic: { path, severity: "error", message: "Resource file requires YAML frontmatter delimited by ---." } };
  let metadata: Record<string, unknown>;
  try {
    metadata = parseSimpleFrontmatter(match[1]);
  } catch (error) {
    return { diagnostic: { path, severity: "error", message: `Invalid resource frontmatter: ${errorMessage(error)}` } };
  }
  const id = stringField(metadata, "id");
  const kind = stringField(metadata, "kind");
  const title = stringField(metadata, "title");
  if (!id || !kind || !title) return { diagnostic: { path, severity: "error", message: "Resource frontmatter requires string fields: id, kind, title." } };
  const body = match[2].trim();
  const description = stringField(metadata, "description");
  const prompt = stringField(metadata, "prompt") || body || undefined;
  const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())) : undefined;
  return {
    resource: {
      id,
      kind,
      title,
      description: description || undefined,
      tags,
      prompt,
      ref: `${kind}/${id}`,
      path
    }
  };
}

export async function resolveResourceLibraryItem(ref: string, path = getResourceLibraryPath()): Promise<ResourceLibraryItem> {
  const [kind, id] = ref.split("/", 2);
  if (!kind || !id) throw new Error(`Resource ref "${ref}" must use kind/id format.`);
  const library = await loadResourceLibrary(path);
  const resource = library.resources.find((candidate) => candidate.kind === kind && candidate.id === id);
  if (!resource) throw new Error(`Linked resource "${ref}" was not found in the local resource library.`);
  return resource;
}

export function parsePromptFile(text: string, path = "<prompt>"): { prompt: PromptLibraryPrompt } | { diagnostic: PromptLibraryDiagnostic } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/u.exec(text);
  if (!match) {
    return { diagnostic: { path, severity: "error", message: "Prompt file requires YAML frontmatter delimited by ---." } };
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = parseSimpleFrontmatter(match[1]);
  } catch (error) {
    return { diagnostic: { path, severity: "error", message: `Invalid prompt frontmatter: ${errorMessage(error)}` } };
  }

  const id = stringField(metadata, "id");
  const title = stringField(metadata, "title");
  const category = stringField(metadata, "category");
  if (!id || !title || !category) {
    return { diagnostic: { path, severity: "error", message: "Prompt frontmatter requires string fields: id, title, category." } };
  }

  const body = match[2].trim();
  if (!body) {
    return { diagnostic: { path, severity: "error", message: `Prompt "${category}/${id}" has an empty body.` } };
  }

  const description = stringField(metadata, "description");
  const kind = stringField(metadata, "kind");
  const status = stringField(metadata, "status");
  const negativePrompt = stringField(metadata, "negativePrompt");
  const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())) : undefined;
  const previewImage = stringField(metadata, "previewImage");
  const source = metadata.source && typeof metadata.source === "object" && !Array.isArray(metadata.source) ? metadata.source as Record<string, unknown> : undefined;
  const modelHints = Array.isArray(metadata.modelHints) ? metadata.modelHints.filter((hint): hint is string => typeof hint === "string" && Boolean(hint.trim())) : undefined;

  return {
    prompt: {
      id,
      title,
      category,
      description: description || undefined,
      negativePrompt: negativePrompt || undefined,
      tags,
      kind: kind || undefined,
      status: status || undefined,
      previewImage: previewImage || undefined,
      source,
      modelHints,
      ref: `${category}/${id}`,
      path,
      text: body
    }
  };
}

export function parsePromptPngFile(buffer: Buffer, path = "<prompt.png>"): { prompt: PromptLibraryPrompt } | { diagnostic: PromptLibraryDiagnostic } {
  try {
    const text = readPngTextChunk(buffer, "snarkroute:prompt");
    if (!text) {
      const canonical = parseImageMetadataPrompt(buffer, path);
      if (canonical) return { prompt: canonical };
      return { diagnostic: { path, severity: "error", message: "Prompt PNG requires snarkroute:prompt metadata." } };
    }
    const metadata = JSON.parse(text) as Record<string, unknown>;
    const id = stringField(metadata, "id");
    const title = stringField(metadata, "title");
    const category = stringField(metadata, "category");
    const body = stringField(metadata, "prompt");
    if (!id || !title || !category || !body) {
      return { diagnostic: { path, severity: "error", message: "Prompt PNG metadata requires id, title, category, and prompt." } };
    }
    const description = stringField(metadata, "description");
    const kind = stringField(metadata, "kind");
    const status = stringField(metadata, "status");
    const negativePrompt = stringField(metadata, "negativePrompt");
    const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())) : undefined;
    const source = metadata.source && typeof metadata.source === "object" && !Array.isArray(metadata.source) ? metadata.source as Record<string, unknown> : undefined;
    const modelHints = Array.isArray(metadata.modelHints) ? metadata.modelHints.filter((hint): hint is string => typeof hint === "string" && Boolean(hint.trim())) : undefined;
    return {
      prompt: {
        id,
        title,
        category,
        description: description || undefined,
        negativePrompt: negativePrompt || undefined,
        tags,
        kind: kind || undefined,
        status: status || undefined,
        previewImage: basename(path),
        source,
        modelHints,
        ref: `${category}/${id}`,
        path,
        text: body
      }
    };
  } catch (error) {
    return { diagnostic: { path, severity: "error", message: `Invalid prompt PNG metadata: ${errorMessage(error)}` } };
  }
}

function parseImageMetadataPrompt(buffer: Buffer, path: string): PromptLibraryPrompt | undefined {
  const text = readPngTextChunk(buffer, "snarkroute.provenance") ?? readPngTextChunk(buffer, "snarkroute.provenance_json");
  if (!text) return undefined;
  const metadata = JSON.parse(text) as Record<string, unknown>;
  const normalized = normalizeImagePromptMetadata(metadata);
  if (!normalized) return undefined;
  const library = normalized.library && typeof normalized.library === "object" && !Array.isArray(normalized.library) ? normalized.library as Record<string, unknown> : {};
  const generation = normalized.generation as Record<string, unknown>;
  const prompt = generation.prompt as Record<string, unknown>;
  const modelId = stringField(generation, "modelId");
  const title = stringField(library, "title") || "Generated Image";
  const category = stringField(library, "category") || "generated";
  const id = stringField(normalized, "id") || basename(path).replace(/\.[^.]+$/u, "");
  const modelHints = Array.isArray(library.modelHints)
    ? library.modelHints.filter((hint): hint is string => typeof hint === "string" && Boolean(hint.trim()))
    : modelId ? [modelId] : undefined;
  return {
    id,
    title,
    category,
    kind: "text/prompt",
    status: stringField(library, "status") || "candidate",
    previewImage: basename(path),
    source: normalized.source && typeof normalized.source === "object" && !Array.isArray(normalized.source) ? normalized.source as Record<string, unknown> : undefined,
    modelHints,
    ref: `${category}/${id}`,
    path,
    text: stringField(prompt, "text") || ""
  };
}

function normalizeImagePromptMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  if (metadata.schema === "snarkroute.image-metadata.v1" && metadata.kind === "generated-image") return metadata;
  if (metadata.format !== "snarkroute.image-provenance" || metadata.version !== "0.1") return undefined;
  const parameters = metadata.parameters && typeof metadata.parameters === "object" && !Array.isArray(metadata.parameters) ? metadata.parameters as Record<string, unknown> : {};
  const modelId = stringField(metadata, "modelId") || stringField(parameters, "model") || "";
  const prompt = stringField(metadata, "prompt") || stringField(parameters, "prompt") || "";
  return {
    schema: "snarkroute.image-metadata.v1",
    kind: "generated-image",
    id: stringField(metadata, "id") || `${stringField(metadata, "nodeId") || "image"}-legacy`,
    source: { nodeId: stringField(metadata, "nodeId") || "", outputId: stringField(metadata, "outputId") || "image", runId: stringField(metadata, "runId") },
    generation: {
      providerId: stringField(metadata, "providerId") || stringField(parameters, "executionProvider"),
      modelId,
      prompt: { text: prompt, template: stringField(parameters, "promptTemplate") },
      inputImages: [],
      parameters: {}
    },
    library: { title: "Generated Image", category: "generated", status: "candidate", modelHints: modelId ? [modelId] : undefined }
  };
}

export function summarizePromptLibrary(library: PromptLibrary): PromptLibrary {
  return {
    diagnostics: library.diagnostics,
    categories: library.categories.map((category) => ({
      ...category,
      prompts: category.prompts.map((prompt) => ({ ...prompt }))
    }))
  };
}

export function getPromptLibraryPrompt(library: PromptLibrary, categoryId: string, promptId: string): PromptLibraryPrompt | null {
  return findPrompt(library, categoryId, promptId);
}

async function findPromptFiles(directory: string, diagnostics: PromptLibraryDiagnostic[]): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    diagnostics.push({ path: directory, severity: "warning", message: `Prompt library folder was not found: ${directory}` });
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findPromptFiles(path, diagnostics)));
    else if (entry.isFile() && (entry.name.endsWith(".prompt.md") || entry.name.endsWith(".prompt.png"))) files.push(path);
  }
  return files.sort();
}

async function findResourceFiles(directory: string, diagnostics: PromptLibraryDiagnostic[]): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    diagnostics.push({ path: directory, severity: "warning", message: `Resource library folder was not found: ${directory}` });
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findResourceFiles(path, diagnostics)));
    else if (entry.isFile() && entry.name.endsWith(".resource.md")) files.push(path);
  }
  return files.sort();
}

function parseSimpleFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Unsupported frontmatter line: ${line}`);
    const key = match[1];
    const value = match[2].trim();
    if (!value) {
      const list: string[] = [];
      const record: Record<string, unknown> = {};
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        const listMatch = /^\s*-\s*(.*)$/.exec(next);
        const nestedMatch = /^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/.exec(next);
        if (listMatch) {
          list.push(unquote(listMatch[1].trim()));
        } else if (nestedMatch) {
          record[nestedMatch[1]] = unquote(nestedMatch[2].trim());
        } else {
          break;
        }
        index += 1;
      }
      result[key] = list.length > 0 ? list : Object.keys(record).length > 0 ? record : "";
    } else if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value.slice(1, -1).split(",").map((item) => unquote(item.trim())).filter(Boolean);
    } else {
      result[key] = unquote(value);
    }
  }
  return result;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function titleFromId(id: string): string {
  return id.split(/[-_]/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

export async function validatePromptLibraryNodes(nodes: RouteNode[], path = getPromptLibraryPath()): Promise<ValidationIssue[]> {
  const promptNodes = nodes.filter((node) => node.type === "library.prompt");
  if (promptNodes.length === 0) return [];

  const issues: ValidationIssue[] = [];
  let library: PromptLibrary | null = null;
  let libraryError: string | null = null;

  try {
    library = await loadPromptLibrary(path);
  } catch (error) {
    libraryError = error instanceof Error ? error.message : String(error);
  }

  for (const node of promptNodes) {
    const params = node.params ?? {};
    const mode = typeof params.mode === "string" ? params.mode : "";
    const category = String(params.category ?? "").trim();
    const promptId = String(params.promptId ?? "").trim();
    const embeddedText = typeof params.embeddedText === "string" ? params.embeddedText : "";
    const nodePath = `nodes.${node.id}.params`;

    if (!mode) issues.push({ path: `${nodePath}.mode`, message: "mode is required for library.prompt." });
    if (mode !== "linked" && mode !== "embedded") issues.push({ path: `${nodePath}.mode`, message: 'mode must be "linked" or "embedded".' });

    if (mode === "embedded") {
      if (!embeddedText.trim()) issues.push({ path: `${nodePath}.embeddedText`, message: "embeddedText is required when library.prompt mode is embedded." });
      continue;
    }

    if (!category) issues.push({ path: `${nodePath}.category`, message: "category is required when library.prompt mode is linked." });
    if (!promptId) issues.push({ path: `${nodePath}.promptId`, message: "promptId is required when library.prompt mode is linked." });
    if (category && promptId) {
      if (libraryError) {
        issues.push({ path: nodePath, message: libraryError });
      } else if (!findPrompt(library!, category, promptId)) {
        issues.push({ path: nodePath, message: `Linked prompt "${category}/${promptId}" was not found in the local prompt library.` });
      }
    }
  }

  return issues;
}

export async function resolvePromptLibraryText(params: Record<string, unknown>, path = getPromptLibraryPath()): Promise<string> {
  const mode = typeof params.mode === "string" ? params.mode : "";
  const category = String(params.category ?? "").trim();
  const promptId = String(params.promptId ?? "").trim();

  if (!mode) throw new Error("library.prompt requires params.mode.");
  if (mode === "embedded") {
    const embeddedText = typeof params.embeddedText === "string" ? params.embeddedText : "";
    if (!embeddedText.trim()) throw new Error("library.prompt embedded mode requires params.embeddedText.");
    return embeddedText;
  }
  if (mode !== "linked") throw new Error('library.prompt params.mode must be "linked" or "embedded".');
  if (!category) throw new Error("library.prompt linked mode requires params.category.");
  if (!promptId) throw new Error("library.prompt linked mode requires params.promptId.");

  const library = await loadPromptLibrary(path);
  const prompt = findPrompt(library, category, promptId);
  if (!prompt) throw new Error(`Linked prompt "${category}/${promptId}" was not found in the local prompt library.`);
  return prompt.text;
}

function findPrompt(library: PromptLibrary, categoryId: string, promptId: string): PromptLibraryPrompt | null {
  return library.categories.find((category) => category.id === categoryId)?.prompts.find((prompt) => prompt.id === promptId) ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type LocalAssetKind = "file" | "image" | "video";

export interface LocalAssetMetadata {
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
}

export async function getLocalAssetMetadata(path: string, kind: LocalAssetKind): Promise<LocalAssetMetadata> {
  if (!path.trim()) throw new Error(`${kind} input requires params.path.`);
  const resolvedPath = resolve(path);
  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    throw new Error(`Local ${kind} file was not found: ${resolvedPath}`);
  }
  if (!fileStat.isFile()) throw new Error(`Local ${kind} path is not a file: ${resolvedPath}`);

  const mimeType = getMimeType(resolvedPath);
  if (kind === "image" && !mimeType.startsWith("image/")) {
    throw new Error(`input.image expected an image file, got ${mimeType}: ${resolvedPath}`);
  }
  if (kind === "video" && !mimeType.startsWith("video/")) {
    throw new Error(`input.video expected a video file, got ${mimeType}: ${resolvedPath}`);
  }

  const metadata: LocalAssetMetadata = {
    path: resolvedPath,
    filename: basename(resolvedPath),
    mimeType,
    sizeBytes: fileStat.size
  };

  if (kind === "image") {
    const dimensions = readImageDimensions(await readFile(resolvedPath), mimeType);
    metadata.width = dimensions.width;
    metadata.height = dimensions.height;
  }

  return metadata;
}

function firstInputValue(inputs: Record<string, unknown>): unknown {
  const first = Object.values(inputs)[0];
  if (first && typeof first === "object" && "text" in first) return (first as { text: unknown }).text;
  return first;
}

function firstInputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) {
    const text = (value as Record<string, unknown>).text;
    return text === undefined || text === null ? undefined : String(text);
  }
  return String(value);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeHttpMethod(value: unknown): string {
  const method = String(value ?? "").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("http.request requires params.method to be GET, POST, PUT, PATCH, or DELETE.");
  return method;
}

function parseJsonObject(value: unknown, label: string): Record<string, string> {
  if (value === undefined || value === null || value === "") return {};
  const parsed = typeof value === "string" ? parseJsonText(value, label) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`http.request ${label} must be a JSON object.`);
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]));
}

function parseJsonText(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${errorMessage(error)}`);
  }
}

function buildRequestUrl(url: string, query: Record<string, string>): string {
  const result = new URL(url);
  for (const [key, value] of Object.entries(query)) result.searchParams.set(key, value);
  return result.toString();
}

function buildHttpBody(bodyMode: string, value: unknown, inputs: Record<string, unknown>): BodyInit | undefined {
  if (bodyMode === "none") return undefined;
  const bodyValue = value ?? inputs.json ?? inputs.text ?? firstInputValue(inputs);
  if (bodyMode === "rawText") return typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue);
  if (bodyMode === "rawJson") return JSON.stringify(typeof bodyValue === "string" ? parseJsonText(bodyValue, "body") : bodyValue ?? {});
  throw new Error('http.request params.bodyMode must be "none", "rawJson", or "rawText".');
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function writeBase64Image(data: string, options: { outputDirectory: string; sourceNodeId: string; endpoint: string }) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(data);
  const mimeType = match?.[1] ?? "image/png";
  const base64 = match?.[2] ?? data;
  const bytes = Buffer.from(base64, "base64");
  const assetsDirectory = join(options.outputDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const filename = `${sanitizeFilename(options.sourceNodeId)}-${Date.now()}${extensionForMime(mimeType)}`;
  const localPath = join(assetsDirectory, filename);
  await writeFile(localPath, bytes);
  const metadata = {
    localPath,
    path: localPath,
    filename,
    mimeType,
    sizeBytes: bytes.length,
    sourceNodeId: options.sourceNodeId,
    localBackend: "stable-diffusion-webui-compatible",
    endpoint: options.endpoint
  };
  await writeFile(join(assetsDirectory, `${filename}.json`), JSON.stringify(metadata, null, 2), "utf8");
  return metadata;
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

function preprocessControlImage(source: RgbaImage, options: {
  width: number;
  height: number;
  resizeMode: string;
  grayscale: boolean;
  invert: boolean;
  threshold?: number;
  contrast?: number;
}): RgbaImage {
  const resized = resizeRgbaImage(source, options.width, options.height, options.resizeMode);
  const data = new Uint8Array(resized.data);
  const contrast = options.contrast === undefined ? undefined : Math.max(0, options.contrast);
  const contrastFactor = contrast === undefined ? 1 : contrast;
  const threshold = options.threshold === undefined ? undefined : clamp(Math.round(options.threshold), 0, 255);
  for (let index = 0; index < data.length; index += 4) {
    let red = data[index];
    let green = data[index + 1];
    let blue = data[index + 2];
    if (options.grayscale) {
      const gray = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
      red = gray;
      green = gray;
      blue = gray;
    }
    if (contrast !== undefined) {
      red = clamp(Math.round((red - 128) * contrastFactor + 128), 0, 255);
      green = clamp(Math.round((green - 128) * contrastFactor + 128), 0, 255);
      blue = clamp(Math.round((blue - 128) * contrastFactor + 128), 0, 255);
    }
    if (threshold !== undefined) {
      const gray = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
      const value = gray >= threshold ? 255 : 0;
      red = value;
      green = value;
      blue = value;
    }
    if (options.invert) {
      red = 255 - red;
      green = 255 - green;
      blue = 255 - blue;
    }
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
    data[index + 3] = 255;
  }
  return { width: resized.width, height: resized.height, data };
}

function resizeRgbaImage(source: RgbaImage, targetWidth: number, targetHeight: number, resizeMode: string): RgbaImage {
  if (resizeMode === "Just Resize") return resampleRgbaImage(source, targetWidth, targetHeight);
  const outerFit = resizeMode === "Envelope (Outer Fit)";
  const scale = outerFit
    ? Math.max(targetWidth / source.width, targetHeight / source.height)
    : Math.min(targetWidth / source.width, targetHeight / source.height);
  const scaledWidth = Math.max(1, Math.round(source.width * scale));
  const scaledHeight = Math.max(1, Math.round(source.height * scale));
  const scaled = resampleRgbaImage(source, scaledWidth, scaledHeight);
  const output = new Uint8Array(targetWidth * targetHeight * 4);
  output.fill(255);
  for (let pixel = 0; pixel < targetWidth * targetHeight; pixel += 1) output[pixel * 4 + 3] = 255;
  const offsetX = Math.floor((targetWidth - scaledWidth) / 2);
  const offsetY = Math.floor((targetHeight - scaledHeight) / 2);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = y - offsetY;
    if (sourceY < 0 || sourceY >= scaledHeight) continue;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = x - offsetX;
      if (sourceX < 0 || sourceX >= scaledWidth) continue;
      const sourceIndex = (sourceY * scaledWidth + sourceX) * 4;
      const targetIndex = (y * targetWidth + x) * 4;
      output[targetIndex] = scaled.data[sourceIndex];
      output[targetIndex + 1] = scaled.data[sourceIndex + 1];
      output[targetIndex + 2] = scaled.data[sourceIndex + 2];
      output[targetIndex + 3] = scaled.data[sourceIndex + 3];
    }
  }
  return { width: targetWidth, height: targetHeight, data: output };
}

function resolveResizeDimensions(source: RgbaImage, options: { width?: number; height?: number; preserveAspectRatio: boolean }): { width: number; height: number } {
  const requestedWidth = options.width === undefined ? undefined : Math.round(options.width);
  const requestedHeight = options.height === undefined ? undefined : Math.round(options.height);
  if (requestedWidth !== undefined && requestedWidth <= 0) throw new Error("params.width must be a positive number.");
  if (requestedHeight !== undefined && requestedHeight <= 0) throw new Error("params.height must be a positive number.");
  if (!options.preserveAspectRatio) {
    return {
      width: requestedWidth ?? source.width,
      height: requestedHeight ?? source.height
    };
  }
  if (requestedWidth === undefined && requestedHeight === undefined) return { width: source.width, height: source.height };
  if (requestedWidth !== undefined && requestedHeight === undefined) {
    return {
      width: requestedWidth,
      height: Math.max(1, Math.round(requestedWidth * source.height / source.width))
    };
  }
  if (requestedWidth === undefined && requestedHeight !== undefined) {
    return {
      width: Math.max(1, Math.round(requestedHeight * source.width / source.height)),
      height: requestedHeight
    };
  }
  const scale = Math.min(requestedWidth! / source.width, requestedHeight! / source.height);
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale))
  };
}

function resampleRgbaImage(source: RgbaImage, targetWidth: number, targetHeight: number): RgbaImage {
  const output = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = clamp(Math.floor((y + 0.5) * source.height / targetHeight), 0, source.height - 1);
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = clamp(Math.floor((x + 0.5) * source.width / targetWidth), 0, source.width - 1);
      const sourceIndex = (sourceY * source.width + sourceX) * 4;
      const targetIndex = (y * targetWidth + x) * 4;
      output[targetIndex] = source.data[sourceIndex];
      output[targetIndex + 1] = source.data[sourceIndex + 1];
      output[targetIndex + 2] = source.data[sourceIndex + 2];
      output[targetIndex + 3] = source.data[sourceIndex + 3];
    }
  }
  return { width: targetWidth, height: targetHeight, data: output };
}

async function readLocalPngImage(value: unknown, nodeType: string): Promise<RgbaImage> {
  const image = normalizePreviewImage(value) as Record<string, unknown>;
  const mimeType = typeof image.mimeType === "string" ? image.mimeType : "image/png";
  let bytes: Buffer;
  if (typeof image.base64 === "string") {
    if (mimeType !== "image/png") throw new Error(`${nodeType} currently supports PNG image data only.`);
    bytes = Buffer.from(image.base64, "base64");
  } else {
    const path = image.localPath ?? image.path;
    if (typeof path !== "string" || /^https?:\/\//i.test(path)) throw new Error(`${nodeType} requires a local PNG image path or base64 PNG image.`);
    if (getMimeType(path) !== "image/png") throw new Error(`${nodeType} currently supports PNG files only.`);
    bytes = await readFile(resolve(path));
  }
  return decodePngToRgba(bytes);
}

function projectEquirectangularToFisheye(source: RgbaImage, options: { outputSize: number; fovDegrees: number; yawDegrees: number; pitchDegrees: number; background: [number, number, number, number] }): RgbaImage {
  const outputSize = options.outputSize;
  const output = new Uint8Array(outputSize * outputSize * 4);
  const [backgroundR, backgroundG, backgroundB, backgroundA] = options.background;
  const radius = outputSize / 2;
  const maxTheta = (options.fovDegrees * Math.PI) / 360;
  const yaw = (options.yawDegrees * Math.PI) / 180;
  const pitch = (options.pitchDegrees * Math.PI) / 180;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);

  for (let y = 0; y < outputSize; y += 1) {
    const normalizedY = ((y + 0.5) - radius) / radius;
    for (let x = 0; x < outputSize; x += 1) {
      const normalizedX = ((x + 0.5) - radius) / radius;
      const distance = Math.hypot(normalizedX, normalizedY);
      const outputIndex = (y * outputSize + x) * 4;
      if (distance > 1) {
        output[outputIndex] = backgroundR;
        output[outputIndex + 1] = backgroundG;
        output[outputIndex + 2] = backgroundB;
        output[outputIndex + 3] = backgroundA;
        continue;
      }
      const theta = distance * maxTheta;
      const phi = Math.atan2(normalizedY, normalizedX);
      const sinTheta = Math.sin(theta);
      const cameraX = sinTheta * Math.cos(phi);
      const cameraY = -sinTheta * Math.sin(phi);
      const cameraZ = Math.cos(theta);
      const pitchedY = cameraY * cosPitch - cameraZ * sinPitch;
      const pitchedZ = cameraY * sinPitch + cameraZ * cosPitch;
      const worldX = cameraX * cosYaw + pitchedZ * sinYaw;
      const worldY = pitchedY;
      const worldZ = -cameraX * sinYaw + pitchedZ * cosYaw;
      const longitude = Math.atan2(worldX, worldZ);
      const latitude = Math.asin(clamp(worldY, -1, 1));
      const sourceX = positiveModulo(Math.floor((longitude / (Math.PI * 2) + 0.5) * source.width), source.width);
      const sourceY = clamp(Math.floor((0.5 - latitude / Math.PI) * source.height), 0, source.height - 1);
      const sourceIndex = (sourceY * source.width + sourceX) * 4;
      output[outputIndex] = source.data[sourceIndex];
      output[outputIndex + 1] = source.data[sourceIndex + 1];
      output[outputIndex + 2] = source.data[sourceIndex + 2];
      output[outputIndex + 3] = source.data[sourceIndex + 3];
    }
  }

  return { width: outputSize, height: outputSize, data: output };
}

function projectEquirectangularToPerspective(source: RgbaImage, options: { width: number; height: number; fovDegrees: number; yawDegrees: number; pitchDegrees: number }): RgbaImage {
  const data = new Uint8Array(options.width * options.height * 4);
  const yaw = options.yawDegrees * Math.PI / 180;
  const pitch = options.pitchDegrees * Math.PI / 180;
  const tanV = Math.tan(options.fovDegrees * Math.PI / 360);
  const tanH = tanV * options.width / options.height;
  for (let y = 0; y < options.height; y += 1) for (let x = 0; x < options.width; x += 1) {
    const ny = (1 - ((y + 0.5) / options.height) * 2) * tanV;
    const nx = (((x + 0.5) / options.width) * 2 - 1) * tanH;
    const length = Math.hypot(nx, ny, 1);
    const cameraX = nx / length;
    const cameraY = ny / length;
    const cameraZ = 1 / length;
    const pitchedY = cameraY * Math.cos(pitch) - cameraZ * Math.sin(pitch);
    const pitchedZ = cameraY * Math.sin(pitch) + cameraZ * Math.cos(pitch);
    const worldX = cameraX * Math.cos(yaw) + pitchedZ * Math.sin(yaw);
    const worldZ = -cameraX * Math.sin(yaw) + pitchedZ * Math.cos(yaw);
    const sx = positiveModulo(Math.floor((Math.atan2(worldX, worldZ) / (Math.PI * 2) + 0.5) * source.width), source.width);
    const sy = clamp(Math.floor((0.5 - Math.asin(clamp(pitchedY, -1, 1)) / Math.PI) * source.height), 0, source.height - 1);
    const sourceIndex = (sy * source.width + sx) * 4;
    const targetIndex = (y * options.width + x) * 4;
    data.set(source.data.subarray(sourceIndex, sourceIndex + 4), targetIndex);
  }
  return { width: options.width, height: options.height, data };
}

function decodePngToRgba(buffer: Buffer): RgbaImage {
  assertPng(buffer);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("Invalid PNG chunk length.");
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error("Unsupported PNG compression, filter, or interlace method.");
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height || bitDepth !== 8) throw new Error("Only 8-bit PNG images are supported.");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error("Only grayscale, grayscale-alpha, RGB, and RGBA PNG images are supported.");
  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const unfiltered = new Uint8Array(width * height * channels);
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset++];
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? unfiltered[rowOffset + x - channels] : 0;
      const up = y > 0 ? unfiltered[rowOffset + x - stride] : 0;
      const upLeft = y > 0 && x >= channels ? unfiltered[rowOffset + x - stride - channels] : 0;
      const value = raw[rawOffset++];
      if (filter === 0) unfiltered[rowOffset + x] = value;
      else if (filter === 1) unfiltered[rowOffset + x] = (value + left) & 0xff;
      else if (filter === 2) unfiltered[rowOffset + x] = (value + up) & 0xff;
      else if (filter === 3) unfiltered[rowOffset + x] = (value + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) unfiltered[rowOffset + x] = (value + paethPredictor(left, up, upLeft)) & 0xff;
      else throw new Error(`Unsupported PNG filter: ${filter}.`);
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sourceIndex = pixel * channels;
    const targetIndex = pixel * 4;
    if (channels === 1 || channels === 2) {
      rgba[targetIndex] = unfiltered[sourceIndex];
      rgba[targetIndex + 1] = unfiltered[sourceIndex];
      rgba[targetIndex + 2] = unfiltered[sourceIndex];
      rgba[targetIndex + 3] = channels === 2 ? unfiltered[sourceIndex + 1] : 255;
    } else {
      rgba[targetIndex] = unfiltered[sourceIndex];
      rgba[targetIndex + 1] = unfiltered[sourceIndex + 1];
      rgba[targetIndex + 2] = unfiltered[sourceIndex + 2];
      rgba[targetIndex + 3] = channels === 4 ? unfiltered[sourceIndex + 3] : 255;
    }
  }
  return { width, height, data: rgba };
}

function encodeRgbaPng(width: number, height: number, data: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk("IHDR", header),
    createPngChunk("IDAT", deflateSync(raw)),
    createPngChunk("IEND", Buffer.alloc(0))
  ]);
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function numberParam(value: unknown, fallback: number): number {
  const number = Number(typeof value === "string" ? value.replace(",", ".") : value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

function optionalNumberParam(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(typeof value === "string" ? value.replace(",", ".") : value);
  if (!Number.isFinite(number)) throw new Error(`params.${label} must be a number.`);
  return number;
}

function integerParam(value: unknown, fallback: number, label: string): number {
  const number = Math.round(numberParam(value, fallback));
  if (number <= 0) throw new Error(`params.${label} must be a positive number.`);
  return number;
}

function clampedNumberParam(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const number = numberParam(value, fallback);
  if (number < min || number > max) throw new Error(`params.${label} must be between ${min} and ${max}.`);
  return number;
}

function positiveNumberParam(value: unknown, fallback: number, label: string): number {
  const number = numberParam(value, fallback);
  if (number <= 0) throw new Error(`local.stableDiffusion.textToImage params.${label} must be a positive number.`);
  return number;
}

function parseRgbaParam(value: unknown, fallback: [number, number, number, number]): [number, number, number, number] {
  if (value === undefined || value === null || value === "") return fallback;
  if (Array.isArray(value)) {
    const channels = value.map((channel) => clamp(Math.round(numberParam(channel, 0)), 0, 255));
    return [channels[0] ?? fallback[0], channels[1] ?? fallback[1], channels[2] ?? fallback[2], channels[3] ?? fallback[3]];
  }
  if (typeof value === "string") {
    const match = /^#?([a-f0-9]{6})([a-f0-9]{2})?$/i.exec(value.trim());
    if (!match) throw new Error("params.background must be an RGBA array or #RRGGBB/#RRGGBBAA color.");
    const hex = match[1];
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
      match[2] ? Number.parseInt(match[2], 16) : 255
    ];
  }
  throw new Error("params.background must be an RGBA array or #RRGGBB/#RRGGBBAA color.");
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return Boolean(value);
}

function enumParam<T extends string>(value: unknown, fallback: T, allowed: readonly T[], label: string): T {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (allowed.includes(candidate as T)) return candidate as T;
  throw new Error(`params.${label} must be one of: ${allowed.join(", ")}.`);
}

function extractControlNetModelNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["model_list", "models", "modelList"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  return [];
}

function filterDefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function getMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo"
  };
  return mimeTypes[ext] ?? "application/octet-stream";
}

function readImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } {
  if (mimeType === "image/png") {
    if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") throw new Error("Invalid PNG image.");
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === "image/jpeg") return readJpegDimensions(buffer);
  if (mimeType === "image/webp") return readWebpDimensions(buffer);
  throw new Error(`Unsupported image metadata format: ${mimeType}. Supported formats: png, jpg, webp.`);
}

export function readPngTextChunk(buffer: Buffer, key: string): string | null {
  assertPng(buffer);
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("Invalid PNG chunk length.");
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "iTXt") {
      const parsed = parseITxtChunk(data);
      if (parsed?.key === key) return parsed.text;
    }
    if (type === "tEXt") {
      const separator = data.indexOf(0);
      if (separator > 0 && data.toString("latin1", 0, separator) === key) return data.toString("utf8", separator + 1);
    }
    if (type === "IEND") break;
    offset = dataEnd + 4;
  }
  return null;
}

export function writePngTextChunk(buffer: Buffer, key: string, text: string): Buffer {
  assertPng(buffer);
  const chunks: Buffer[] = [buffer.subarray(0, 8)];
  let offset = 8;
  let inserted = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buffer.length) throw new Error("Invalid PNG chunk length.");
    const data = buffer.subarray(dataStart, dataEnd);
    const sameKey = (type === "iTXt" && parseITxtChunk(data)?.key === key) || (type === "tEXt" && data.indexOf(0) > 0 && data.toString("latin1", 0, data.indexOf(0)) === key);
    if (type === "IEND" && !inserted) {
      chunks.push(createITxtChunk(key, text));
      inserted = true;
    }
    if (!sameKey) chunks.push(buffer.subarray(offset, chunkEnd));
    if (type === "IEND") break;
    offset = chunkEnd;
  }
  if (!inserted) throw new Error("PNG file is missing IEND chunk.");
  return Buffer.concat(chunks);
}

function assertPng(buffer: Buffer): void {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") throw new Error("Invalid PNG image.");
}

function parseITxtChunk(data: Buffer): { key: string; text: string } | null {
  const keyEnd = data.indexOf(0);
  if (keyEnd <= 0 || keyEnd + 5 > data.length) return null;
  const compressionFlag = data[keyEnd + 1];
  if (compressionFlag !== 0) return null;
  let offset = keyEnd + 3;
  const languageEnd = data.indexOf(0, offset);
  if (languageEnd < 0) return null;
  offset = languageEnd + 1;
  const translatedEnd = data.indexOf(0, offset);
  if (translatedEnd < 0) return null;
  return { key: data.toString("latin1", 0, keyEnd), text: data.toString("utf8", translatedEnd + 1) };
}

function createITxtChunk(key: string, text: string): Buffer {
  const keyword = Buffer.from(key, "latin1");
  const payload = Buffer.concat([keyword, Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, "utf8")]);
  return createPngChunk("iTXt", payload);
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("Could not read JPEG dimensions.");
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("Invalid WebP image.");
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }
  if (chunk === "VP8 ") {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }
  if (chunk === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }
  throw new Error("Could not read WebP dimensions.");
}
