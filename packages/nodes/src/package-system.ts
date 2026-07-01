import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, normalize, parse, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import type { NodeRunner, RouteExecutor } from "@snarkroute/executor";
import type { OpenRoute, RouteEdge, RouteNode, ValidationIssue } from "@snarkroute/protocol";

export type SnarkNodeOrigin = "bundled" | "local" | "installed" | "linked" | "remote" | "generated";
export type SnarkNodeRuntime = "builtin" | "node" | "javascript" | "typescript";
export type SnarkNodeExecutorType = "declarative" | "declarative.http" | "plugin" | "builtin";

export interface NodePortManifest {
  id: string;
  type: string;
  required?: boolean;
  label?: string;
  description?: string;
}

export interface NodeParamManifest extends NodePortManifest {
  default?: unknown;
  options?: Array<{ value: unknown; label?: string }>;
  min?: number;
  max?: number;
  step?: number;
  binding?: { nodeId: string; paramId: string };
}

export interface NodeCapabilityManifest {
  id: string;
  title?: string;
  defaultParams?: Record<string, unknown>;
  priority?: number;
}

export type CanvasActionIconManifest =
  | { kind: "preset"; name: string }
  | { kind: "custom"; svg?: string; dataUrl?: string };

export interface CanvasActionManifest {
  enabled: boolean;
  title?: string;
  description?: string;
  icon?: CanvasActionIconManifest;
  dialog?: {
    enabled: boolean;
    params: string[];
    preview?: Array<{
      kind: "image" | "video" | "audio" | "panorama360" | "splat";
      source: "input" | { output: string };
    }>;
  };
}

export interface NodePermissions {
  network: boolean;
  networkHosts?: string[];
  readFiles: boolean;
  writeOutputs: boolean;
  shell: boolean;
  env: string[];
}

export interface NodeExecutorManifest {
  type: SnarkNodeExecutorType;
  runtime?: SnarkNodeRuntime;
  entry?: string;
  builtinRunner?: string;
  method?: string;
  urlTemplate?: string;
  headersTemplate?: unknown;
  queryTemplate?: unknown;
  bodyMode?: "none" | "json" | "text";
  bodyTemplate?: unknown;
  response?: {
    mode?: "json" | "text" | "binary";
    mappings?: Record<string, string>;
  };
  timeoutMs?: number;
}

export interface SnarkNodeManifest {
  kind: "snarkroute.node";
  schemaVersion: string;
  id: string;
  title: string;
  version: string;
  author: { name: string; [key: string]: unknown };
  license: string;
  origin: SnarkNodeOrigin;
  permissions: NodePermissions;
  executor: NodeExecutorManifest;
  inputs: NodePortManifest[];
  outputs: NodePortManifest[];
  params?: NodeParamManifest[];
  capabilities?: NodeCapabilityManifest[];
  canvasAction?: CanvasActionManifest;
  ui?: unknown;
  description?: string;
  category?: string;
  icon?: string;
  tags?: string[];
  homepage?: string;
  repository?: string;
  source?: string;
  generatedWith?: unknown;
  examples?: unknown[];
  dependencies?: unknown;
  installConfirmation?: {
    confirmedAt: string;
    warnings: string[];
  };
  enabled?: boolean;
}

export interface SnarkNodeLibraryManifest {
  kind: "snarkroute.nodeLibrary";
  schemaVersion: string;
  id: string;
  title: string;
  version: string;
  author: { name: string; [key: string]: unknown };
  license: string;
  nodes: Array<{ id: string; title: string; url: string; version?: string; description?: string }>;
  description?: string;
  source?: string;
}

export interface NodeCatalogEntry {
  type: string;
  title: string;
  description: string;
  enabled?: boolean;
  manifest: SnarkNodeManifest;
}

export interface NodeManifestValidationResult {
  ok: boolean;
  manifest?: SnarkNodeManifest;
  issues: ValidationIssue[];
}

export interface NodeLibraryValidationResult {
  ok: boolean;
  library?: SnarkNodeLibraryManifest;
  issues: ValidationIssue[];
}

export interface InstallNodePackageOptions {
  installedDirectory?: string;
  source?: string;
  origin?: SnarkNodeOrigin;
  files?: Array<{ path: string; dataBase64?: string; text?: string }>;
  overwrite?: boolean;
}

export interface PackedNodePackagePreview {
  manifest: SnarkNodeManifest;
  files: Array<{ path: string; sizeBytes: number }>;
  totalSizeBytes: number;
  warnings: string[];
}

export interface PackNodePackageResult {
  manifest: SnarkNodeManifest;
  outputPath: string;
  files: string[];
}

export class NodePackageUninstallError extends Error {
  constructor(
    message: string,
    public readonly code: "NODE_PACKAGE_NOT_FOUND" | "NODE_PACKAGE_NOT_UNINSTALLABLE" | "NODE_PACKAGE_DELETE_FAILED",
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "NodePackageUninstallError";
  }
}

export const EMPTY_PERMISSIONS: NodePermissions = {
  network: false,
  networkHosts: [],
  readFiles: false,
  writeOutputs: false,
  shell: false,
  env: []
};

const SUPPORTED_PLUGIN_RUNTIMES = new Set<SnarkNodeRuntime>(["node", "javascript", "typescript"]);
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const MAX_PACKAGE_FILE_COUNT = 200;
const SKIPPED_PACK_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".vite", ".cache"]);
const SKIPPED_PACK_FILENAMES = new Set([".env", ".env.local", ".env.production", ".env.development"]);

export function getInstalledNodesDirectory(): string {
  if (process.env.SNARKROUTE_INSTALLED_NODES_PATH) return process.env.SNARKROUTE_INSTALLED_NODES_PATH;
  let directory = process.cwd();
  while (true) {
    const candidate = join(directory, "data", "installed-nodes");
    const parent = dirname(directory);
    if (existsSync(join(directory, "pnpm-workspace.yaml")) || parent === directory || directory === parse(directory).root) return candidate;
    directory = parent;
  }
}

export function nodeManifestToCatalogEntry(manifest: SnarkNodeManifest): NodeCatalogEntry {
  return {
    type: manifest.id,
    title: manifest.title,
    description: manifest.description ?? "",
    enabled: manifest.enabled !== false,
    manifest
  };
}

export function parseNodeManifestJson(text: string): unknown {
  return JSON.parse(text);
}

export function validateNodeManifest(input: unknown, options: { basePath?: string; existingIds?: Iterable<string> } = {}): NodeManifestValidationResult {
  const issues: ValidationIssue[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ path: "<root>", message: "Node manifest must be a JSON object." }] };
  }
  const record = input as Record<string, unknown>;
  stringEquals(record.kind, "snarkroute.node", "kind", issues);
  requiredString(record.schemaVersion, "schemaVersion", issues);
  const id = requiredString(record.id, "id", issues);
  if (id && !NODE_ID_PATTERN.test(id)) issues.push({ path: "id", message: "Node id must use letters, numbers, dots, dashes, or underscores." });
  if (id && options.existingIds && new Set(options.existingIds).has(id)) issues.push({ path: "id", message: `Duplicate node id "${id}".` });
  requiredString(record.title, "title", issues);
  requiredString(record.version, "version", issues);
  requiredString(record.license, "license", issues);
  validateAuthor(record.author, issues);
  validateOrigin(record.origin, issues);
  validatePermissions(record.permissions, issues);
  validateExecutor(record.executor, options.basePath, issues);
  validatePorts(record.inputs, "inputs", issues);
  validatePorts(record.outputs, "outputs", issues);
  if (record.params !== undefined) validatePorts(record.params, "params", issues);
  if (record.capabilities !== undefined) validateCapabilities(record.capabilities, issues);
  if (record.canvasAction !== undefined) validateCanvasAction(record.canvasAction, record.inputs, record.outputs, record.params, issues);

  return issues.length === 0 ? { ok: true, manifest: normalizeNodeManifest(record), issues: [] } : { ok: false, issues };
}

export function validateNodeLibraryManifest(input: unknown): NodeLibraryValidationResult {
  const issues: ValidationIssue[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ path: "<root>", message: "Node library manifest must be a JSON object." }] };
  }
  const record = input as Record<string, unknown>;
  stringEquals(record.kind, "snarkroute.nodeLibrary", "kind", issues);
  requiredString(record.schemaVersion, "schemaVersion", issues);
  const id = requiredString(record.id, "id", issues);
  if (id && !NODE_ID_PATTERN.test(id)) issues.push({ path: "id", message: "Library id must use letters, numbers, dots, dashes, or underscores." });
  requiredString(record.title, "title", issues);
  requiredString(record.version, "version", issues);
  requiredString(record.license, "license", issues);
  validateAuthor(record.author, issues);
  if (!Array.isArray(record.nodes) || record.nodes.length === 0) {
    issues.push({ path: "nodes", message: "nodes must be a non-empty array." });
  } else {
    record.nodes.forEach((node, index) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        issues.push({ path: `nodes.${index}`, message: "Library node entry must be an object." });
        return;
      }
      const entry = node as Record<string, unknown>;
      requiredString(entry.id, `nodes.${index}.id`, issues);
      requiredString(entry.title, `nodes.${index}.title`, issues);
      const url = requiredString(entry.url, `nodes.${index}.url`, issues);
      if (url && !isSupportedRemoteUrl(url)) issues.push({ path: `nodes.${index}.url`, message: "Node URL must be http or https." });
    });
  }
  return issues.length === 0 ? { ok: true, library: record as unknown as SnarkNodeLibraryManifest, issues: [] } : { ok: false, issues };
}

export async function installNodePackageFromManifest(manifestInput: unknown, options: InstallNodePackageOptions = {}): Promise<SnarkNodeManifest> {
  const directory = options.installedDirectory ?? getInstalledNodesDirectory();
  const validation = validateNodeManifest(manifestInput);
  if (!validation.ok || !validation.manifest) throw new Error(formatIssues(validation.issues));
  const manifest = {
    ...validation.manifest,
    origin: options.origin ?? "installed",
    source: options.source ?? validation.manifest.source ?? "local-file",
    installConfirmation: {
      confirmedAt: new Date().toISOString(),
      warnings: packageWarnings(validation.manifest)
    },
    enabled: true
  } satisfies SnarkNodeManifest;
  const target = join(directory, sanitizePackageDirectory(manifest.id));
  if (existsSync(target) && options.overwrite !== true) {
    throw new Error(`Installed node "${manifest.id}" already exists.`);
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const file of options.files ?? []) {
    const relative = safePackageRelativePath(file.path);
    if (relative === "manifest.json") continue;
    const destination = join(target, relative);
    await mkdir(dirname(destination), { recursive: true });
    if (file.dataBase64) await writeFile(destination, Buffer.from(file.dataBase64, "base64"));
    else await writeFile(destination, file.text ?? "", "utf8");
  }
  const postInstallValidation = validateNodeManifest(manifest, { basePath: target });
  if (!postInstallValidation.ok) {
    await rm(target, { recursive: true, force: true });
    throw new Error(formatIssues(postInstallValidation.issues));
  }
  return manifest;
}

export async function previewNodePackageArchive(data: Buffer, options: { source?: string; origin?: SnarkNodeOrigin; existingIds?: Iterable<string> } = {}): Promise<PackedNodePackagePreview> {
  const files = await readArchiveFiles(data);
  const manifestFile = files.find((file) => file.path === "manifest.json");
  if (!manifestFile) throw new Error("Archive must contain manifest.json at the package root.");
  const manifestInput = JSON.parse(manifestFile.data.toString("utf8"));
  const validation = validateNodeManifest(
    {
      ...(manifestInput as object),
      source: options.source ?? (manifestInput as { source?: string }).source,
      origin: options.origin ?? (manifestInput as { origin?: SnarkNodeOrigin }).origin ?? "local"
    },
    { existingIds: options.existingIds }
  );
  if (!validation.ok || !validation.manifest) throw new Error(formatIssues(validation.issues));
  validatePackageFileSet(validation.manifest, files.map((file) => file.path));
  return {
    manifest: validation.manifest,
    files: files.map((file) => ({ path: file.path, sizeBytes: file.data.byteLength })),
    totalSizeBytes: files.reduce((sum, file) => sum + file.data.byteLength, 0),
    warnings: packageWarnings(validation.manifest)
  };
}

export async function installNodePackageFromArchive(data: Buffer, options: InstallNodePackageOptions = {}): Promise<SnarkNodeManifest> {
  const files = await readArchiveFiles(data);
  const manifestFile = files.find((file) => file.path === "manifest.json");
  if (!manifestFile) throw new Error("Archive must contain manifest.json at the package root.");
  const manifestInput = JSON.parse(manifestFile.data.toString("utf8"));
  const validation = validateNodeManifest(
    {
      ...(manifestInput as object),
      origin: options.origin ?? "installed",
      source: options.source ?? (manifestInput as { source?: string }).source ?? "local-file"
    }
  );
  if (!validation.ok || !validation.manifest) throw new Error(formatIssues(validation.issues));
  validatePackageFileSet(validation.manifest, files.map((file) => file.path));
  return installNodePackageFromManifest(validation.manifest, {
    ...options,
    source: options.source ?? validation.manifest.source ?? "local-file",
    origin: options.origin ?? "installed",
    files: files.filter((file) => file.path !== "manifest.json").map((file) => ({ path: file.path, dataBase64: file.data.toString("base64") })),
    overwrite: options.overwrite ?? true
  });
}

export async function installNodePackageFromPath(packagePath: string, options: InstallNodePackageOptions = {}): Promise<SnarkNodeManifest> {
  const source = resolve(packagePath);
  const fileStat = await stat(source);
  if (fileStat.isDirectory()) {
    const manifestPath = join(source, "manifest.json");
    const validation = validateNodeManifest(JSON.parse(await readFile(manifestPath, "utf8")), { basePath: source });
    if (!validation.ok || !validation.manifest) throw new Error(formatIssues(validation.issues));
    const manifest = {
      ...validation.manifest,
      origin: options.origin ?? "installed",
      source: options.source ?? source,
      installConfirmation: {
        confirmedAt: new Date().toISOString(),
        warnings: packageWarnings(validation.manifest)
      },
      enabled: true
    } satisfies SnarkNodeManifest;
    const target = join(options.installedDirectory ?? getInstalledNodesDirectory(), sanitizePackageDirectory(manifest.id));
    if (existsSync(target) && options.overwrite !== true) throw new Error(`Installed node "${manifest.id}" already exists.`);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await copyPackageFiles(source, target);
    await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const installedValidation = validateNodeManifest(manifest, { basePath: target });
    if (!installedValidation.ok) {
      await rm(target, { recursive: true, force: true });
      throw new Error(formatIssues(installedValidation.issues));
    }
    return manifest;
  }
  if (isSnarkNodeArchiveFilename(source)) {
    return installNodePackageFromArchive(await readFile(source), { ...options, source: options.source ?? source });
  }
  const manifest = JSON.parse(await readFile(source, "utf8"));
  return installNodePackageFromManifest(manifest, { ...options, source: options.source ?? source });
}

export async function packNodePackage(sourceDirectory: string, outputPath?: string): Promise<PackNodePackageResult> {
  const source = resolve(sourceDirectory);
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) throw new Error(`Node package source must be a directory: ${source}`);
  const manifestPath = join(source, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const validation = validateNodeManifest(manifest, { basePath: source });
  if (!validation.ok || !validation.manifest) throw new Error(formatIssues(validation.issues));
  const files = await collectPackageFiles(source);
  validatePackageFileSet(validation.manifest, files.map((file) => file.relativePath));
  const zip = new JSZip();
  let totalSize = 0;
  for (const file of files) {
    totalSize += file.sizeBytes;
    if (totalSize > MAX_PACKAGE_BYTES) throw new Error(`Package is too large. Limit is ${MAX_PACKAGE_BYTES} bytes.`);
    zip.file(file.relativePath, await readFile(file.absolutePath));
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  const destination = resolve(outputPath ?? `${source.replace(/[\\/]$/, "")}.packed.snarknode`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return { manifest: validation.manifest, outputPath: destination, files: files.map((file) => file.relativePath) };
}

export async function loadInstalledNodeManifests(directory = getInstalledNodesDirectory()): Promise<SnarkNodeManifest[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests: SnarkNodeManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const basePath = join(directory, entry.name);
    try {
      const manifest = JSON.parse(await readFile(join(basePath, "manifest.json"), "utf8"));
      const validation = validateNodeManifest(manifest, { basePath });
      if (validation.ok && validation.manifest) manifests.push(validation.manifest);
    } catch {
      // Invalid installed packages are ignored here; explicit validation endpoints report details.
    }
  }
  return manifests.sort((left, right) => left.title.localeCompare(right.title));
}

export async function setInstalledNodeEnabled(id: string, enabled: boolean, directory = getInstalledNodesDirectory()): Promise<SnarkNodeManifest> {
  const packagePath = join(directory, sanitizePackageDirectory(id));
  const manifestPath = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnarkNodeManifest;
  manifest.enabled = enabled;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function uninstallInstalledNode(id: string, directory = getInstalledNodesDirectory()): Promise<void> {
  const packagePath = join(directory, sanitizePackageDirectory(id));
  try {
    const packageStat = await stat(packagePath);
    if (!packageStat.isDirectory()) throw new NodePackageUninstallError(`Installed node package "${id}" was not found.`, "NODE_PACKAGE_NOT_FOUND", 404);
  } catch (error) {
    if (error instanceof NodePackageUninstallError) throw error;
    throw new NodePackageUninstallError(`Installed node package "${id}" was not found.`, "NODE_PACKAGE_NOT_FOUND", 404);
  }

  let manifest: SnarkNodeManifest;
  try {
    manifest = JSON.parse(await readFile(join(packagePath, "manifest.json"), "utf8")) as SnarkNodeManifest;
  } catch {
    throw new NodePackageUninstallError(`Installed node package "${id}" is not uninstallable because its manifest could not be read.`, "NODE_PACKAGE_NOT_UNINSTALLABLE", 400);
  }

  if (manifest.id !== id) {
    throw new NodePackageUninstallError(`Installed node package "${id}" was not found.`, "NODE_PACKAGE_NOT_FOUND", 404);
  }

  if (manifest.origin === "bundled") {
    throw new NodePackageUninstallError(`Bundled node "${id}" cannot be deleted.`, "NODE_PACKAGE_NOT_UNINSTALLABLE", 400);
  }

  try {
    await rm(packagePath, { recursive: true, force: false });
  } catch (error) {
    throw new NodePackageUninstallError(`Filesystem deletion failed for node "${id}": ${error instanceof Error ? error.message : String(error)}`, "NODE_PACKAGE_DELETE_FAILED", 500);
  }
}

export async function validateRouteNodeTypes(nodes: RouteNode[], manifests: SnarkNodeManifest[]): Promise<ValidationIssue[]> {
  const available = new Set(manifests.filter((manifest) => manifest.enabled !== false).map((manifest) => manifest.id));
  const capabilities = new Set(
    manifests
      .filter((manifest) => manifest.enabled !== false)
      .flatMap((manifest) => manifest.capabilities ?? [])
      .map((capability) => capability.id)
  );
  return nodes
    .filter((node) => !available.has(node.type) && !isAvailableCapabilityNode(node, capabilities))
    .map((node) => ({ path: `nodes.${node.id}.type`, message: `This route uses node "${node.type}", but it is not installed. Install the node package or remove this node.` }));
}

export async function registerInstalledNodeRunners(executor: RouteExecutor, directory = getInstalledNodesDirectory()): Promise<void> {
  const manifests = await loadInstalledNodeManifests(directory);
  for (const manifest of manifests) {
    if (manifest.enabled === false) continue;
    if (manifest.executor.type === "declarative" && isCompoundTemplateManifest(manifest)) executor.registerNodeRunner(manifest.id, createCompoundTemplateNodeRunner(manifest, executor));
    if (manifest.executor.type === "plugin") executor.registerNodeRunner(manifest.id, createPluginNodeRunner(manifest, join(directory, sanitizePackageDirectory(manifest.id))));
    if (manifest.executor.type === "declarative.http") executor.registerNodeRunner(manifest.id, createDeclarativeHttpNodeRunner(manifest));
    for (const capability of manifest.capabilities ?? []) {
      executor.registerCapabilityProvider(capability.id, manifest.id, { defaultParams: capability.defaultParams, priority: capability.priority });
    }
  }
}

function isCompoundTemplateManifest(manifest: SnarkNodeManifest): boolean {
  const generated = manifest.generatedWith as { kind?: unknown; subroute?: unknown; compound?: unknown } | undefined;
  return generated?.kind === "compound.subroute" && Boolean(generated.subroute);
}

function createCompoundTemplateNodeRunner(manifest: SnarkNodeManifest, executor: RouteExecutor): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const generated = manifest.generatedWith as {
      compound?: { title?: string; inputs?: Array<{ id: string; nodeId: string; port?: string; targets?: Array<{ nodeId: string; port?: string }> }>; outputs?: Array<{ id: string; nodeId: string; port?: string }> };
      subroute?: OpenRoute;
    };
    if (!generated.subroute) throw new Error(`Generated node "${manifest.id}" has no subroute template.`);
    const syntheticNodes: RouteNode[] = [];
    const syntheticEdges: RouteEdge[] = [];
    const initialNodeOutputs: Record<string, unknown> = {};

    for (const port of generated.compound?.inputs ?? []) {
      const syntheticId = `${node.id}__input__${port.id}`;
      syntheticNodes.push({ id: syntheticId, type: "compound.input" });
      const targets = port.targets && port.targets.length > 0 ? port.targets : [{ nodeId: port.nodeId, port: port.port }];
      for (const target of targets) {
        syntheticEdges.push({ from: syntheticId, to: target.nodeId, fromPort: "value", toPort: target.port ?? port.id });
      }
      initialNodeOutputs[syntheticId] = { value: inputs[port.id] };
    }

    const boundParams = new Map<string, Record<string, unknown>>();
    for (const [paramId, value] of Object.entries(params)) {
      const param = manifest.params?.find((candidate) => candidate.id === paramId);
      if (!param?.binding) {
        context.log(`Warning: ignored unbound parameter "${paramId}".`, node.id);
        continue;
      }
      validateBoundParamValue(param, value);
      boundParams.set(param.binding.nodeId, {
        ...(boundParams.get(param.binding.nodeId) ?? {}),
        [param.binding.paramId]: value
      });
    }
    const internalNodes = generated.subroute.nodes.map((internalNode) => ({
      ...internalNode,
      ...(boundParams.has(internalNode.id) ? { params: { ...(internalNode.params ?? {}), ...boundParams.get(internalNode.id) } } : {})
    }));

    const subroute: OpenRoute = {
      ...generated.subroute,
      route: {
        ...generated.subroute.route,
        id: `${context.route.route.id}.${node.id}`,
        title: generated.compound?.title ?? node.title ?? manifest.title
      },
      nodes: [...syntheticNodes, ...internalNodes],
      edges: [...syntheticEdges, ...generated.subroute.edges]
    };
    const result = await executor.executeRoute(subroute, {
      runId: `${context.runId}_${node.id}`,
      outputDirectory: join(context.outputDirectory, node.id),
      initialNodeOutputs
    });
    if (result.status !== "succeeded") {
      const failed = Object.values(result.nodeResults).find((entry) => entry.status === "failed");
      throw new Error(`Generated node "${manifest.id}" failed inside "${failed?.nodeId ?? "subroute"}": ${failed?.error ?? "subroute failed"}`);
    }
    return {
      output: Object.fromEntries((generated.compound?.outputs ?? []).map((port) => [port.id, readOutputPort(result.nodeResults[port.nodeId]?.output, port.port ?? port.id)])),
      logs: [`Generated subroute node completed with ${Object.keys(result.nodeResults).length} internal node(s).`],
      provenance: { nodePackage: manifest.id, version: manifest.version, origin: manifest.origin, generatedWith: "compound.subroute" }
    };
  };
}

function validateBoundParamValue(param: NodeParamManifest, value: unknown): void {
  const valid = param.type === "number"
    ? typeof value === "number" && Number.isFinite(value)
    : param.type === "boolean"
      ? typeof value === "boolean"
      : param.type === "text" || param.type === "string"
        ? typeof value === "string"
        : true;
  if (!valid) throw new Error(`Parameter "${param.id}" must be ${param.type}.`);
  if (param.options && !param.options.some((option) => Object.is(option.value, value))) {
    throw new Error(`Parameter "${param.id}" must be one of its declared options.`);
  }
}

export function createDeclarativeHttpNodeRunner(manifest: SnarkNodeManifest): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const executor = manifest.executor;
    const method = String(executor.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error(`Declarative HTTP node "${manifest.id}" has unsupported method "${method}".`);
    const scope = { params, inputs };
    const url = interpolateTemplate(requiredExecutorString(executor.urlTemplate, "executor.urlTemplate"), scope);
    const headers = mapTemplateObject(executor.headersTemplate, scope);
    const query = mapTemplateObject(executor.queryTemplate, scope);
    const requestUrl = addQueryParams(url, query);
    const bodyMode = executor.bodyMode ?? "none";
    const body = buildDeclarativeHttpBody(bodyMode, executor.bodyTemplate, scope);
    const timeoutMs = typeof executor.timeoutMs === "number" ? executor.timeoutMs : 30000;
    const started = Date.now();
    let response: Response;
    try {
      response = await fetchWithTimeout(requestUrl, { method, headers, body }, timeoutMs);
    } catch (error) {
      throw new Error(`Declarative HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const responseMode = executor.response?.mode ?? "json";
    const responseText = responseMode === "binary" ? "" : await response.text();
    if (!response.ok) {
      context.log(`Declarative HTTP ${method} ${requestUrl} returned ${response.status}: ${truncate(responseText, 1000)}`, node.id);
      throw new Error(`Declarative HTTP request returned ${response.status} ${response.statusText}`.trim());
    }
    const responseJson = responseMode === "json" ? (responseText.trim() ? JSON.parse(responseText) : null) : null;
    const outputs = mapDeclarativeResponse(executor.response?.mappings, responseMode, responseJson, responseText);
    context.log(`Declarative HTTP node "${manifest.id}" used permissions: ${permissionSummaryForLog(manifest.permissions)}`, node.id);
    return {
      output: outputs,
      logs: [`HTTP ${method} ${requestUrl} -> ${response.status} (${Date.now() - started}ms)`],
      provenance: { nodePackage: manifest.id, version: manifest.version, executor: "declarative.http", url: redactUrl(requestUrl) }
    };
  };
}

export function createPluginNodeRunner(manifest: SnarkNodeManifest, packagePath: string): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    if (manifest.permissions.shell) throw new Error(`Node "${manifest.id}" requests shell permission. Shell execution is not supported in this SnarkRoute build.`);
    const entry = manifest.executor.entry;
    if (!entry) throw new Error(`Plugin node "${manifest.id}" is missing executor.entry.`);
    const modulePath = join(packagePath, safePackageRelativePath(entry));
    const module = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
    const runNode = module.runNode;
    if (typeof runNode !== "function") throw new Error(`Plugin node "${manifest.id}" executor must export async function runNode(context).`);
    const result = await runNode({
      node,
      inputs,
      params,
      env: pickAllowedEnv(manifest.permissions.env),
      permissions: manifest.permissions,
      assets: createPluginAssetHelpers(context.outputDirectory, node.id, manifest),
      logger: {
        info: (message: string) => context.log(String(message), node.id),
        warn: (message: string) => context.log(`Warning: ${String(message)}`, node.id),
        error: (message: string) => context.log(`Error: ${String(message)}`, node.id)
      },
      run: {
        id: context.runId,
        outputDirectory: context.outputDirectory
      }
    });
    const output = result && typeof result === "object" && "outputs" in result ? (result as Record<string, unknown>).outputs : result;
    return {
      output: output ?? {},
      logs: Array.isArray((result as Record<string, unknown> | undefined)?.logs) ? ((result as { logs: string[] }).logs) : [],
      metrics: objectOrUndefined((result as Record<string, unknown> | undefined)?.metrics),
      provenance: { nodePackage: manifest.id, version: manifest.version, origin: manifest.origin, source: manifest.source },
      providerUsage: undefined
    };
  };
}

export function isSupportedRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

function validateAuthor(value: unknown, issues: ValidationIssue[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path: "author", message: "author object is required." });
    return;
  }
  requiredString((value as Record<string, unknown>).name, "author.name", issues);
}

function validateOrigin(value: unknown, issues: ValidationIssue[]): void {
  if (!["bundled", "local", "installed", "linked", "remote", "generated"].includes(String(value))) {
    issues.push({ path: "origin", message: 'origin must be one of "bundled", "local", "installed", "linked", "remote", or "generated".' });
  }
}

function validatePermissions(value: unknown, issues: ValidationIssue[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path: "permissions", message: "permissions object is required." });
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["network", "readFiles", "writeOutputs", "shell"] as const) {
    if (typeof record[key] !== "boolean") issues.push({ path: `permissions.${key}`, message: `${key} must be boolean.` });
  }
  if (record.networkHosts !== undefined && (!Array.isArray(record.networkHosts) || !record.networkHosts.every((item) => typeof item === "string"))) {
    issues.push({ path: "permissions.networkHosts", message: "networkHosts must be an array of strings." });
  }
  if (!Array.isArray(record.env) || !record.env.every((item) => typeof item === "string" && /^[A-Z_][A-Z0-9_]*$/.test(item))) {
    issues.push({ path: "permissions.env", message: "env must be an array of environment variable names." });
  }
}

function validateExecutor(value: unknown, basePath: string | undefined, issues: ValidationIssue[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path: "executor", message: "executor object is required." });
    return;
  }
  const executor = value as Record<string, unknown>;
  const type = String(executor.type ?? "");
  if (!["declarative", "declarative.http", "plugin", "builtin"].includes(type)) issues.push({ path: "executor.type", message: 'executor.type must be "declarative", "declarative.http", "plugin", or "builtin".' });
  if (type === "declarative.http") {
    const method = String(executor.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) issues.push({ path: "executor.method", message: "Declarative HTTP method must be GET, POST, PUT, PATCH, or DELETE." });
    requiredString(executor.urlTemplate, "executor.urlTemplate", issues);
    const bodyMode = executor.bodyMode ?? "none";
    if (!["none", "json", "text"].includes(String(bodyMode))) issues.push({ path: "executor.bodyMode", message: 'bodyMode must be "none", "json", or "text".' });
    const response = executor.response;
    if (response !== undefined && (!response || typeof response !== "object" || Array.isArray(response))) {
      issues.push({ path: "executor.response", message: "response must be an object." });
    }
  }
  if (type === "plugin") {
    const runtime = String(executor.runtime ?? "");
    if (!SUPPORTED_PLUGIN_RUNTIMES.has(runtime as SnarkNodeRuntime)) issues.push({ path: "executor.runtime", message: "Unsupported plugin runtime." });
    const entry = requiredString(executor.entry, "executor.entry", issues);
    if (entry) {
      try {
        safePackageRelativePath(entry);
      } catch (error) {
        issues.push({ path: "executor.entry", message: error instanceof Error ? error.message : String(error) });
      }
      if (basePath && !existsSync(join(basePath, entry))) issues.push({ path: "executor.entry", message: `Executor file was not found: ${entry}` });
      if (entry && ![".js", ".mjs", ".cjs", ".ts"].includes(extname(entry).toLowerCase())) issues.push({ path: "executor.entry", message: "Executor entry must be .js, .mjs, .cjs, or .ts." });
    }
  }
}

function validatePorts(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${path} must be an array.` });
    return;
  }
  value.forEach((port, index) => {
    if (!port || typeof port !== "object" || Array.isArray(port)) {
      issues.push({ path: `${path}.${index}`, message: "Port must be an object." });
      return;
    }
    const record = port as Record<string, unknown>;
    requiredString(record.id, `${path}.${index}.id`, issues);
    requiredString(record.type, `${path}.${index}.type`, issues);
    if (record.required !== undefined && typeof record.required !== "boolean") issues.push({ path: `${path}.${index}.required`, message: "required must be boolean." });
  });
}

function validateCapabilities(value: unknown, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path: "capabilities", message: "capabilities must be an array." });
    return;
  }
  value.forEach((capability, index) => {
    if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
      issues.push({ path: `capabilities.${index}`, message: "Capability must be an object." });
      return;
    }
    const record = capability as Record<string, unknown>;
    const id = requiredString(record.id, `capabilities.${index}.id`, issues);
    if (id && !NODE_ID_PATTERN.test(id)) issues.push({ path: `capabilities.${index}.id`, message: "Capability id must use letters, numbers, dots, dashes, or underscores." });
    if (record.defaultParams !== undefined && (!record.defaultParams || typeof record.defaultParams !== "object" || Array.isArray(record.defaultParams))) {
      issues.push({ path: `capabilities.${index}.defaultParams`, message: "defaultParams must be an object." });
    }
    if (record.priority !== undefined && typeof record.priority !== "number") issues.push({ path: `capabilities.${index}.priority`, message: "priority must be a number." });
  });
}

function validateCanvasAction(value: unknown, inputs: unknown, outputs: unknown, params: unknown, issues: ValidationIssue[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path: "canvasAction", message: "canvasAction must be an object." });
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") issues.push({ path: "canvasAction.enabled", message: "enabled must be boolean." });
  if (record.title !== undefined && typeof record.title !== "string") issues.push({ path: "canvasAction.title", message: "title must be string." });
  if (record.description !== undefined && typeof record.description !== "string") issues.push({ path: "canvasAction.description", message: "description must be string." });
  if (record.icon !== undefined) validateCanvasActionIcon(record.icon, issues);
  if (record.dialog !== undefined) validateCanvasActionDialog(record.dialog, params, outputs, issues);
  if (record.enabled !== true) return;

  const inputPorts = Array.isArray(inputs) ? inputs as Array<Record<string, unknown>> : [];
  const outputPorts = Array.isArray(outputs) ? outputs as Array<Record<string, unknown>> : [];
  if (inputPorts.length !== 1) issues.push({ path: "canvasAction", message: "Canvas actions must declare exactly one input port." });
  const inputType = inputPorts[0]?.type;
  if (typeof inputType !== "string" || !isCanvasActionPortType(inputType)) {
    issues.push({ path: "inputs.0.type", message: 'Canvas action input type must be "image", "video", "audio", or "text".' });
  }
  if (outputPorts.length === 0) issues.push({ path: "outputs", message: "Canvas actions must declare at least one output port." });
  outputPorts.forEach((port, index) => {
    if (typeof port.type !== "string" || !isCanvasActionPortType(port.type)) {
      issues.push({ path: `outputs.${index}.type`, message: 'Canvas action output type must be "image", "video", "audio", or "text".' });
    }
  });
}

function validateCanvasActionDialog(value: unknown, params: unknown, outputs: unknown, issues: ValidationIssue[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path: "canvasAction.dialog", message: "dialog must be an object." });
    return;
  }
  const dialog = value as Record<string, unknown>;
  if (typeof dialog.enabled !== "boolean") issues.push({ path: "canvasAction.dialog.enabled", message: "enabled must be boolean." });
  const paramIds = new Set((Array.isArray(params) ? params : []).map((param: Record<string, unknown>) => param.id).filter((id): id is string => typeof id === "string"));
  if (!Array.isArray(dialog.params) || !dialog.params.every((id) => typeof id === "string")) {
    issues.push({ path: "canvasAction.dialog.params", message: "params must be an array of parameter ids." });
  } else {
    dialog.params.forEach((id, index) => {
      if (!paramIds.has(id)) issues.push({ path: `canvasAction.dialog.params.${index}`, message: `Unknown parameter "${id}".` });
    });
  }
  const outputIds = new Set((Array.isArray(outputs) ? outputs : []).map((output: Record<string, unknown>) => output.id).filter((id): id is string => typeof id === "string"));
  if (dialog.preview !== undefined && !Array.isArray(dialog.preview)) {
    issues.push({ path: "canvasAction.dialog.preview", message: "preview must be an array." });
  } else if (Array.isArray(dialog.preview)) {
    dialog.preview.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        issues.push({ path: `canvasAction.dialog.preview.${index}`, message: "Preview must be an object." });
        return;
      }
      const preview = entry as Record<string, unknown>;
      if (!["image", "video", "audio", "panorama360", "splat"].includes(String(preview.kind))) issues.push({ path: `canvasAction.dialog.preview.${index}.kind`, message: "Unsupported preview kind." });
      if (preview.source === "input") return;
      if (!preview.source || typeof preview.source !== "object" || Array.isArray(preview.source) || typeof (preview.source as Record<string, unknown>).output !== "string") {
        issues.push({ path: `canvasAction.dialog.preview.${index}.source`, message: 'source must be "input" or an output reference.' });
        return;
      }
      const output = (preview.source as { output: string }).output;
      if (!outputIds.has(output)) issues.push({ path: `canvasAction.dialog.preview.${index}.source.output`, message: `Unknown output "${output}".` });
    });
  }
}

function validateCanvasActionIcon(value: unknown, issues: ValidationIssue[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path: "canvasAction.icon", message: "icon must be an object." });
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "preset" && record.kind !== "custom") {
    issues.push({ path: "canvasAction.icon.kind", message: 'icon.kind must be "preset" or "custom".' });
    return;
  }
  if (record.kind === "preset" && (typeof record.name !== "string" || !record.name.trim())) {
    issues.push({ path: "canvasAction.icon.name", message: "preset icon name is required." });
  }
  if (record.kind === "custom" && typeof record.svg !== "string" && typeof record.dataUrl !== "string") {
    issues.push({ path: "canvasAction.icon", message: "custom icon requires svg or dataUrl." });
  }
}

function isCanvasActionPortType(value: string): boolean {
  return value === "image" || value === "video" || value === "audio" || value === "text";
}

function isAvailableCapabilityNode(node: RouteNode, capabilities: Set<string>): boolean {
  if (node.type.startsWith("capability.") && capabilities.has(node.type.slice("capability.".length))) return true;
  const capability = (node as RouteNode & { capability?: { id?: unknown } }).capability?.id;
  return typeof capability === "string" && capabilities.has(capability);
}

function normalizeNodeManifest(record: Record<string, unknown>): SnarkNodeManifest {
  return {
    ...(record as unknown as SnarkNodeManifest),
    permissions: {
      ...EMPTY_PERMISSIONS,
      ...(record.permissions as NodePermissions),
      networkHosts: Array.isArray((record.permissions as NodePermissions).networkHosts) ? (record.permissions as NodePermissions).networkHosts : [],
      env: Array.isArray((record.permissions as NodePermissions).env) ? (record.permissions as NodePermissions).env : []
    },
    inputs: (record.inputs as NodePortManifest[]) ?? [],
    outputs: (record.outputs as NodePortManifest[]) ?? []
  };
}

function requiredString(value: unknown, path: string, issues: ValidationIssue[]): string {
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ path, message: `${basename(path)} is required.` });
    return "";
  }
  return value.trim();
}

function stringEquals(value: unknown, expected: string, path: string, issues: ValidationIssue[]): void {
  if (value !== expected) issues.push({ path, message: `${path} must be "${expected}".` });
}

function safePackageRelativePath(path: string): string {
  const normalized = normalize(path.replace(/\\/g, "/")).replace(/^([/\\])+/, "").replace(/\\/g, "/");
  if (!normalized || normalized === "." || normalized.includes("../") || normalized === ".." || /^(?:[A-Za-z]:|\\\\)/.test(path)) {
    throw new Error("Package paths must be relative and cannot escape the package directory.");
  }
  return normalized;
}

function sanitizePackageDirectory(id: string): string {
  return id.replace(/[^a-z0-9._-]/gi, "_");
}

async function copyPackageFiles(source: string, target: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyPackageFiles(from, to);
    } else if (entry.isFile() && entry.name !== "manifest.json") {
      await copyFile(from, to);
    }
  }
}

function pickAllowedEnv(keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key] ?? ""]));
}

function createPluginAssetHelpers(outputDirectory: string, nodeId: string, manifest: SnarkNodeManifest) {
  async function ensureWritable() {
    if (!manifest.permissions.writeOutputs) throw new Error(`Node "${manifest.id}" did not request writeOutputs permission.`);
    const assetsDirectory = join(outputDirectory, "assets");
    await mkdir(assetsDirectory, { recursive: true });
    return assetsDirectory;
  }
  async function writeText(filename: string, text: string) {
      const assetsDirectory = await ensureWritable();
      const safeName = sanitizeFilename(filename);
      const localPath = join(assetsDirectory, `${sanitizeFilename(nodeId)}-${safeName}`);
      await writeFile(localPath, text, "utf8");
      return { localPath, path: localPath, filename: basename(localPath), mimeType: "text/plain", sizeBytes: Buffer.byteLength(text) };
  }
  return {
    writeText,
    async writeJson(filename: string, value: unknown) {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      const asset = await writeText(filename, text);
      return { ...asset, mimeType: "application/json" };
    },
    async writeBase64(filename: string, dataBase64: string, mimeType = "application/octet-stream") {
      const assetsDirectory = await ensureWritable();
      const safeName = sanitizeFilename(filename);
      const localPath = join(assetsDirectory, `${sanitizeFilename(nodeId)}-${safeName}`);
      const bytes = Buffer.from(dataBase64, "base64");
      await writeFile(localPath, bytes);
      return { localPath, path: localPath, filename: basename(localPath), mimeType, sizeBytes: bytes.length };
    }
  };
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function sanitizeFilename(filename: string): string {
  return basename(filename).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

async function readArchiveFiles(data: Buffer): Promise<Array<{ path: string; data: Buffer }>> {
  if (data.byteLength > MAX_PACKAGE_BYTES) throw new Error(`Archive is too large. Limit is ${MAX_PACKAGE_BYTES} bytes.`);
  const zip = await JSZip.loadAsync(data);
  const files: Array<{ path: string; data: Buffer }> = [];
  let totalSize = 0;
  for (const [rawPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const unsafeOriginalName = (entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName;
    if (unsafeOriginalName && unsafeOriginalName !== rawPath && isSuspiciousPackagePath(unsafeOriginalName)) {
      throw new Error(`Archive contains unsupported file path: ${unsafeOriginalName}`);
    }
    const path = safePackageRelativePath(rawPath.replace(/\\/g, "/"));
    if (isSuspiciousPackagePath(path)) throw new Error(`Archive contains unsupported file path: ${path}`);
    const fileData = await entry.async("nodebuffer");
    totalSize += fileData.byteLength;
    if (totalSize > MAX_PACKAGE_BYTES) throw new Error(`Archive contents are too large. Limit is ${MAX_PACKAGE_BYTES} bytes.`);
    files.push({ path, data: fileData });
  }
  if (files.length === 0) throw new Error("Archive does not contain files.");
  if (files.length > MAX_PACKAGE_FILE_COUNT) throw new Error(`Archive has too many files. Limit is ${MAX_PACKAGE_FILE_COUNT}.`);
  const duplicate = firstDuplicate(files.map((file) => file.path));
  if (duplicate) throw new Error(`Archive contains duplicate path: ${duplicate}`);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function validatePackageFileSet(manifest: SnarkNodeManifest, paths: string[]): void {
  if (!paths.includes("manifest.json")) throw new Error("Package must include manifest.json.");
  for (const path of paths) {
    safePackageRelativePath(path);
    if (isSuspiciousPackagePath(path)) throw new Error(`Package contains unsupported file path: ${path}`);
  }
  if (manifest.executor.type === "plugin" && manifest.executor.entry && !paths.includes(safePackageRelativePath(manifest.executor.entry))) {
    throw new Error(`Plugin package is missing executor file: ${manifest.executor.entry}`);
  }
}

async function collectPackageFiles(source: string): Promise<Array<{ absolutePath: string; relativePath: string; sizeBytes: number }>> {
  const files: Array<{ absolutePath: string; relativePath: string; sizeBytes: number }> = [];
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_PACK_DIRECTORIES.has(entry.name)) continue;
      if (entry.isFile() && SKIPPED_PACK_FILENAMES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = safePackageRelativePath(relative(source, absolutePath).replace(/\\/g, "/"));
      if (isSuspiciousPackagePath(relativePath)) continue;
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) {
        const fileStat = await stat(absolutePath);
        files.push({ absolutePath, relativePath, sizeBytes: fileStat.size });
      }
    }
  }
  await visit(source);
  if (files.length > MAX_PACKAGE_FILE_COUNT) throw new Error(`Package has too many files. Limit is ${MAX_PACKAGE_FILE_COUNT}.`);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function isSuspiciousPackagePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("\0") || normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../") || normalized.startsWith(".env") || normalized.includes("/.env") || normalized.includes("node_modules/") || normalized.includes("/node_modules/");
}

function isSnarkNodeArchiveFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".snarknode");
}

function firstDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function packageWarnings(manifest: SnarkNodeManifest): string[] {
  const warnings: string[] = [];
  if (manifest.executor.type === "plugin") warnings.push("Contains executable plugin code. Review permissions before installing.");
  if (manifest.permissions.shell) warnings.push("Requests shell permission. This build refuses shell execution.");
  if (manifest.permissions.readFiles) warnings.push("Requests local file read permission.");
  if (manifest.permissions.network) warnings.push(`Requests network access${manifest.permissions.networkHosts?.length ? ` to ${manifest.permissions.networkHosts.join(", ")}` : ""}.`);
  return warnings;
}

function requiredExecutorString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function interpolateTemplate(value: unknown, scope: { params: Record<string, unknown>; inputs: Record<string, unknown> }): string {
  return String(value ?? "").replace(/\{\{\s*(params|inputs)\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, root: "params" | "inputs", path: string) => {
    const resolved = readObjectPath(scope[root], path);
    return resolved === undefined || resolved === null ? "" : String(resolved);
  });
}

function mapTemplateObject(value: unknown, scope: { params: Record<string, unknown>; inputs: Record<string, unknown> }): Record<string, string> {
  if (value === undefined || value === null || value === "") return {};
  const source = typeof value === "string" ? JSON.parse(interpolateTemplate(value, scope)) : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Declarative HTTP template object must be an object.");
  return Object.fromEntries(Object.entries(source as Record<string, unknown>).map(([key, entry]) => [key, interpolateTemplate(entry, scope)]));
}

function addQueryParams(url: string, query: Record<string, string>): string {
  const result = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== "") result.searchParams.set(key, value);
  }
  return result.toString();
}

function buildDeclarativeHttpBody(bodyMode: string, template: unknown, scope: { params: Record<string, unknown>; inputs: Record<string, unknown> }): BodyInit | undefined {
  if (bodyMode === "none") return undefined;
  if (bodyMode === "text") return interpolateTemplate(template ?? "", scope);
  if (bodyMode === "json") {
    const rendered = renderTemplateValue(template ?? {}, scope);
    return JSON.stringify(rendered);
  }
  throw new Error(`Unsupported declarative HTTP bodyMode: ${bodyMode}`);
}

function renderTemplateValue(value: unknown, scope: { params: Record<string, unknown>; inputs: Record<string, unknown> }): unknown {
  if (typeof value === "string") return interpolateTemplate(value, scope);
  if (Array.isArray(value)) return value.map((item) => renderTemplateValue(item, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderTemplateValue(entry, scope)]));
  return value;
}

function mapDeclarativeResponse(mappings: Record<string, string> | undefined, mode: string, json: unknown, text: string): Record<string, unknown> {
  if (!mappings || Object.keys(mappings).length === 0) return mode === "text" ? { text } : { responseJson: json, responseText: text };
  const outputs: Record<string, unknown> = {};
  for (const [outputId, path] of Object.entries(mappings)) {
    if (path === "$text") outputs[outputId] = text;
    else if (path === "$json" || path === "$") outputs[outputId] = json;
    else outputs[outputId] = readObjectPath(json, path.replace(/^\$\./, ""));
  }
  return outputs;
}

function readOutputPort(output: unknown, port?: string): unknown {
  if (!port || port === "output") return output;
  if (output && typeof output === "object" && port in output) return (output as Record<string, unknown>)[port];
  if (port === "image" || port === "file" || port === "video") return output;
  return readObjectPath(output, port);
}

function readObjectPath(source: unknown, path: string): unknown {
  if (!path) return source;
  return path.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) return (current as Record<string, unknown>)[part];
    return undefined;
  }, source);
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

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function redactUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/token|secret|password|api[_-]?key/i.test(key)) url.searchParams.set(key, "[redacted]");
  }
  return url.toString();
}

function permissionSummaryForLog(permissions: NodePermissions): string {
  return JSON.stringify({
    network: permissions.network,
    networkHosts: permissions.networkHosts ?? [],
    readFiles: permissions.readFiles,
    writeOutputs: permissions.writeOutputs,
    shell: permissions.shell,
    env: permissions.env
  });
}
