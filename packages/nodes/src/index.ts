import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, join, parse } from "node:path";
import type { NodeRunner, RouteExecutor } from "@snarkroute/executor";
import type { RouteNode, ValidationIssue } from "@snarkroute/protocol";
export * from "./package-system";
import type { SnarkNodeManifest } from "./package-system";

export interface NodeDefinition {
  type: string;
  title: string;
  description: string;
  economics?: NodeEconomicsMetadata;
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
  tags?: string[];
  kind?: string;
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

export const builtInNodeDefinitions: NodeDefinition[] = [
  { type: "input.text", title: "Text Input", description: "Produces a text value from params.value.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "input.file", title: "Input File", description: "Reads metadata for a local file path.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "input.image", title: "Input Image", description: "Reads metadata and dimensions for a local image path.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "input.video", title: "Input Video", description: "Reads metadata for a local video path.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "library.prompt", title: "Prompt Library", description: "Outputs a saved local prompt or embedded text snippet.", economics: { license: "AGPL-3.0-or-later", notes: "Local library only; no marketplace or payment execution." } },
  { type: "preview.image", title: "Image Preview", description: "Passes through an image value for Studio preview.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "transform.template", title: "Template Transform", description: "Produces text from params.template after route template resolution.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "debug.log", title: "Debug Log", description: "Logs a message or value and passes the value through.", economics: { license: "AGPL-3.0-or-later", notes: "Metadata only; no payment execution." } },
  { type: "http.request", title: "HTTP Request", description: "Calls an arbitrary HTTP API through the backend.", economics: { license: "AGPL-3.0-or-later", notes: "Generic API executor; no tokens are stored by this node." } },
  { type: "local.stableDiffusion.textToImage", title: "Local Stable Diffusion", description: "Calls a local Stable Diffusion WebUI-compatible txt2img API.", economics: { license: "AGPL-3.0-or-later", notes: "Local executor metadata only; no payment execution." } },
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
  params: builtInParams(definition.type)
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

export const previewImageRunner: NodeRunner = ({ params, inputs }) => {
  const image = normalizePreviewImage(params.image ?? firstInputValue(inputs));
  return {
    output: { image }
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

export function registerBuiltInNodeRunners(executor: RouteExecutor): void {
  executor.registerNodeRunner("input.text", inputTextRunner);
  executor.registerNodeRunner("input.file", inputFileRunner);
  executor.registerNodeRunner("input.image", inputImageRunner);
  executor.registerNodeRunner("input.video", inputVideoRunner);
  executor.registerNodeRunner("library.prompt", promptLibraryRunner);
  executor.registerNodeRunner("preview.image", previewImageRunner);
  executor.registerNodeRunner("transform.template", transformTemplateRunner);
  executor.registerNodeRunner("debug.log", debugLogRunner);
  executor.registerNodeRunner("http.request", httpRequestRunner);
  executor.registerNodeRunner("local.stableDiffusion.textToImage", localStableDiffusionTextToImageRunner);
  executor.registerNodeRunner("output.text", outputTextRunner);
  executor.registerNodeRunner("output.file", outputFileRunner);
}

function builtInNodeCategory(type: string): string {
  if (type.startsWith("input.")) return "Input";
  if (type.startsWith("output.")) return "Output";
  if (type.startsWith("preview.")) return "Preview";
  if (type.startsWith("http.")) return "API / HTTP";
  if (type.startsWith("local.")) return "Local";
  if (type.startsWith("debug.")) return "Debug";
  if (type.startsWith("library.")) return "Text";
  return "Transform";
}

function builtInPermissions(type: string) {
  return {
    network: type === "http.request" || type === "local.stableDiffusion.textToImage",
    networkHosts: type === "local.stableDiffusion.textToImage" ? ["127.0.0.1", "localhost"] : [],
    readFiles: type === "input.file" || type === "input.image" || type === "input.video",
    writeOutputs: type === "output.file" || type === "local.stableDiffusion.textToImage",
    shell: false,
    env: []
  };
}

function builtInInputs(type: string) {
  if (type === "preview.image") return [{ id: "image", type: "image", required: true, label: "Image" }];
  if (type === "debug.log") return [{ id: "value", type: "data", required: false, label: "Value" }];
  if (type === "output.text") return [{ id: "from", type: "data", required: false, label: "From" }];
  if (type === "output.file") return [{ id: "from", type: "data", required: false, label: "From" }];
  if (type === "local.stableDiffusion.textToImage") return [{ id: "prompt", type: "text", required: false, label: "Prompt" }];
  return [];
}

function builtInOutputs(type: string) {
  if (type === "input.text" || type === "library.prompt" || type === "transform.template" || type === "output.text") return [{ id: "text", type: "text", label: "Text" }];
  if (type === "input.file" || type === "output.file") return [{ id: "file", type: "file", label: "File" }];
  if (type === "input.image" || type === "preview.image" || type === "local.stableDiffusion.textToImage") return [{ id: "image", type: "image", label: "Image" }];
  if (type === "input.video") return [{ id: "video", type: "video", label: "Video" }];
  if (type === "http.request") return [{ id: "responseJson", type: "json", label: "JSON" }, { id: "responseText", type: "text", label: "Text" }];
  if (type === "debug.log") return [{ id: "value", type: "data", label: "Value" }];
  return [{ id: "output", type: "data", label: "Output" }];
}

function builtInParams(type: string) {
  if (type === "input.text") return [{ id: "value", type: "text", label: "Value", default: "" }];
  if (type === "input.file" || type === "input.image" || type === "input.video") return [{ id: "path", type: "file", label: "Path", default: "" }];
  if (type === "transform.template") return [{ id: "template", type: "text", label: "Template", default: "" }];
  if (type === "http.request") {
    return [
      { id: "url", type: "text", label: "URL", default: "" },
      { id: "method", type: "text", label: "Method", default: "GET" }
    ];
  }
  return [];
}

export function normalizePreviewImage(value: unknown): unknown {
  if (Array.isArray(value)) return normalizePreviewImage(value[0]);
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return { originalUrl: value };
    if (/\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(value)) return { localPath: value, path: value };
    throw new Error("preview.image expected an image URL or image file path.");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const image = record.image ? normalizePreviewImage(record.image) : record;
    const candidate = image as Record<string, unknown>;
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
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      diagnostics.push({ path: file, severity: "error", message: `Could not read prompt file: ${errorMessage(error)}` });
      continue;
    }

    const parsed = parsePromptFile(text, file);
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
  const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())) : undefined;

  return {
    prompt: {
      id,
      title,
      category,
      description: description || undefined,
      tags,
      kind: kind || undefined,
      ref: `${category}/${id}`,
      path,
      text: body
    }
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
    else if (entry.isFile() && entry.name.endsWith(".prompt.md")) files.push(path);
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
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        const listMatch = /^\s*-\s*(.*)$/.exec(next);
        if (!listMatch) break;
        list.push(unquote(listMatch[1].trim()));
        index += 1;
      }
      result[key] = list.length > 0 ? list : "";
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

function numberParam(value: unknown, fallback: number): number {
  const number = Number(typeof value === "string" ? value.replace(",", ".") : value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumberParam(value: unknown, fallback: number, label: string): number {
  const number = numberParam(value, fallback);
  if (number <= 0) throw new Error(`local.stableDiffusion.textToImage params.${label} must be a positive number.`);
  return number;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return Boolean(value);
}

function filterDefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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
