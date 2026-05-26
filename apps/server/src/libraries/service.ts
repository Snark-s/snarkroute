import { createReadStream } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { loadPromptLibrary, parsePromptPngFile, writePngTextChunk, type PromptLibraryPrompt } from "@snarkroute/nodes";
import { librariesDirectory } from "../server-paths";
import { sanitizeFilename } from "../assets/service";
import { createRouteExecutor } from "../execution/service";
import { fetchWithTimeout } from "../services/http";
import { embedImageProvenance, imageProvenanceFormat, imageProvenanceVersion } from "./image-metadata";

export type LibraryKind = "workspace" | "collection";
export type LibraryContentKind = "mixed" | "image" | "character" | "prompt" | "style";
export type LibraryDefaultView = "canvas" | "grid" | "list";
export type LibraryViewMode = "media-folder" | "image-stack" | "text-library" | "prompt-library" | "board" | "workflow";

export interface LocalLibraryManifest {
  schema: "snarkroute-library.v0" | string;
  kind: "library/local-folder" | string;
  id: string;
  title: string;
  description?: string;
  defaultView?: LibraryViewMode;
  availableViews?: LibraryViewMode[];
  paths?: Record<string, string>;
  entryBoard?: string;
  entryWorkflow?: string;
}

export interface LocalLibraryAsset {
  id: string;
  relativePath: string;
  title: string;
  kind: "image" | "video" | "audio" | "text" | "prompt" | "file";
  mimeType: string;
  embeddedPrompt?: PromptLibraryPrompt;
}

export interface LocalLibraryScanResult {
  sourceType: "local-folder";
  sourcePath: string;
  manifest: LocalLibraryManifest | null;
  id: string;
  title: string;
  description?: string;
  defaultView: LibraryViewMode;
  availableViews: LibraryViewMode[];
  assets: LocalLibraryAsset[];
  prompts: PromptLibraryPrompt[];
  coverAssetId?: string;
  entryBoard?: string;
  entryWorkflow?: string;
  error?: string;
}

export interface SnarkLibraryManifest {
  format: "snarkroute.library";
  version: "0.1";
  id: string;
  title: string;
  libraryKind: LibraryKind;
  contentKind: LibraryContentKind;
  defaultView: LibraryDefaultView;
  canvas?: string;
  representativeImage?: LibraryRepresentativeImage;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryRepresentativeImage {
  nodeId: string;
  stackItemId: string;
}

export interface SnarkCanvasDocument {
  format: "snarkroute.canvas";
  version: "0.1";
  nodes: SnarkCanvasNode[];
  edges?: SnarkCanvasEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface SnarkCanvasNode {
  id: string;
  type: "image" | string;
  nodePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnarkCanvasEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface ImageNodeManifest {
  format: "snarkroute.node";
  version: "0.1";
  id: string;
  type: "image";
  title: string;
  currentPrompt?: string;
  modelId?: string;
  executionProvider?: string;
  fallbackAllowed?: boolean;
  stack: ImageStackItem[];
  activeStackIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface VideoNodeManifest {
  format: "snarkroute.node";
  version: "0.1";
  id: string;
  type: "video";
  title: string;
  currentPrompt?: string;
  modelId?: string;
  executionProvider?: string;
  fallbackAllowed?: boolean;
  stack: ImageStackItem[];
  activeStackIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface TextNodeManifest {
  format: "snarkroute.node";
  version: "0.1";
  id: string;
  type: "text";
  title: string;
  text: string;
  color?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImageStackItem {
  id: string;
  file?: string;
  externalUrl?: string;
  source: "import" | string;
  mimeType: string;
  width: number;
  height: number;
  createdAt: string;
}

export interface LibrarySnapshot {
  manifest: SnarkLibraryManifest;
  path: string;
  nestedLibraries: NestedLibrary[];
  canvas: SnarkCanvasDocument | null;
  nodes: NodeView[];
}

export interface NestedLibrary {
  id: string;
  title: string;
  path: string;
  libraryKind: LibraryKind;
  contentKind: LibraryContentKind;
  defaultView: LibraryDefaultView;
  hasCanvas: boolean;
}

export interface ImageNodeView {
  canvas: SnarkCanvasNode;
  manifest: ImageNodeManifest;
  activeStackItem: ImageStackItem | null;
  previewUrl: string | null;
}

export interface LibraryNodeManifest {
  format: "snarkroute.node";
  version: "0.1";
  id: string;
  type: "library";
  title: string;
  sourceType: "local-folder";
  sourcePath: string;
  viewMode: LibraryViewMode;
  createdAt: string;
  updatedAt: string;
}

export interface VideoNodeView {
  canvas: SnarkCanvasNode;
  manifest: VideoNodeManifest;
  activeStackItem: ImageStackItem | null;
  previewUrl: string | null;
}

export interface TextNodeView {
  canvas: SnarkCanvasNode;
  manifest: TextNodeManifest;
  activeStackItem: null;
  previewUrl: null;
}

export interface LibraryNodeView {
  canvas: SnarkCanvasNode;
  manifest: LibraryNodeManifest;
  scan: LocalLibraryScanResult;
  activeStackItem: null;
  previewUrl: string | null;
}

export type NodeView = ImageNodeView | VideoNodeView | TextNodeView | LibraryNodeView;

export interface ImportImageInput {
  filename: string;
  dataBase64?: string;
  sourcePath?: string;
  dropX: number;
  dropY: number;
  width?: number;
  height?: number;
}

export interface ImportVideoInput extends ImportImageInput {}

export interface CreateNodeInput {
  type: "image" | "video" | "text";
  x: number;
  y: number;
  width?: number;
  height?: number;
  connectFromNodeId?: string;
}

export interface AppendImageStackInput {
  nodeId: string;
  filename: string;
  dataBase64?: string;
  sourcePath?: string;
}

export interface AppendVideoStackInput extends AppendImageStackInput {}

export interface GenerateImageNodeInput {
  nodeId: string;
  modelId: string;
  prompt?: string;
  providerId?: string;
  executionProvider?: string;
  fallbackAllowed?: boolean;
  availableExecutionProviders?: string[];
  inputNodeIds?: string[];
  maxImageInputs?: number;
  imageReferenceSyntax?: string;
  parameters?: ImageGenerationSettings;
}

export interface GenerateVideoNodeInput extends GenerateImageNodeInput {}

export type ImageGenerationSettings = Record<string, string | number | boolean>;

export interface UpdateMediaNodeRouteSettingsInput {
  modelId: string;
  executionProvider?: string;
  fallbackAllowed?: boolean;
}

export interface DuplicateStackItemInput {
  nodeId: string;
  stackItemId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface DuplicateCanvasNodeInput {
  nodeId: string;
  x: number;
  y: number;
}

export interface ImportLocalLibraryInput {
  sourcePath: string;
  viewMode?: LibraryViewMode;
  dropX: number;
  dropY: number;
  width?: number;
  height?: number;
}

const manifestFilename = "snark.library.json";
const canvasFilename = "canvas.json";
const currentPromptFilename = "current-prompt.txt";
const defaultNodeWidth = 320;
const defaultNodeHeight = 240;
let currentLibraryPath = process.env.SNARKROUTE_LIBRARY_PATH ? resolve(process.env.SNARKROUTE_LIBRARY_PATH) : join(librariesDirectory, "default");

export async function getCurrentLibrarySnapshot(): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  return readLibrarySnapshot(libraryPath);
}

export async function openLibrary(path: string): Promise<LibrarySnapshot> {
  const libraryPath = resolve(path);
  await readLibraryManifest(libraryPath);
  currentLibraryPath = libraryPath;
  return readLibrarySnapshot(libraryPath);
}

export async function createLibrary(options: { path?: string; title?: string; libraryKind?: LibraryKind; contentKind?: LibraryContentKind; defaultView?: LibraryDefaultView } = {}): Promise<LibrarySnapshot> {
  const libraryPath = resolve(options.path ?? join(librariesDirectory, slugify(options.title ?? "library")));
  await mkdir(libraryPath, { recursive: true });
  await ensureLibraryManifest(libraryPath, {
    title: options.title ?? (basename(libraryPath) || "SnarkRoute Library"),
    libraryKind: options.libraryKind ?? "workspace",
    contentKind: options.contentKind ?? "mixed",
    defaultView: options.defaultView ?? "canvas"
  });
  currentLibraryPath = libraryPath;
  return readLibrarySnapshot(libraryPath);
}

export async function readLibrarySnapshot(libraryPath: string): Promise<LibrarySnapshot> {
  const manifest = await readLibraryManifest(libraryPath);
  const nestedLibraries = await listNestedLibraries(libraryPath);
  const canvas = await readCanvas(libraryPath, manifest);
  const nodes = canvas ? await readCanvasNodes(libraryPath, canvas) : [];
  return { manifest, path: libraryPath, nestedLibraries, canvas, nodes };
}

export async function listNestedLibraries(libraryPath: string): Promise<NestedLibrary[]> {
  const entries = await readdir(libraryPath, { withFileTypes: true }).catch(() => []);
  const nested: NestedLibrary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = join(libraryPath, entry.name);
    try {
      const manifest = await readLibraryManifest(childPath);
      nested.push({
        id: manifest.id,
        title: manifest.title,
        path: childPath,
        libraryKind: manifest.libraryKind,
        contentKind: manifest.contentKind,
        defaultView: manifest.defaultView,
        hasCanvas: Boolean(manifest.canvas && await fileExists(join(childPath, manifest.canvas)))
      });
    } catch {
      continue;
    }
  }
  return nested.sort((a, b) => a.title.localeCompare(b.title));
}

export async function readCanvas(libraryPath: string, manifest?: SnarkLibraryManifest): Promise<SnarkCanvasDocument | null> {
  const libraryManifest = manifest ?? await readLibraryManifest(libraryPath);
  if (!libraryManifest.canvas) return null;
  const canvasPath = resolvePortablePath(libraryPath, libraryManifest.canvas);
  if (!await fileExists(canvasPath)) return null;
  const parsed = JSON.parse(await readFile(canvasPath, "utf8")) as SnarkCanvasDocument;
  return { ...parsed, nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [] };
}

export async function writeCanvas(libraryPath: string, canvas: SnarkCanvasDocument): Promise<SnarkCanvasDocument> {
  const manifest = await readLibraryManifest(libraryPath);
  const canvasPath = resolvePortablePath(libraryPath, manifest.canvas ?? canvasFilename);
  const now = new Date().toISOString();
  const document = { ...canvas, format: "snarkroute.canvas" as const, version: "0.1" as const, updatedAt: now, createdAt: canvas.createdAt ?? now };
  await restoreTrashedCanvasNodes(libraryPath, document.nodes);
  await writeJson(canvasPath, document);
  if (!manifest.canvas) await writeLibraryManifest(libraryPath, { ...manifest, canvas: canvasFilename, updatedAt: now });
  return document;
}

async function restoreTrashedCanvasNodes(libraryPath: string, nodes: SnarkCanvasNode[]): Promise<void> {
  const trashDirectory = join(libraryPath, ".trash", "nodes");
  const trashEntries = await readdir(trashDirectory, { withFileTypes: true }).catch(() => []);
  if (trashEntries.length === 0) return;
  for (const node of nodes) {
    const nodePath = resolvePortablePath(libraryPath, node.nodePath);
    if (await fileExists(nodePath)) continue;
    const prefix = `${basename(nodePath)}-`;
    const trashedNode = trashEntries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .sort((left, right) => right.name.localeCompare(left.name))[0];
    if (!trashedNode) continue;
    await mkdir(dirname(nodePath), { recursive: true });
    await rename(join(trashDirectory, trashedNode.name), nodePath);
  }
}

export async function importImageAsNode(input: ImportImageInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const extension = normalizedImageExtension(input.filename);
  const mimeType = mimeTypeFromExtension(extension);
  const title = titleFromFilename(input.filename);
  const id = `image_${shortId()}`;
  const folderName = `${slugify(title)}-${id}.imgnode`;
  const nodeRelativePath = portableJoin("image-nodes", folderName);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const stackPath = join(nodePath, "stack");
  const imageRelativePath = portableJoin("stack", `000-import${extension}`);
  const imagePath = resolvePortablePath(nodePath, imageRelativePath);
  await mkdir(stackPath, { recursive: true });

  if (input.dataBase64) {
    await writeFile(imagePath, Buffer.from(input.dataBase64, "base64"));
  } else if (input.sourcePath) {
    await copyFile(input.sourcePath, imagePath);
  } else {
    throw new Error("dataBase64 or sourcePath is required.");
  }

  const imageBuffer = await readFile(imagePath);
  const dimensions = readImageDimensions(imageBuffer, extension);
  const now = new Date().toISOString();
  const manifest: ImageNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "image",
    title,
    stack: [{
      id: `stack_${shortId()}`,
      file: imageRelativePath,
      source: "import",
      mimeType,
      width: dimensions.width,
      height: dimensions.height,
      createdAt: now
    }],
    activeStackIndex: 0,
    createdAt: now,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), manifest);
  await writeCurrentPrompt(nodePath, "");
  await setLibraryRepresentativeImage(libraryPath, id, manifest.stack[0].id);

  const canvas = await ensureCanvas(libraryPath);
  const width = input.width ?? defaultNodeWidth;
  const height = input.height ?? defaultNodeHeight;
  canvas.nodes.push({
    id,
    type: "image",
    nodePath: nodeRelativePath,
    x: Math.round(input.dropX - width / 2),
    y: Math.round(input.dropY - height / 2),
    width,
    height
  });
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function importVideoAsNode(input: ImportVideoInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const extension = normalizedVideoExtension(input.filename);
  const title = titleFromFilename(input.filename);
  const id = `video_${shortId()}`;
  const folderName = `${slugify(title)}-${id}.vidnode`;
  const nodeRelativePath = portableJoin("video-nodes", folderName);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const videoRelativePath = portableJoin("stack", `000-import${extension}`);
  const videoPath = resolvePortablePath(nodePath, videoRelativePath);
  await mkdir(join(nodePath, "stack"), { recursive: true });

  if (input.dataBase64) {
    await writeFile(videoPath, Buffer.from(input.dataBase64, "base64"));
  } else if (input.sourcePath) {
    await copyFile(input.sourcePath, videoPath);
  } else {
    throw new Error("dataBase64 or sourcePath is required.");
  }

  const now = new Date().toISOString();
  const manifest: VideoNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "video",
    title,
    stack: [{
      id: `stack_${shortId()}`,
      file: videoRelativePath,
      source: "import",
      mimeType: videoMimeTypeFromExtension(extension),
      width: input.width ?? defaultNodeWidth,
      height: input.height ?? defaultNodeHeight,
      createdAt: now
    }],
    activeStackIndex: 0,
    createdAt: now,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), manifest);
  await writeCurrentPrompt(nodePath, "");

  const canvas = await ensureCanvas(libraryPath);
  const width = input.width ?? defaultNodeWidth;
  const height = input.height ?? defaultNodeHeight;
  canvas.nodes.push({
    id,
    type: "video",
    nodePath: nodeRelativePath,
    x: Math.round(input.dropX - width / 2),
    y: Math.round(input.dropY - height / 2),
    width,
    height
  });
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function importLocalLibraryAsNode(input: ImportLocalLibraryInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const scan = await scanLocalLibrary(input.sourcePath);
  const now = new Date().toISOString();
  const id = `library_${shortId()}`;
  const nodeRelativePath = portableJoin("library-nodes", `${slugify(scan.title)}-${id}.libnode`);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const viewMode = input.viewMode && scan.availableViews.includes(input.viewMode) ? input.viewMode : scan.defaultView;
  const manifest: LibraryNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "library",
    title: scan.title,
    sourceType: "local-folder",
    sourcePath: scan.sourcePath,
    viewMode,
    createdAt: now,
    updatedAt: now
  };
  await mkdir(nodePath, { recursive: true });
  await writeJson(join(nodePath, "snark.node.json"), manifest);

  const canvas = await ensureCanvas(libraryPath);
  const width = input.width ?? 360;
  const height = input.height ?? 290;
  canvas.nodes.push({
    id,
    type: "library",
    nodePath: nodeRelativePath,
    x: Math.round(input.dropX - width / 2),
    y: Math.round(input.dropY - height / 2),
    width,
    height
  });
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function scanLocalLibrary(sourcePath: string): Promise<LocalLibraryScanResult> {
  const root = resolve(sourcePath);
  const sourceStat = await stat(root);
  if (!sourceStat.isDirectory()) throw new Error("Local library source must be a folder.");
  const manifest = await readLocalLibraryManifest(root);
  const paths = await listLocalLibraryFiles(root);
  const promptLibrary = await loadPromptLibrary(root);
  const promptByPath = new Map(promptLibrary.categories.flatMap((category) => category.prompts).map((prompt) => [resolve(prompt.path), prompt]));
  const assets: LocalLibraryAsset[] = [];
  for (const path of paths) {
    if (basename(path) === "snark-library.json") continue;
    const relativePath = relative(root, path).split(sep).join("/");
    const extension = extname(path).toLowerCase();
    let embeddedPrompt = promptByPath.get(resolve(path));
    if (!embeddedPrompt && extension === ".png") {
      const parsed = parsePromptPngFile(await readFile(path), path);
      if ("prompt" in parsed) embeddedPrompt = parsed.prompt;
    }
    const kind = localLibraryAssetKind(path, embeddedPrompt);
    assets.push({
      id: `asset_${Buffer.from(relativePath, "utf8").toString("base64url")}`,
      relativePath,
      title: titleFromFilename(basename(path)),
      kind,
      mimeType: localLibraryMimeType(extension),
      embeddedPrompt
    });
  }
  const detectedViews = detectLibraryViews(assets, paths, manifest);
  const availableViews = orderedLibraryViews(manifest?.availableViews?.length ? [...new Set([...manifest.availableViews, ...detectedViews])] : detectedViews);
  const defaultView = manifest?.defaultView && availableViews.includes(manifest.defaultView)
    ? manifest.defaultView
    : availableViews.includes("image-stack") ? "image-stack" : availableViews[0] ?? "media-folder";
  const prompts = promptLibrary.categories.flatMap((category) => category.prompts);
  return {
    sourceType: "local-folder",
    sourcePath: root,
    manifest,
    id: manifest?.id ?? slugify(basename(root) || "local-library"),
    title: manifest?.title ?? (basename(root) || "Local Library"),
    description: manifest?.description,
    defaultView,
    availableViews,
    assets,
    prompts,
    coverAssetId: assets.find((asset) => asset.kind === "image")?.id,
    entryBoard: manifest?.entryBoard,
    entryWorkflow: manifest?.entryWorkflow
  };
}

export async function updateLibraryNodeViewMode(nodeId: string, viewMode: LibraryViewMode): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readLibraryNode(nodeId);
  const scan = await scanLocalLibrary(manifest.sourcePath);
  if (!scan.availableViews.includes(viewMode)) throw new Error(`View mode "${viewMode}" is not available for this library.`);
  await writeJson(join(nodePath, "snark.node.json"), { ...manifest, viewMode, updatedAt: new Date().toISOString() });
  return readLibrarySnapshot(libraryPath);
}

export async function createLocalLibraryAssetReadStream(nodeId: string, assetId: string): Promise<{ stream: ReturnType<typeof createReadStream>; mimeType: string }> {
  const { manifest } = await readLibraryNode(nodeId);
  const scan = await scanLocalLibrary(manifest.sourcePath);
  const asset = scan.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`Library asset "${assetId}" was not found.`);
  const assetPath = resolvePortablePath(scan.sourcePath, asset.relativePath);
  return { stream: createReadStream(assetPath), mimeType: asset.mimeType };
}

export async function appendImageToNodeStack(input: AppendImageStackInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readImageNode(input.nodeId);
  const extension = normalizedImageExtension(input.filename);
  const mimeType = mimeTypeFromExtension(extension);
  const stackPath = join(nodePath, "stack");
  const stackIndex = manifest.stack.length;
  const imageRelativePath = nextStackFilename(manifest.stack, "import", extension);
  const imagePath = resolvePortablePath(nodePath, imageRelativePath);
  await mkdir(stackPath, { recursive: true });

  if (input.dataBase64) {
    await writeFile(imagePath, Buffer.from(input.dataBase64, "base64"));
  } else if (input.sourcePath) {
    await copyFile(input.sourcePath, imagePath);
  } else {
    throw new Error("dataBase64 or sourcePath is required.");
  }

  const imageBuffer = await readFile(imagePath);
  const dimensions = readImageDimensions(imageBuffer, extension);
  const now = new Date().toISOString();
  const updatedManifest: ImageNodeManifest = {
    ...manifest,
    stack: [...manifest.stack, {
      id: `stack_${shortId()}`,
      file: imageRelativePath,
      source: "import",
      mimeType,
      width: dimensions.width,
      height: dimensions.height,
      createdAt: now
    }],
    activeStackIndex: stackIndex,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), updatedManifest);
  await setLibraryRepresentativeImage(libraryPath, input.nodeId, updatedManifest.stack[stackIndex].id);
  return readLibrarySnapshot(libraryPath);
}

export async function appendVideoToNodeStack(input: AppendVideoStackInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readVideoNode(input.nodeId);
  const extension = normalizedVideoExtension(input.filename);
  const stackIndex = manifest.stack.length;
  const videoRelativePath = nextStackFilename(manifest.stack, "import", extension);
  const videoPath = resolvePortablePath(nodePath, videoRelativePath);
  await mkdir(join(nodePath, "stack"), { recursive: true });

  if (input.dataBase64) {
    await writeFile(videoPath, Buffer.from(input.dataBase64, "base64"));
  } else if (input.sourcePath) {
    await copyFile(input.sourcePath, videoPath);
  } else {
    throw new Error("dataBase64 or sourcePath is required.");
  }

  const now = new Date().toISOString();
  const updatedManifest: VideoNodeManifest = {
    ...manifest,
    stack: [...manifest.stack, {
      id: `stack_${shortId()}`,
      file: videoRelativePath,
      source: "import",
      mimeType: videoMimeTypeFromExtension(extension),
      width: defaultNodeWidth,
      height: defaultNodeHeight,
      createdAt: now
    }],
    activeStackIndex: stackIndex,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), updatedManifest);
  return readLibrarySnapshot(libraryPath);
}

export async function setImageNodeActiveStackItem(nodeId: string, stackIndex: number): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readImageNode(nodeId);
  if (stackIndex < 0 || stackIndex >= manifest.stack.length) throw new Error("Stack index is out of range.");
  await writeJson(join(nodePath, "snark.node.json"), {
    ...manifest,
    activeStackIndex: stackIndex,
    updatedAt: new Date().toISOString()
  });
  await setLibraryRepresentativeImage(libraryPath, nodeId, manifest.stack[stackIndex].id);
  return readLibrarySnapshot(libraryPath);
}

export async function setVideoNodeActiveStackItem(nodeId: string, stackIndex: number): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readVideoNode(nodeId);
  if (stackIndex < 0 || stackIndex >= manifest.stack.length) throw new Error("Stack index is out of range.");
  await writeJson(join(nodePath, "snark.node.json"), {
    ...manifest,
    activeStackIndex: stackIndex,
    updatedAt: new Date().toISOString()
  });
  return readLibrarySnapshot(libraryPath);
}

export async function deleteImageNodeStackItem(nodeId: string, stackItemId: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readImageNode(nodeId);
  const index = manifest.stack.findIndex((item) => item.id === stackItemId);
  if (index < 0) throw new Error(`Stack item "${stackItemId}" was not found.`);
  const item = manifest.stack[index];
  const nextStack = manifest.stack.filter((entry) => entry.id !== stackItemId);
  const nextActiveIndex = nextStack.length ? Math.min(manifest.activeStackIndex >= index ? manifest.activeStackIndex - 1 : manifest.activeStackIndex, nextStack.length - 1) : 0;
  if (item.file) await rm(resolvePortablePath(nodePath, item.file), { force: true });
  await writeJson(join(nodePath, "snark.node.json"), {
    ...manifest,
    stack: nextStack,
    activeStackIndex: Math.max(0, nextActiveIndex),
    updatedAt: new Date().toISOString()
  });
  await replaceDeletedRepresentativeImage(libraryPath, nodeId, stackItemId, nextStack[Math.max(0, nextActiveIndex)]?.id);
  return readLibrarySnapshot(libraryPath);
}

export async function deleteVideoNodeStackItem(nodeId: string, stackItemId: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readVideoNode(nodeId);
  const index = manifest.stack.findIndex((item) => item.id === stackItemId);
  if (index < 0) throw new Error(`Stack item "${stackItemId}" was not found.`);
  const item = manifest.stack[index];
  const nextStack = manifest.stack.filter((entry) => entry.id !== stackItemId);
  const nextActiveIndex = nextStack.length ? Math.min(manifest.activeStackIndex >= index ? manifest.activeStackIndex - 1 : manifest.activeStackIndex, nextStack.length - 1) : 0;
  if (item.file) await rm(resolvePortablePath(nodePath, item.file), { force: true });
  await writeJson(join(nodePath, "snark.node.json"), {
    ...manifest,
    stack: nextStack,
    activeStackIndex: Math.max(0, nextActiveIndex),
    updatedAt: new Date().toISOString()
  });
  return readLibrarySnapshot(libraryPath);
}

export async function generateImageNodeStackItem(input: GenerateImageNodeInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readImageNode(input.nodeId);
  const activeItem = manifest.stack[manifest.activeStackIndex];
  const connectedInputs = await connectedCanvasInputs(libraryPath, input.nodeId);
  const orderedInputs = orderConnectedInputs(connectedInputs, input.inputNodeIds);
  const inputImages = orderedInputs.filter((entry) => entry.image).map((entry) => entry.image!);
  const maxImageInputs = positiveInteger(input.maxImageInputs);
  const generationInputs = limitImages(
    inputImages.filter((image, index, all) => all.findIndex((candidate) => candidate.path === image.path) === index),
    maxImageInputs
  );
  const promptTemplate = input.prompt?.trim() || "Create a polished image.";
  const prompt = resolveInputTokens(promptTemplate, orderedInputs, generationInputs, input.imageReferenceSyntax);
  const generationSettings = sanitizeImageGenerationSettings(input.parameters);
  await writeCurrentPrompt(nodePath, promptTemplate);
  const parameters = {
    ...imageGenerationParameters(input.modelId, executionProviderForInput(input), input.fallbackAllowed, prompt, generationInputs, generationSettings),
    promptTemplate
  };
  const runResult = await runImageModelForStackItem({
    nodeId: input.nodeId,
    modelId: input.modelId,
    executionProvider: executionProviderForInput(input),
    fallbackAllowed: input.fallbackAllowed,
    availableExecutionProviders: input.availableExecutionProviders,
    prompt,
    images: generationInputs,
    parameters: generationSettings
  });
  const generationResult = runResult.nodeResults.generate;
  if (runResult.status === "failed" || generationResult?.status === "failed") {
    throw new Error(generationResult?.error || "Image generation failed.");
  }
  const generatedImage = imageAssetFromGenerationOutput(generationResult?.output);
  const generatedPath = generatedImage.localPath ?? generatedImage.path;
  if (!generatedPath) throw new Error(`Model "${input.modelId}" did not return a saved image path.`);
  const extension = normalizedGeneratedExtension(generatedImage.filename ?? generatedPath);
  const stackIndex = manifest.stack.length;
  const imageRelativePath = nextStackFilename(manifest.stack, "generation", extension);
  const imagePath = resolvePortablePath(nodePath, imageRelativePath);
  await mkdir(dirname(imagePath), { recursive: true });
  const imageBuffer = await readGeneratedImageBuffer(generatedPath);
  const imageWithProvenance = embedImageProvenance(imageBuffer, extension, {
    format: imageProvenanceFormat,
    version: imageProvenanceVersion,
    prompt,
    parameters,
    providerId: executionProviderForInput(input),
    modelId: input.modelId,
    nodeId: input.nodeId,
    createdAt: new Date().toISOString()
  });
  const storedImage = extension === ".png"
    ? writePngTextChunk(imageWithProvenance, "snarkroute:prompt", JSON.stringify({
      schema: "snarkroute.prompt-image.v0",
      id: `${input.nodeId}-${stackIndex}`,
      title: manifest.title || "Generated Image",
      category: "generated",
      prompt,
      kind: "text/prompt",
      status: "candidate",
      source: { type: "generated-image", nodeId: input.nodeId, outputId: `stack-${stackIndex}` },
      modelHints: [input.modelId]
    }))
    : imageWithProvenance;
  await writeFile(imagePath, storedImage);

  const now = new Date().toISOString();
  const updatedManifest: ImageNodeManifest = {
    ...manifest,
    stack: [...manifest.stack, {
      id: `stack_${shortId()}`,
      file: imageRelativePath,
      source: "generation",
      mimeType: generatedImage.mimeType ?? mimeTypeFromExtension(extension),
      width: numberValue(generatedImage.width) ?? activeItem?.width ?? defaultNodeWidth,
      height: numberValue(generatedImage.height) ?? activeItem?.height ?? defaultNodeHeight,
      createdAt: now
    }],
    activeStackIndex: stackIndex,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), updatedManifest);
  await setLibraryRepresentativeImage(libraryPath, input.nodeId, updatedManifest.stack[stackIndex].id);
  return readLibrarySnapshot(libraryPath);
}

export async function generateVideoNodeStackItem(input: GenerateVideoNodeInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readVideoNode(input.nodeId);
  const activeItem = manifest.stack[manifest.activeStackIndex];
  const connectedInputs = await connectedCanvasInputs(libraryPath, input.nodeId);
  const orderedInputs = orderConnectedInputs(connectedInputs, input.inputNodeIds);
  const inputImages = orderedInputs.filter((entry) => entry.image).map((entry) => entry.image!);
  const generationInputs = limitImages(
    inputImages.filter((image, index, all) => all.findIndex((candidate) => candidate.path === image.path) === index),
    positiveInteger(input.maxImageInputs)
  );
  const promptTemplate = input.prompt?.trim() || "Create a cinematic video.";
  const prompt = resolveInputTokens(promptTemplate, orderedInputs, generationInputs, input.imageReferenceSyntax);
  const generationSettings = sanitizeImageGenerationSettings(input.parameters);
  await writeCurrentPrompt(nodePath, promptTemplate);
  const runResult = await runVideoModelForStackItem({
    nodeId: input.nodeId,
    modelId: input.modelId,
    executionProvider: executionProviderForInput(input),
    fallbackAllowed: input.fallbackAllowed,
    availableExecutionProviders: input.availableExecutionProviders,
    prompt,
    images: generationInputs,
    parameters: generationSettings
  });
  const generationResult = runResult.nodeResults.generate;
  if (runResult.status === "failed" || generationResult?.status === "failed") {
    throw new Error(generationResult?.error || "Video generation failed.");
  }
  const generatedVideo = videoAssetFromGenerationOutput(generationResult?.output);
  const generatedPath = generatedVideo.localPath ?? generatedVideo.path;
  if (!generatedPath) throw new Error(`Model "${input.modelId}" did not return a saved video path.`);
  const extension = normalizedGeneratedVideoExtension(generatedVideo.filename ?? generatedPath);
  const stackIndex = manifest.stack.length;
  const videoRelativePath = nextStackFilename(manifest.stack, "generation", extension);
  const videoPath = resolvePortablePath(nodePath, videoRelativePath);
  await mkdir(dirname(videoPath), { recursive: true });
  await writeFile(videoPath, await readGeneratedImageBuffer(generatedPath));

  const now = new Date().toISOString();
  const updatedManifest: VideoNodeManifest = {
    ...manifest,
    stack: [...manifest.stack, {
      id: `stack_${shortId()}`,
      file: videoRelativePath,
      source: "generation",
      mimeType: generatedVideo.mimeType ?? videoMimeTypeFromExtension(extension),
      width: numberValue(generatedVideo.width) ?? activeItem?.width ?? defaultNodeWidth,
      height: numberValue(generatedVideo.height) ?? activeItem?.height ?? defaultNodeHeight,
      createdAt: now
    }],
    activeStackIndex: stackIndex,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), updatedManifest);
  return readLibrarySnapshot(libraryPath);
}

async function runImageModelForStackItem(input: { nodeId: string; modelId: string; executionProvider: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; prompt: string; images: Array<{ path: string; localPath?: string; mimeType: string }>; parameters: ImageGenerationSettings }) {
  if (!["auto", "polza", "openrouter", "gemini"].includes(input.executionProvider)) {
    throw new Error(`Execution provider "${input.executionProvider}" is not available for image generation.`);
  }
  const autoOnlyPolza = input.executionProvider === "auto" && input.availableExecutionProviders?.length === 1 && input.availableExecutionProviders[0] === "polza";
  const nodeType = input.executionProvider === "polza" || autoOnlyPolza ? "polza.image.generate" : "ai.image.generate";
  const executor = await createRouteExecutor();
  const route = {
    routeVersion: "0.1",
    route: {
      id: `snarkroute-image-generation-${input.nodeId}`,
      title: "SnarkRoute Image Generation",
      author: { name: "SnarkRoute" }
    },
    nodes: [{
      id: "generate",
      type: nodeType,
      params: imageGenerationParameters(input.modelId, input.executionProvider, input.fallbackAllowed, input.prompt, input.images, input.parameters)
    }],
    edges: []
  };
  return executor.executeRoute(route);
}

async function runVideoModelForStackItem(input: { nodeId: string; modelId: string; executionProvider: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; prompt: string; images: Array<{ path: string; localPath?: string; mimeType: string }>; parameters: ImageGenerationSettings }) {
  if (input.executionProvider !== "auto" && input.executionProvider !== "polza") throw new Error("Video generation is currently available through polza.ai.");
  const executor = await createRouteExecutor();
  const route = {
    routeVersion: "0.1",
    route: {
      id: `snarkroute-video-generation-${input.nodeId}`,
      title: "SnarkRoute Video Generation",
      author: { name: "SnarkRoute" }
    },
    nodes: [{
      id: "generate",
      type: "polza.video.generate",
      params: imageGenerationParameters(input.modelId, input.executionProvider === "auto" ? "polza" : input.executionProvider, input.fallbackAllowed, input.prompt, input.images, input.parameters)
    }],
    edges: []
  };
  return executor.executeRoute(route);
}

interface ConnectedCanvasInput {
  nodeId: string;
  type: string;
  text?: string;
  image?: { path: string; localPath?: string; mimeType: string };
}

async function connectedCanvasInputs(libraryPath: string, targetNodeId: string): Promise<ConnectedCanvasInput[]> {
  const canvas = await ensureCanvas(libraryPath);
  const sourceNodeIds = (canvas.edges ?? []).filter((edge) => edge.toNodeId === targetNodeId).map((edge) => edge.fromNodeId);
  const inputs: ConnectedCanvasInput[] = [];
  for (const sourceNodeId of sourceNodeIds) {
    const sourceNode = canvas.nodes.find((node) => node.id === sourceNodeId);
    if (sourceNode?.type === "image") {
      const { manifest, nodePath } = await readImageNode(sourceNodeId);
      const item = manifest.stack[manifest.activeStackIndex];
      inputs.push({ nodeId: sourceNodeId, type: "image", image: item ? stackItemImageInput(nodePath, item) : undefined });
    }
    if (sourceNode?.type === "text") {
      const manifestPath = join(resolvePortablePath(libraryPath, sourceNode.nodePath), "snark.node.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TextNodeManifest;
      inputs.push({ nodeId: sourceNodeId, type: "text", text: manifest.text });
    }
  }
  return inputs;
}

function imageAssetFromGenerationOutput(output: unknown): { localPath?: string; path?: string; filename?: string; mimeType?: string; width?: unknown; height?: unknown } {
  if (!output || typeof output !== "object") throw new Error("Image generation returned no output.");
  const record = output as Record<string, unknown>;
  const image = record.image;
  if (!image || typeof image !== "object") throw new Error("Image generation returned no image asset.");
  return image as { localPath?: string; path?: string; filename?: string; mimeType?: string; width?: unknown; height?: unknown };
}

function videoAssetFromGenerationOutput(output: unknown): { localPath?: string; path?: string; filename?: string; mimeType?: string; width?: unknown; height?: unknown } {
  if (!output || typeof output !== "object") throw new Error("Video generation returned no output.");
  const record = output as Record<string, unknown>;
  const video = record.video;
  if (!video || typeof video !== "object") throw new Error("Video generation returned no video asset.");
  return video as { localPath?: string; path?: string; filename?: string; mimeType?: string; width?: unknown; height?: unknown };
}

export async function duplicateStackItemAsConnectedImageNode(input: DuplicateStackItemInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest: sourceManifest, nodePath: sourceNodePath } = await readImageNode(input.nodeId);
  const sourceItem = sourceManifest.stack.find((item) => item.id === input.stackItemId);
  if (!sourceItem) throw new Error(`Stack item "${input.stackItemId}" was not found.`);

  const now = new Date().toISOString();
  const id = `image_${shortId()}`;
  const title = sourceManifest.title || "Image";
  const folderName = `${slugify(title)}-${id}.imgnode`;
  const nodeRelativePath = portableJoin("image-nodes", folderName);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const stackPath = join(nodePath, "stack");
  const extension = extname(sourceItem.file ?? sourceItem.externalUrl ?? "").toLowerCase() || ".png";
  const imageRelativePath = portableJoin("stack", `000-import${extension}`);
  await mkdir(stackPath, { recursive: true });
  if (sourceItem.file) await copyFile(resolvePortablePath(sourceNodePath, sourceItem.file), resolvePortablePath(nodePath, imageRelativePath));

  const manifest: ImageNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "image",
    title,
    stack: [{
      id: `stack_${shortId()}`,
      file: sourceItem.file ? imageRelativePath : undefined,
      externalUrl: sourceItem.externalUrl,
      source: "import",
      mimeType: sourceItem.mimeType,
      width: sourceItem.width,
      height: sourceItem.height,
      createdAt: now
    }],
    activeStackIndex: 0,
    createdAt: now,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), manifest);
  await writeCurrentPrompt(nodePath, sourceManifest.currentPrompt ?? "");

  const width = input.width ?? defaultNodeWidth;
  const height = input.height ?? defaultNodeHeight;
  const canvas = await ensureCanvas(libraryPath);
  canvas.nodes.push({
    id,
    type: "image",
    nodePath: nodeRelativePath,
    x: Math.round(input.x - width / 2),
    y: Math.round(input.y - height / 2),
    width,
    height
  });
  canvas.edges = [...(canvas.edges ?? []), { id: `edge_${shortId()}`, fromNodeId: input.nodeId, toNodeId: id }];
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function duplicateStackItemAsConnectedVideoNode(input: DuplicateStackItemInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest: sourceManifest, nodePath: sourceNodePath } = await readVideoNode(input.nodeId);
  const sourceItem = sourceManifest.stack.find((item) => item.id === input.stackItemId);
  if (!sourceItem?.file) throw new Error(`Stack item "${input.stackItemId}" was not found.`);

  const now = new Date().toISOString();
  const id = `video_${shortId()}`;
  const folderName = `${slugify(sourceManifest.title || "Video")}-${id}.vidnode`;
  const nodeRelativePath = portableJoin("video-nodes", folderName);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const extension = extname(sourceItem.file).toLowerCase() || ".mp4";
  const videoRelativePath = portableJoin("stack", `000-import${extension}`);
  await mkdir(join(nodePath, "stack"), { recursive: true });
  await copyFile(resolvePortablePath(sourceNodePath, sourceItem.file), resolvePortablePath(nodePath, videoRelativePath));

  const manifest: VideoNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "video",
    title: sourceManifest.title || "Video",
    stack: [{ ...sourceItem, id: `stack_${shortId()}`, file: videoRelativePath, source: "import", createdAt: now }],
    activeStackIndex: 0,
    createdAt: now,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), manifest);
  await writeCurrentPrompt(nodePath, sourceManifest.currentPrompt ?? "");

  const width = input.width ?? defaultNodeWidth;
  const height = input.height ?? defaultNodeHeight;
  const canvas = await ensureCanvas(libraryPath);
  canvas.nodes.push({
    id,
    type: "video",
    nodePath: nodeRelativePath,
    x: Math.round(input.x - width / 2),
    y: Math.round(input.y - height / 2),
    width,
    height
  });
  canvas.edges = [...(canvas.edges ?? []), { id: `edge_${shortId()}`, fromNodeId: input.nodeId, toNodeId: id }];
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function createEmptyCanvasNode(input: CreateNodeInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const now = new Date().toISOString();
  const id = `${input.type}_${shortId()}`;
  const width = input.width ?? defaultNodeWidth;
  const height = input.height ?? defaultNodeHeight;
  const nodeRelativePath = portableJoin(
    input.type === "image" ? "image-nodes" : input.type === "video" ? "video-nodes" : "text-nodes",
    `${input.type}-${id}.${input.type === "image" ? "imgnode" : input.type === "video" ? "vidnode" : "txtnode"}`
  );
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  await mkdir(nodePath, { recursive: true });

  if (input.type === "image") {
    const manifest: ImageNodeManifest = {
      format: "snarkroute.node",
      version: "0.1",
      id,
      type: "image",
      title: "Image",
      stack: [],
      activeStackIndex: 0,
      createdAt: now,
      updatedAt: now
    };
    await writeJson(join(nodePath, "snark.node.json"), manifest);
    await writeCurrentPrompt(nodePath, "");
  } else if (input.type === "video") {
    const manifest: VideoNodeManifest = {
      format: "snarkroute.node",
      version: "0.1",
      id,
      type: "video",
      title: "Video",
      stack: [],
      activeStackIndex: 0,
      createdAt: now,
      updatedAt: now
    };
    await writeJson(join(nodePath, "snark.node.json"), manifest);
    await writeCurrentPrompt(nodePath, "");
  } else {
    const manifest: TextNodeManifest = {
      format: "snarkroute.node",
      version: "0.1",
      id,
      type: "text",
      title: "Text",
      text: "",
      color: "mint",
      createdAt: now,
      updatedAt: now
    };
    await writeJson(join(nodePath, "snark.node.json"), manifest);
  }

  const canvas = await ensureCanvas(libraryPath);
  canvas.nodes.push({
    id,
    type: input.type,
    nodePath: nodeRelativePath,
    x: Math.round(input.x - width / 2),
    y: Math.round(input.y - height / 2),
    width,
    height
  });
  if (input.connectFromNodeId) {
    canvas.edges = [...(canvas.edges ?? []), { id: `edge_${shortId()}`, fromNodeId: input.connectFromNodeId, toNodeId: id }];
  }
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function duplicateCanvasNode(input: DuplicateCanvasNodeInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const sourceCanvasNode = canvas.nodes.find((node) => node.id === input.nodeId);
  if (!sourceCanvasNode) throw new Error(`Node "${input.nodeId}" was not found.`);

  const sourcePath = resolvePortablePath(libraryPath, sourceCanvasNode.nodePath);
  const manifest = JSON.parse(await readFile(join(sourcePath, "snark.node.json"), "utf8")) as ImageNodeManifest | VideoNodeManifest | TextNodeManifest | LibraryNodeManifest;
  const now = new Date().toISOString();
  const id = `${manifest.type}_${shortId()}`;
  const title = `${manifest.title || manifest.type} copy`;
  const directory = manifest.type === "image" ? "image-nodes" : manifest.type === "video" ? "video-nodes" : manifest.type === "library" ? "library-nodes" : "text-nodes";
  const extension = manifest.type === "image" ? "imgnode" : manifest.type === "video" ? "vidnode" : manifest.type === "library" ? "libnode" : "txtnode";
  const nodeRelativePath = portableJoin(directory, `${slugify(title)}-${id}.${extension}`);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  await cp(sourcePath, nodePath, { recursive: true });
  await writeJson(join(nodePath, "snark.node.json"), { ...manifest, id, title, createdAt: now, updatedAt: now });

  canvas.nodes.push({
    ...sourceCanvasNode,
    id,
    nodePath: nodeRelativePath,
    x: Math.round(input.x),
    y: Math.round(input.y)
  });
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function updateTextNode(nodeId: string, updates: { text?: string; color?: string }): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const canvasNode = canvas.nodes.find((node) => node.id === nodeId && node.type === "text");
  if (!canvasNode) throw new Error(`Text node "${nodeId}" was not found.`);
  const manifestPath = join(resolvePortablePath(libraryPath, canvasNode.nodePath), "snark.node.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TextNodeManifest;
  if (manifest.type !== "text") throw new Error(`Node "${nodeId}" is not a text node.`);
  await writeJson(manifestPath, {
    ...manifest,
    text: updates.text ?? manifest.text,
    color: updates.color ?? manifest.color,
    updatedAt: new Date().toISOString()
  });
  return readLibrarySnapshot(libraryPath);
}

export async function updateImageNodePrompt(nodeId: string, prompt: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { nodePath } = await readImageNode(nodeId);
  await writeCurrentPrompt(nodePath, prompt);
  return readLibrarySnapshot(libraryPath);
}

export async function updateVideoNodePrompt(nodeId: string, prompt: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { nodePath } = await readVideoNode(nodeId);
  await writeCurrentPrompt(nodePath, prompt);
  return readLibrarySnapshot(libraryPath);
}

export async function updateMediaNodeRouteSettings(type: "image" | "video", nodeId: string, input: UpdateMediaNodeRouteSettingsInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = type === "image" ? await readImageNode(nodeId) : await readVideoNode(nodeId);
  const modelId = input.modelId.trim();
  if (!modelId) throw new Error("modelId is required.");
  await writeJson(join(nodePath, "snark.node.json"), {
    ...manifest,
    modelId,
    executionProvider: input.executionProvider?.trim() || "auto",
    fallbackAllowed: input.fallbackAllowed !== false,
    updatedAt: new Date().toISOString()
  });
  return readLibrarySnapshot(libraryPath);
}

export async function renameCanvasNode(nodeId: string, title: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const canvasNode = canvas.nodes.find((node) => node.id === nodeId);
  if (!canvasNode) throw new Error(`Node "${nodeId}" was not found.`);
  const manifestPath = join(resolvePortablePath(libraryPath, canvasNode.nodePath), "snark.node.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest | VideoNodeManifest | TextNodeManifest | LibraryNodeManifest;
  await writeJson(manifestPath, { ...manifest, title: title.trim() || manifest.title, updatedAt: new Date().toISOString() });
  return readLibrarySnapshot(libraryPath);
}

export async function deleteCanvasNode(nodeId: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const canvasNode = canvas.nodes.find((node) => node.id === nodeId);
  if (!canvasNode) throw new Error(`Node "${nodeId}" was not found.`);
  const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
  canvas.nodes = canvas.nodes.filter((node) => node.id !== nodeId);
  canvas.edges = (canvas.edges ?? []).filter((edge) => edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId);
  await writeCanvas(libraryPath, canvas);
  const trashDirectory = join(libraryPath, ".trash", "nodes");
  await mkdir(trashDirectory, { recursive: true });
  await rename(nodePath, join(trashDirectory, `${basename(nodePath)}-${Date.now().toString(36)}-${shortId()}`));
  await replaceDeletedRepresentativeImage(libraryPath, nodeId);
  return readLibrarySnapshot(libraryPath);
}

export async function deleteCanvasEdge(edgeId: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  canvas.edges = (canvas.edges ?? []).filter((edge) => edge.id !== edgeId);
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function canvasNodeFolderPath(nodeId: string): Promise<string> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const canvasNode = canvas.nodes.find((node) => node.id === nodeId);
  if (!canvasNode) throw new Error(`Node "${nodeId}" was not found.`);
  return resolvePortablePath(libraryPath, canvasNode.nodePath);
}

export async function readImageNode(nodeId: string): Promise<{ manifest: ImageNodeManifest; nodePath: string }> {
  const libraryPath = await ensureCurrentLibrary();
  const nodesDirectory = join(libraryPath, "image-nodes");
  const entries = await readdir(nodesDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nodePath = join(nodesDirectory, entry.name);
    const manifestPath = join(nodePath, "snark.node.json");
    if (!await fileExists(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest;
    if (manifest.id === nodeId) return { manifest: { ...manifest, currentPrompt: await readCurrentPrompt(nodePath) }, nodePath };
  }
  throw new Error(`Image node "${nodeId}" was not found.`);
}

export async function readVideoNode(nodeId: string): Promise<{ manifest: VideoNodeManifest; nodePath: string }> {
  const libraryPath = await ensureCurrentLibrary();
  const nodesDirectory = join(libraryPath, "video-nodes");
  const entries = await readdir(nodesDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nodePath = join(nodesDirectory, entry.name);
    const manifestPath = join(nodePath, "snark.node.json");
    if (!await fileExists(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as VideoNodeManifest;
    if (manifest.id === nodeId) return { manifest: { ...manifest, currentPrompt: await readCurrentPrompt(nodePath) }, nodePath };
  }
  throw new Error(`Video node "${nodeId}" was not found.`);
}

export async function readLibraryNode(nodeId: string): Promise<{ manifest: LibraryNodeManifest; nodePath: string }> {
  const libraryPath = await ensureCurrentLibrary();
  const nodesDirectory = join(libraryPath, "library-nodes");
  const entries = await readdir(nodesDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nodePath = join(nodesDirectory, entry.name);
    const manifestPath = join(nodePath, "snark.node.json");
    if (!await fileExists(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as LibraryNodeManifest;
    if (manifest.id === nodeId) return { manifest, nodePath };
  }
  throw new Error(`Library item "${nodeId}" was not found.`);
}

export async function createImageStackReadStream(nodeId: string, stackItemId: string): Promise<{ stream?: ReturnType<typeof createReadStream>; mimeType: string; remoteUrl?: string }> {
  const { manifest, nodePath } = await readImageNode(nodeId);
  const item = manifest.stack.find((entry) => entry.id === stackItemId);
  if (!item) throw new Error(`Stack item "${stackItemId}" was not found.`);
  if (item.externalUrl) return { mimeType: item.mimeType, remoteUrl: item.externalUrl };
  if (!item.file) throw new Error(`Stack item "${stackItemId}" does not contain an image source.`);
  const imagePath = resolvePortablePath(nodePath, item.file);
  return { stream: createReadStream(imagePath), mimeType: item.mimeType };
}

export async function createVideoStackReadStream(nodeId: string, stackItemId: string): Promise<{ stream: ReturnType<typeof createReadStream>; mimeType: string }> {
  const { manifest, nodePath } = await readVideoNode(nodeId);
  const item = manifest.stack.find((entry) => entry.id === stackItemId);
  if (!item?.file) throw new Error(`Stack item "${stackItemId}" was not found.`);
  return { stream: createReadStream(resolvePortablePath(nodePath, item.file)), mimeType: item.mimeType };
}

export function centeredCanvasNodePosition(dropX: number, dropY: number, width = defaultNodeWidth, height = defaultNodeHeight): { x: number; y: number } {
  return { x: Math.round(dropX - width / 2), y: Math.round(dropY - height / 2) };
}

async function ensureCurrentLibrary(): Promise<string> {
  const envPath = process.env.SNARKROUTE_LIBRARY_PATH ? resolve(process.env.SNARKROUTE_LIBRARY_PATH) : "";
  if (envPath && envPath !== currentLibraryPath) currentLibraryPath = envPath;
  await mkdir(currentLibraryPath, { recursive: true });
  await ensureLibraryManifest(currentLibraryPath, { title: "SnarkRoute Library", libraryKind: "workspace", contentKind: "mixed", defaultView: "canvas" });
  await ensureCanvas(currentLibraryPath);
  return currentLibraryPath;
}

async function ensureLibraryManifest(libraryPath: string, options: { title: string; libraryKind: LibraryKind; contentKind: LibraryContentKind; defaultView: LibraryDefaultView }): Promise<SnarkLibraryManifest> {
  const manifestPath = join(libraryPath, manifestFilename);
  if (await fileExists(manifestPath)) return readLibraryManifest(libraryPath);
  const now = new Date().toISOString();
  const manifest: SnarkLibraryManifest = {
    format: "snarkroute.library",
    version: "0.1",
    id: `library_${shortId()}`,
    title: options.title,
    libraryKind: options.libraryKind,
    contentKind: options.contentKind,
    defaultView: options.defaultView,
    canvas: options.defaultView === "canvas" ? canvasFilename : undefined,
    createdAt: now,
    updatedAt: now
  };
  await writeJson(manifestPath, manifest);
  return manifest;
}

async function ensureCanvas(libraryPath: string): Promise<SnarkCanvasDocument> {
  const manifest = await readLibraryManifest(libraryPath);
  const existing = await readCanvas(libraryPath, manifest);
  if (existing) return existing;
  const now = new Date().toISOString();
  const canvas: SnarkCanvasDocument = { format: "snarkroute.canvas", version: "0.1", nodes: [], createdAt: now, updatedAt: now };
  return writeCanvas(libraryPath, canvas);
}

async function readLibraryManifest(libraryPath: string): Promise<SnarkLibraryManifest> {
  const manifestPath = join(libraryPath, manifestFilename);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnarkLibraryManifest;
  if (manifest.format !== "snarkroute.library") throw new Error(`${manifestFilename} has unsupported format.`);
  return manifest;
}

async function writeLibraryManifest(libraryPath: string, manifest: SnarkLibraryManifest): Promise<void> {
  await writeJson(join(libraryPath, manifestFilename), manifest);
}

async function readCanvasNodes(libraryPath: string, canvas: SnarkCanvasDocument): Promise<NodeView[]> {
  const nodes: NodeView[] = [];
  for (const canvasNode of canvas.nodes) {
    const manifestPath = join(resolvePortablePath(libraryPath, canvasNode.nodePath), "snark.node.json");
    if (!await fileExists(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest | VideoNodeManifest | TextNodeManifest | LibraryNodeManifest;
    if (manifest.type === "image") {
      const hydratedManifest = { ...manifest, currentPrompt: await readCurrentPrompt(resolvePortablePath(libraryPath, canvasNode.nodePath)) };
      const activeStackItem = hydratedManifest.stack[hydratedManifest.activeStackIndex] ?? null;
      nodes.push({
        canvas: canvasNode,
        manifest: hydratedManifest,
        activeStackItem,
        previewUrl: activeStackItem ? `/api/libraries/current/image-nodes/${encodeURIComponent(hydratedManifest.id)}/stack/${encodeURIComponent(activeStackItem.id)}` : null
      });
    }
    if (manifest.type === "video") {
      const hydratedManifest = { ...manifest, currentPrompt: await readCurrentPrompt(resolvePortablePath(libraryPath, canvasNode.nodePath)) };
      const activeStackItem = hydratedManifest.stack[hydratedManifest.activeStackIndex] ?? null;
      nodes.push({
        canvas: canvasNode,
        manifest: hydratedManifest,
        activeStackItem,
        previewUrl: activeStackItem ? `/api/libraries/current/video-nodes/${encodeURIComponent(hydratedManifest.id)}/stack/${encodeURIComponent(activeStackItem.id)}` : null
      });
    }
    if (manifest.type === "text") {
      nodes.push({ canvas: canvasNode, manifest, activeStackItem: null, previewUrl: null });
    }
    if (manifest.type === "library") {
      let scan: LocalLibraryScanResult;
      try {
        scan = await scanLocalLibrary(manifest.sourcePath);
      } catch (error) {
        scan = {
          sourceType: "local-folder",
          sourcePath: manifest.sourcePath,
          manifest: null,
          id: manifest.id,
          title: manifest.title,
          defaultView: manifest.viewMode,
          availableViews: [manifest.viewMode],
          assets: [],
          prompts: [],
          error: error instanceof Error ? error.message : String(error)
        };
      }
      const coverAsset = scan.assets.find((asset) => asset.id === scan.coverAssetId);
      nodes.push({
        canvas: canvasNode,
        manifest,
        scan,
        activeStackItem: null,
        previewUrl: coverAsset ? `/api/libraries/current/library-nodes/${encodeURIComponent(manifest.id)}/assets/${encodeURIComponent(coverAsset.id)}` : null
      });
    }
  }
  return nodes;
}

function resolvePortablePath(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error("Library paths must be relative.");
  const resolved = resolve(root, relativePath);
  const rootResolved = resolve(root);
  const rel = relative(rootResolved, resolved);
  if (rel.startsWith("..") || rel === ".." || rel.split(sep).includes("..")) throw new Error("Path escapes the library folder.");
  return resolved;
}

function portableJoin(...parts: string[]): string {
  return parts.join("/");
}

function nextStackFilename(stack: ImageStackItem[], label: string, extension: string): string {
  const used = new Set(stack.map((item) => item.file));
  for (let index = 0; index < 10000; index += 1) {
    const candidate = portableJoin("stack", `${String(index).padStart(3, "0")}-${label}${extension}`);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a stack filename.");
}

async function writeCurrentPrompt(nodePath: string, prompt: string): Promise<void> {
  await writeFile(join(nodePath, currentPromptFilename), prompt, "utf8");
}

async function readCurrentPrompt(nodePath: string): Promise<string> {
  try {
    return await readFile(join(nodePath, currentPromptFilename), "utf8");
  } catch {
    await writeCurrentPrompt(nodePath, "");
    return "";
  }
}

async function setLibraryRepresentativeImage(libraryPath: string, nodeId: string, stackItemId: string): Promise<void> {
  const manifest = await readLibraryManifest(libraryPath);
  await writeLibraryManifest(libraryPath, {
    ...manifest,
    representativeImage: { nodeId, stackItemId },
    updatedAt: new Date().toISOString()
  });
}

async function replaceDeletedRepresentativeImage(libraryPath: string, nodeId: string, stackItemId?: string, replacementStackItemId?: string): Promise<void> {
  const manifest = await readLibraryManifest(libraryPath);
  if (manifest.representativeImage?.nodeId !== nodeId) return;
  if (stackItemId && manifest.representativeImage.stackItemId !== stackItemId) return;
  await writeLibraryManifest(libraryPath, {
    ...manifest,
    representativeImage: replacementStackItemId ? { nodeId, stackItemId: replacementStackItemId } : undefined,
    updatedAt: new Date().toISOString()
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readLocalLibraryManifest(root: string): Promise<LocalLibraryManifest | null> {
  const path = join(root, "snark-library.json");
  if (!await fileExists(path)) return null;
  const manifest = JSON.parse(await readFile(path, "utf8")) as Partial<LocalLibraryManifest>;
  if (manifest.kind !== "library/local-folder" || typeof manifest.id !== "string" || typeof manifest.title !== "string") {
    throw new Error("snark-library.json must describe kind library/local-folder with id and title.");
  }
  const availableViews = Array.isArray(manifest.availableViews)
    ? manifest.availableViews.filter(isLibraryViewMode)
    : undefined;
  return {
    ...manifest,
    schema: typeof manifest.schema === "string" ? manifest.schema : "snarkroute-library.v0",
    kind: manifest.kind,
    id: manifest.id,
    title: manifest.title,
    defaultView: isLibraryViewMode(manifest.defaultView) ? manifest.defaultView : undefined,
    availableViews
  };
}

async function listLocalLibraryFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  return files.sort();
}

function isLibraryViewMode(value: unknown): value is LibraryViewMode {
  return value === "media-folder" || value === "image-stack" || value === "text-library" || value === "prompt-library" || value === "board" || value === "workflow";
}

function localLibraryAssetKind(path: string, embeddedPrompt: PromptLibraryPrompt | undefined): LocalLibraryAsset["kind"] {
  const lower = path.toLowerCase();
  const extension = extname(lower);
  if (lower.endsWith(".prompt.md") || lower.endsWith(".prompt.png")) return "prompt";
  if (extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".webp" || extension === ".gif") return "image";
  if (extension === ".mp4" || extension === ".webm" || extension === ".mov") return "video";
  if (extension === ".mp3" || extension === ".wav" || extension === ".ogg") return "audio";
  if (extension === ".md" || extension === ".txt") return embeddedPrompt ? "prompt" : "text";
  return "file";
}

function localLibraryMimeType(extension: string): string {
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".webm") return "video/webm";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".md" || extension === ".txt") return "text/plain";
  if (extension === ".json") return "application/json";
  return "application/octet-stream";
}

function detectLibraryViews(assets: LocalLibraryAsset[], paths: string[], manifest: LocalLibraryManifest | null): LibraryViewMode[] {
  const lowerPaths = paths.map((path) => path.toLowerCase());
  const views = new Set<LibraryViewMode>(["media-folder"]);
  if (assets.some((asset) => asset.kind === "image")) views.add("image-stack");
  if (assets.some((asset) => asset.kind === "text")) views.add("text-library");
  if (assets.some((asset) => asset.kind === "prompt" || asset.embeddedPrompt)) views.add("prompt-library");
  if (manifest?.entryBoard || lowerPaths.some((path) => path.endsWith(".snarkboard.json") || path.endsWith(".board.json"))) views.add("board");
  if (manifest?.entryWorkflow || lowerPaths.some((path) => /\.(orp|orp\.json|orp\.yaml|route|route\.json|route\.yaml)$/u.test(path) || path.endsWith("workflow.route.json"))) views.add("workflow");
  return [...views];
}

function orderedLibraryViews(views: LibraryViewMode[]): LibraryViewMode[] {
  const order: LibraryViewMode[] = ["media-folder", "image-stack", "text-library", "prompt-library", "board", "workflow"];
  return order.filter((mode) => views.includes(mode));
}

function normalizedImageExtension(filename: string): ".png" | ".jpg" | ".jpeg" | ".webp" {
  const extension = extname(filename).toLowerCase();
  if (extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".webp") return extension;
  throw new Error("Supported image formats are .png, .jpg, .jpeg, and .webp.");
}

function normalizedVideoExtension(filename: string): ".mp4" | ".webm" | ".mov" {
  const extension = extname(filename).toLowerCase();
  if (extension === ".mp4" || extension === ".webm" || extension === ".mov") return extension;
  throw new Error("Supported video formats are .mp4, .webm, and .mov.");
}

function stackItemImageInput(nodePath: string, item: ImageStackItem): { path: string; localPath?: string; mimeType: string } {
  if (item.externalUrl) return { path: item.externalUrl, mimeType: item.mimeType };
  if (!item.file) throw new Error(`Stack item "${item.id}" does not contain an image source.`);
  const path = resolvePortablePath(nodePath, item.file);
  return { path, localPath: path, mimeType: item.mimeType };
}

async function readGeneratedImageBuffer(path: string): Promise<Buffer> {
  if (!isRemoteUrl(path)) return readFile(path);
  const response = await fetchWithTimeout(path, 15000).catch((error) => {
    throw new Error(`Could not save generated image in its stack folder: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!response.ok) throw new Error(`Could not save generated image in its stack folder: download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizedGeneratedExtension(filename: string): ".png" | ".jpg" | ".jpeg" | ".webp" {
  try {
    return normalizedImageExtension(filename);
  } catch {
    return ".png";
  }
}

function normalizedGeneratedVideoExtension(filename: string): ".mp4" | ".webm" | ".mov" {
  try {
    return normalizedVideoExtension(filename);
  } catch {
    return ".mp4";
  }
}

function mimeTypeFromExtension(extension: string): string {
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

function videoMimeTypeFromExtension(extension: string): string {
  if (extension === ".webm") return "video/webm";
  if (extension === ".mov") return "video/quicktime";
  return "video/mp4";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function limitImages<T>(images: T[], maxImages: number | undefined): T[] {
  return maxImages ? images.slice(0, maxImages) : images;
}

function orderConnectedInputs(inputs: ConnectedCanvasInput[], nodeIds: string[] | undefined): ConnectedCanvasInput[] {
  if (!Array.isArray(nodeIds)) return inputs;
  const rank = new Map(nodeIds.map((nodeId, index) => [nodeId, index]));
  return [...inputs].sort((left, right) => (rank.get(left.nodeId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.nodeId) ?? Number.MAX_SAFE_INTEGER));
}

function resolveInputTokens(
  promptTemplate: string,
  inputs: ConnectedCanvasInput[],
  sentImages: Array<{ path: string; localPath?: string; mimeType: string }>,
  imageReferenceSyntax: string | undefined
): string {
  const inputById = new Map(inputs.map((entry) => [entry.nodeId, entry]));
  return promptTemplate.replace(/\[\[(text|image|video):([^\]]+)\]\]/g, (_token, type: string, nodeId: string) => {
    const input = inputById.get(nodeId);
    if (!input || input.type !== type) return "";
    if (type === "text") return input.text ?? "";
    if (!input.image || !imageReferenceSyntax) return "";
    const position = sentImages.findIndex((image) => image.path === input.image?.path);
    return position >= 0 ? imageReferenceSyntax.replaceAll("{index}", String(position + 1)) : "";
  });
}

function imageGenerationParameters(
  modelId: string,
  executionProvider: string,
  fallbackAllowed: boolean | undefined,
  prompt: string,
  images: Array<{ path: string; localPath?: string; mimeType: string }>,
  settings: ImageGenerationSettings = sanitizeImageGenerationSettings()
): Record<string, unknown> {
  return {
    model: modelId,
    executionProvider,
    providerMode: executionProvider === "openrouter" ? "openrouter" : executionProvider === "gemini" ? "direct" : "auto",
    fallbackAllowed: fallbackAllowed !== false,
    prompt,
    images,
    ...settings
  };
}

function executionProviderForInput(input: { executionProvider?: string; providerId?: string }): string {
  return input.executionProvider?.trim() || input.providerId?.trim() || "auto";
}

function sanitizeImageGenerationSettings(settings: ImageGenerationSettings | undefined = undefined): ImageGenerationSettings {
  if (!settings) return {};
  const sanitized: ImageGenerationSettings = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,60}$/.test(key)) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed && trimmed.length <= 80) sanitized[key] = trimmed;
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) sanitized[key] = value;
  }
  return sanitized;
}

function titleFromFilename(filename: string): string {
  const safe = sanitizeFilename(basename(filename, extname(filename))).replace(/[_-]+/g, " ").trim();
  return safe || "Imported Image";
}

function slugify(value: string): string {
  const safe = sanitizeFilename(value.toLowerCase()).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "library";
}

function shortId(): string {
  return `${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

function readImageDimensions(buffer: Buffer, extension: string): { width: number; height: number } {
  if (extension === ".png" && buffer.toString("ascii", 12, 16) === "IHDR") return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if ((extension === ".jpg" || extension === ".jpeg") && buffer[0] === 0xff && buffer[1] === 0xd8) return readJpegDimensions(buffer);
  if (extension === ".webp" && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return readWebpDimensions(buffer);
  return { width: 0, height: 0 };
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } {
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (chunk === "VP8 " && buffer.length >= 30) return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { width: 0, height: 0 };
}
