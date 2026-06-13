import { createReadStream } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { loadPromptLibrary, parsePromptPngFile, writePngTextChunk, type PromptLibraryPrompt } from "@snarkroute/nodes";
import { librariesDirectory } from "../server-paths";
import { sanitizeFilename } from "../assets/service";
import { createRouteExecutor } from "../execution/service";
import { createTextPromptAsset } from "../prompt-library/service";
import { fetchWithTimeout } from "../services/http";
import { embedImageProvenance, imageMetadataSchema, type SnarkImageMetadata } from "./image-metadata";

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
  kind?: "representation" | "crop";
  note?: string;
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
  crop?: CropMetadata;
  stack: ImageStackItem[];
  activeStackIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropMetadata {
  sourceNodeId: string;
  rect: CropRect;
  aspectRatio?: number | null;
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
  stackPath?: string;
  selectedStackItemId?: string;
  modelId?: string;
  executionProvider?: string;
  fallbackAllowed?: boolean;
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

export interface TextStackItem {
  id: string;
  file: string;
  title: string;
  text: string;
  source: "prompt" | "text";
  mimeType: string;
  previewFile?: string;
}

export interface LibrarySnapshot {
  manifest: SnarkLibraryManifest;
  path: string;
  nestedLibraries: NestedLibrary[];
  canvas: SnarkCanvasDocument | null;
  nodes: NodeView[];
}

export interface LibraryProjectSummary {
  id: string;
  title: string;
  path: string;
  coverUrl: string | null;
  current: boolean;
}

export interface LibraryProjectImageSummary {
  id: string;
  title: string;
  url: string;
}

interface LibraryProjectRegistry {
  version: 1;
  projects: LibraryProjectRegistryEntry[];
}

interface LibraryProjectRegistryEntry {
  path: string;
  addedAt: string;
  coverPath?: string;
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
  stack: TextStackItem[];
  activeStackItem: TextStackItem | null;
  outputText: string;
  previewUrl: string | null;
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
  connectFromNodeId?: string;
  crop?: CropMetadata;
}

export interface ImportVideoInput extends ImportImageInput {}

export interface ImportTextInput {
  filename: string;
  text: string;
  dropX: number;
  dropY: number;
  width?: number;
  height?: number;
}

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
  crop?: CropMetadata;
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

export interface GenerateTextNodeInput {
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
}

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

export interface DuplicateCanvasNodeAsRepresentationInput extends DuplicateCanvasNodeInput {
  type: "image" | "video" | "text";
  width?: number;
  height?: number;
  connectFromNodeId?: string;
}

export interface ImportLocalLibraryInput {
  sourcePath: string;
  viewMode?: LibraryViewMode;
  dropX: number;
  dropY: number;
  width?: number;
  height?: number;
}

export interface ImportLocalFolderStackInput {
  sourcePath: string;
  stackKind: "image" | "text" | "video";
  dropX: number;
  dropY: number;
  width?: number;
  height?: number;
}

const manifestFilename = "snark.library.json";
const canvasFilename = "canvas.json";
const currentPromptFilename = "current-prompt.txt";
const projectRegistryFilename = "projects.json";
const defaultNodeWidth = 320;
const defaultNodeHeight = 240;
let currentLibraryPath = process.env.SNARKROUTE_LIBRARY_PATH ? resolve(process.env.SNARKROUTE_LIBRARY_PATH) : join(librariesDirectory, "default");
let currentLibraryInitialized = false;

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

export async function listLibraryProjects(): Promise<{ projects: LibraryProjectSummary[] }> {
  const activePath = await ensureCurrentLibrary();
  const records = (await readProjectRegistry()).projects;
  const projects = await Promise.all(records.map((record) => projectSummary(record.path, record.path === activePath, record.coverPath)));
  return { projects };
}

export async function addLibraryProject(path: string): Promise<{ projects: LibraryProjectSummary[]; current: LibrarySnapshot }> {
  const projectPath = resolve(path);
  await ensureProjectLibrary(projectPath);
  await saveProjectPath(projectPath);
  currentLibraryPath = projectPath;
  return { projects: (await listLibraryProjects()).projects, current: await readLibrarySnapshot(projectPath) };
}

export async function openLibraryProject(path: string): Promise<{ projects: LibraryProjectSummary[]; current: LibrarySnapshot }> {
  const projectPath = resolve(path);
  await readLibraryManifest(projectPath);
  await saveProjectPath(projectPath);
  currentLibraryPath = projectPath;
  return { projects: (await listLibraryProjects()).projects, current: await readLibrarySnapshot(projectPath) };
}

export async function removeLibraryProject(path: string): Promise<{ projects: LibraryProjectSummary[]; current: LibrarySnapshot }> {
  const projectPath = resolve(path);
  const registry = await readProjectRegistry();
  registry.projects = registry.projects.filter((project) => resolve(project.path) !== projectPath);
  await writeProjectRegistry(registry);
  if (resolve(currentLibraryPath) === projectPath) {
    currentLibraryPath = registry.projects[0]?.path ? resolve(registry.projects[0].path) : join(librariesDirectory, "default");
  }
  const activePath = await ensureCurrentLibrary();
  return { projects: (await listLibraryProjects()).projects, current: await readLibrarySnapshot(activePath) };
}

export async function createProjectCoverReadStream(projectId: string): Promise<{ stream: ReturnType<typeof createReadStream>; mimeType: string }> {
  const project = await projectRecordById(projectId);
  if (!project) throw new Error(`Project "${projectId}" was not found.`);
  const cover = await findProjectCover(project.path, project.coverPath);
  if (!cover) throw new Error(`Project "${basename(project.path) || projectId}" has no cover image.`);
  return { stream: createReadStream(cover.path), mimeType: cover.mimeType };
}

export async function listLibraryProjectImages(projectId: string): Promise<{ images: LibraryProjectImageSummary[] }> {
  const project = await projectRecordById(projectId);
  if (!project) throw new Error(`Project "${projectId}" was not found.`);
  const images = (await findProjectImages(project.path)).map((image) => ({
    id: projectImageId(image.path),
    title: basename(image.path),
    url: `/api/libraries/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(projectImageId(image.path))}`
  }));
  return { images };
}

export async function createProjectImageReadStream(projectId: string, imageId: string): Promise<{ stream: ReturnType<typeof createReadStream>; mimeType: string }> {
  const project = await projectRecordById(projectId);
  if (!project) throw new Error(`Project "${projectId}" was not found.`);
  const image = (await findProjectImages(project.path)).find((candidate) => projectImageId(candidate.path) === imageId);
  if (!image) throw new Error(`Project image "${imageId}" was not found.`);
  return { stream: createReadStream(image.path), mimeType: image.mimeType };
}

export async function setLibraryProjectCover(projectId: string, imageId: string): Promise<{ projects: LibraryProjectSummary[] }> {
  const project = await projectRecordById(projectId);
  if (!project) throw new Error(`Project "${projectId}" was not found.`);
  const image = (await findProjectImages(project.path)).find((candidate) => projectImageId(candidate.path) === imageId);
  if (!image) throw new Error(`Project image "${imageId}" was not found.`);
  const registry = await readProjectRegistry();
  const normalized = resolve(project.path);
  const existing = registry.projects.find((entry) => resolve(entry.path) === normalized);
  if (existing) {
    existing.coverPath = image.path;
  } else {
    registry.projects.unshift({ path: normalized, addedAt: new Date().toISOString(), coverPath: image.path });
  }
  await writeProjectRegistry(registry);
  return listLibraryProjects();
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
  const id = `image_${shortId()}`;
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, titleFromFilename(input.filename));
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const contentPath = join(nodePath, "content");
  const imageRelativePath = portableJoin("content", `000-import${extension}`);
  const imagePath = resolvePortablePath(nodePath, imageRelativePath);
  await mkdir(contentPath, { recursive: true });

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
    crop: input.crop,
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
  if (input.connectFromNodeId) {
    canvas.edges = [...(canvas.edges ?? []), { id: `edge_${shortId()}`, fromNodeId: input.connectFromNodeId, toNodeId: id, kind: "crop" }];
  }
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function importVideoAsNode(input: ImportVideoInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const extension = normalizedVideoExtension(input.filename);
  const id = `video_${shortId()}`;
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, titleFromFilename(input.filename));
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const videoRelativePath = portableJoin("content", `000-import${extension}`);
  const videoPath = resolvePortablePath(nodePath, videoRelativePath);
  await mkdir(join(nodePath, "content"), { recursive: true });

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

export async function importTextAsNode(input: ImportTextInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const body = input.text.trim();
  if (!body) throw new Error("Text is required.");
  const now = new Date().toISOString();
  const id = `text_${shortId()}`;
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, titleFromFilename(input.filename));
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  await mkdir(join(nodePath, "content"), { recursive: true });
  const saved = await createTextPromptAsset(join(nodePath, "content"), { title, prompt: body, category: "text-stack" });
  const relativeFile = portableRelativePath(nodePath, saved.promptPath);
  const manifest: TextNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "text",
    title,
    text: body,
    stackPath: "content",
    selectedStackItemId: textStackItemId(relativeFile),
    color: "mint",
    createdAt: now,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), manifest);

  const canvas = await ensureCanvas(libraryPath);
  const width = input.width ?? defaultNodeWidth;
  const height = input.height ?? 180;
  canvas.nodes.push({
    id,
    type: "text",
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
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, scan.title);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const viewMode = input.viewMode && scan.availableViews.includes(input.viewMode) ? input.viewMode : scan.defaultView;
  const manifest: LibraryNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "library",
    title,
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

async function importImageAssetsAsStackNode(scan: LocalLibraryScanResult, input: ImportLocalFolderStackInput): Promise<LibrarySnapshot> {
  const imageAssets = scan.assets.filter((asset) => asset.kind === "image" && /\.(png|jpe?g|webp)$/i.test(asset.relativePath));
  if (!imageAssets.length) throw new Error("Folder does not contain image assets.");
  const libraryPath = await ensureCurrentLibrary();
  const now = new Date().toISOString();
  const id = `image_${shortId()}`;
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, `${scan.title} Image Stack`);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  await mkdir(join(nodePath, "content"), { recursive: true });

  const stack: ImageStackItem[] = [];
  for (const [index, asset] of imageAssets.entries()) {
    const extension = normalizedImageExtension(asset.relativePath);
    const file = portableJoin("content", `${String(index + 1).padStart(3, "0")}-${sanitizeFilename(basename(asset.relativePath)) || `image${extension}`}`);
    const sourcePath = resolvePortablePath(scan.sourcePath, asset.relativePath);
    const targetPath = resolvePortablePath(nodePath, file);
    await copyFile(sourcePath, targetPath);
    const dimensions = readImageDimensions(await readFile(targetPath), extension);
    stack.push({ id: `stack_${shortId()}`, file, source: "folder-import", mimeType: mimeTypeFromExtension(extension), width: dimensions.width, height: dimensions.height, createdAt: now });
  }

  const manifest: ImageNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "image",
    title,
    stack,
    activeStackIndex: 0,
    createdAt: now,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), manifest);
  await writeCurrentPrompt(nodePath, "");
  await addTypedStackCanvasNode(libraryPath, id, "image", nodeRelativePath, input, defaultNodeWidth, defaultNodeHeight);
  await setLibraryRepresentativeImage(libraryPath, id, stack[0].id);
  return readLibrarySnapshot(libraryPath);
}

async function importVideoAssetsAsStackNode(scan: LocalLibraryScanResult, input: ImportLocalFolderStackInput): Promise<LibrarySnapshot> {
  const videoAssets = scan.assets.filter((asset) => asset.kind === "video");
  if (!videoAssets.length) throw new Error("Folder does not contain video assets.");
  const libraryPath = await ensureCurrentLibrary();
  const now = new Date().toISOString();
  const id = `video_${shortId()}`;
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, `${scan.title} Video Stack`);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  await mkdir(join(nodePath, "content"), { recursive: true });

  const stack: ImageStackItem[] = [];
  for (const [index, asset] of videoAssets.entries()) {
    const extension = normalizedVideoExtension(asset.relativePath);
    const file = portableJoin("content", `${String(index + 1).padStart(3, "0")}-${sanitizeFilename(basename(asset.relativePath)) || `video${extension}`}`);
    await copyFile(resolvePortablePath(scan.sourcePath, asset.relativePath), resolvePortablePath(nodePath, file));
    stack.push({ id: `stack_${shortId()}`, file, source: "folder-import", mimeType: videoMimeTypeFromExtension(extension), width: input.width ?? defaultNodeWidth, height: input.height ?? defaultNodeHeight, createdAt: now });
  }

  const manifest: VideoNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "video",
    title,
    stack,
    activeStackIndex: 0,
    createdAt: now,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), manifest);
  await writeCurrentPrompt(nodePath, "");
  await addTypedStackCanvasNode(libraryPath, id, "video", nodeRelativePath, input, defaultNodeWidth, defaultNodeHeight);
  return readLibrarySnapshot(libraryPath);
}

async function importTextAssetsAsStackNode(scan: LocalLibraryScanResult, input: ImportLocalFolderStackInput): Promise<LibrarySnapshot> {
  const textAssets = scan.assets.filter((asset) => asset.kind === "text" || Boolean(asset.embeddedPrompt));
  if (!textAssets.length) throw new Error("Folder does not contain text or prompt assets.");
  const libraryPath = await ensureCurrentLibrary();
  const now = new Date().toISOString();
  const id = `text_${shortId()}`;
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, `${scan.title} Text Stack`);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  await mkdir(join(nodePath, "content"), { recursive: true });

  let selectedStackItemId: string | undefined;
  let selectedText = "";
  for (const asset of textAssets) {
    const sourcePath = resolvePortablePath(scan.sourcePath, asset.relativePath);
    const text = asset.embeddedPrompt?.text ?? (await readFile(sourcePath, "utf8")).trim();
    if (!text) continue;
    const saved = await createTextPromptAsset(join(nodePath, "content"), { title: asset.title, prompt: text, category: "text-stack" });
    const relativeFile = portableRelativePath(nodePath, saved.promptPath);
    selectedStackItemId ??= textStackItemId(relativeFile);
    selectedText ||= text;
  }
  if (!selectedStackItemId) throw new Error("Folder text assets did not contain readable text.");

  const manifest: TextNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "text",
    title,
    text: selectedText,
    stackPath: "content",
    selectedStackItemId,
    color: "mint",
    createdAt: now,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), manifest);
  await addTypedStackCanvasNode(libraryPath, id, "text", nodeRelativePath, input, defaultNodeWidth, 180);
  return readLibrarySnapshot(libraryPath);
}

async function addTypedStackCanvasNode(
  libraryPath: string,
  id: string,
  type: "image" | "text" | "video",
  nodeRelativePath: string,
  input: ImportLocalFolderStackInput,
  fallbackWidth: number,
  fallbackHeight: number
): Promise<void> {
  const canvas = await ensureCanvas(libraryPath);
  const width = input.width ?? fallbackWidth;
  const height = input.height ?? fallbackHeight;
  canvas.nodes.push({
    id,
    type,
    nodePath: nodeRelativePath,
    x: Math.round(input.dropX - width / 2),
    y: Math.round(input.dropY - height / 2),
    width,
    height
  });
  await writeCanvas(libraryPath, canvas);
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

export async function deleteLocalLibraryAsset(nodeId: string, assetId: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest } = await readLibraryNode(nodeId);
  const scan = await scanLocalLibrary(manifest.sourcePath);
  const asset = scan.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`Library asset "${assetId}" was not found.`);

  const root = resolve(scan.sourcePath);
  const assetPath = resolvePortablePath(root, asset.relativePath);
  if (!isWithinDirectory(root, assetPath)) throw new Error("Library asset path is outside the source folder.");
  await rm(assetPath, { force: true });

  const previewImage = asset.embeddedPrompt?.previewImage;
  if (previewImage && !/^https?:\/\//i.test(previewImage)) {
    const previewPath = resolve(dirname(assetPath), previewImage);
    if (previewPath !== assetPath && isWithinDirectory(root, previewPath)) await rm(previewPath, { force: true });
  }

  return readLibrarySnapshot(libraryPath);
}

export async function appendImageToNodeStack(input: AppendImageStackInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readImageNode(input.nodeId);
  const extension = normalizedImageExtension(input.filename);
  const mimeType = mimeTypeFromExtension(extension);
  const contentPath = join(nodePath, "content");
  const stackIndex = manifest.stack.length;
  const imageRelativePath = nextStackFilename(manifest.stack, "import", extension);
  const imagePath = resolvePortablePath(nodePath, imageRelativePath);
  await mkdir(contentPath, { recursive: true });

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
    crop: input.crop ?? manifest.crop,
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
  await mkdir(join(nodePath, "content"), { recursive: true });

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

export async function appendTextToNodeStack(nodeId: string, text: string, title?: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readTextNode(nodeId);
  const body = text.trim();
  if (!body) throw new Error("Text is required.");
  const stackDirectory = textNodeStackDirectory(nodePath, manifest);
  await mkdir(stackDirectory, { recursive: true });
  const safeTitle = cleanTextTitle(title) || firstTextLine(body) || "Saved text";
  const saved = await createTextPromptAsset(stackDirectory, { title: safeTitle, prompt: body, category: "text-stack" });
  const relativeFile = portableRelativePath(nodePath, saved.promptPath);
  const selectedStackItemId = textStackItemId(relativeFile);
  await writeJson(join(nodePath, "snark.node.json"), {
    ...manifest,
    stackPath: manifest.stackPath ?? "content",
    selectedStackItemId,
    updatedAt: new Date().toISOString()
  });
  return readLibrarySnapshot(libraryPath);
}

export async function setTextNodeActiveStackItem(nodeId: string, selectedStackItemId: string | null): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readTextNode(nodeId);
  if (selectedStackItemId) {
    const stack = await readTextNodeStack(nodePath, manifest);
    if (!stack.some((item) => item.id === selectedStackItemId)) throw new Error(`Text stack item "${selectedStackItemId}" was not found.`);
  }
  await writeJson(join(nodePath, "snark.node.json"), {
    ...manifest,
    selectedStackItemId: selectedStackItemId || undefined,
    updatedAt: new Date().toISOString()
  });
  return readLibrarySnapshot(libraryPath);
}

export async function deleteTextNodeStackItem(nodeId: string, stackItemId: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readTextNode(nodeId);
  const stack = await readTextNodeStack(nodePath, manifest);
  const item = stack.find((entry) => entry.id === stackItemId);
  if (!item) throw new Error(`Text stack item "${stackItemId}" was not found.`);
  await rm(resolvePortablePath(nodePath, item.file), { force: true });
  const nextStack = stack.filter((entry) => entry.id !== stackItemId);
  await writeJson(join(nodePath, "snark.node.json"), {
    ...manifest,
    selectedStackItemId: manifest.selectedStackItemId === stackItemId ? nextStack[0]?.id : manifest.selectedStackItemId,
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
  const providerId = executionProviderForInput(input);
  const runResult = await runImageModelForStackItem({
    nodeId: input.nodeId,
    modelId: input.modelId,
    executionProvider: providerId,
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
  const imageMetadata: SnarkImageMetadata = {
    schema: imageMetadataSchema,
    kind: "generated-image",
    id: `${input.nodeId}-${stackIndex}`,
    createdAt: new Date().toISOString(),
    source: { nodeId: input.nodeId, outputId: `stack-${stackIndex}` },
    generation: {
      providerId,
      modelId: input.modelId,
      providerMode: providerModeForExecutionProvider(providerId),
      fallbackAllowed: input.fallbackAllowed !== false,
      prompt: {
        text: prompt,
        template: promptTemplate
      },
      inputImages: imageMetadataInputs(promptTemplate, orderedInputs, generationInputs),
      parameters: generationSettings
    },
    library: {
      title: manifest.title || "Generated Image",
      category: "generated",
      status: "candidate",
      modelHints: [input.modelId]
    }
  };
  const storedImage = embedImageProvenance(imageBuffer, extension, imageMetadata);
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

export async function generateTextNodeStackItem(input: GenerateTextNodeInput): Promise<LibrarySnapshot> {
  const promptTemplate = input.prompt?.trim();
  if (!promptTemplate) throw new Error("Prompt is required.");
  const libraryPath = await ensureCurrentLibrary();
  const connectedInputs = await connectedCanvasInputs(libraryPath, input.nodeId);
  const orderedInputs = orderConnectedInputs(connectedInputs, input.inputNodeIds);
  const promptImageNodeIds = imageNodeIdsFromPromptTemplate(promptTemplate);
  const inputImages = orderedInputs.filter((entry) => entry.image).map((entry) => entry.image!);
  const images = limitImages(
    inputImages.filter((image, index, all) =>
      image.nodeId
      && promptImageNodeIds.has(image.nodeId)
      && all.findIndex((candidate) => candidate.path === image.path) === index
    ),
    positiveInteger(input.maxImageInputs)
  );
  const prompt = resolveInputTokens(promptTemplate, orderedInputs, images, input.imageReferenceSyntax);
  const runResult = await runTextModelForStackItem({
    nodeId: input.nodeId,
    modelId: input.modelId,
    executionProvider: executionProviderForInput(input),
    fallbackAllowed: input.fallbackAllowed,
    availableExecutionProviders: input.availableExecutionProviders,
    prompt,
    images
  });
  const generationResult = runResult.nodeResults.generate;
  if (runResult.status === "failed" || generationResult?.status === "failed") {
    throw new Error(generationResult?.error || "Text generation failed.");
  }
  const output = generationResult?.output;
  const text = output && typeof output === "object" && typeof (output as Record<string, unknown>).text === "string"
    ? String((output as Record<string, unknown>).text).trim()
    : "";
  if (!text) throw new Error(`Model "${input.modelId}" did not return text.`);
  const snapshot = await appendTextToNodeStack(input.nodeId, text, firstTextLine(text) || "Generated text");
  const { manifest, nodePath } = await readTextNode(input.nodeId);
  await writeJson(join(nodePath, "snark.node.json"), {
    ...manifest,
    modelId: input.modelId,
    executionProvider: executionProviderForInput(input),
    fallbackAllowed: input.fallbackAllowed !== false,
    updatedAt: new Date().toISOString()
  });
  return readLibrarySnapshot(snapshot.path);
}

async function runImageModelForStackItem(input: { nodeId: string; modelId: string; executionProvider: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; prompt: string; images: GenerationImageInput[]; parameters: ImageGenerationSettings }) {
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

async function runTextModelForStackItem(input: { nodeId: string; modelId: string; executionProvider: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; prompt: string; images: GenerationImageInput[] }) {
  if (!["auto", "polza", "openrouter", "gemini"].includes(input.executionProvider)) {
    throw new Error(`Execution provider "${input.executionProvider}" is not available for text generation.`);
  }
  const autoOnlyPolza = input.executionProvider === "auto" && input.availableExecutionProviders?.length === 1 && input.availableExecutionProviders[0] === "polza";
  const directPolza = input.executionProvider === "polza" || autoOnlyPolza;
  const canFallbackFromPolza = input.executionProvider === "polza"
    && input.fallbackAllowed !== false
    && (input.availableExecutionProviders?.some((provider) => provider !== "polza") ?? true);
  const executor = await createRouteExecutor();
  const executeTextRoute = (nodeType: "ai.text" | "polza.text", executionProvider: string, providerMode: string) => executor.executeRoute({
      routeVersion: "0.1",
      route: { id: `snarkroute-text-generation-${input.nodeId}`, title: "SnarkRoute Text Generation", author: { name: "SnarkRoute" } },
      nodes: [{
        id: "generate",
        type: nodeType,
        params: {
          model: input.modelId,
          executionProvider,
          providerMode,
          fallbackAllowed: input.fallbackAllowed !== false,
          prompt: input.prompt,
          images: input.images
        }
      }],
      edges: []
    });

  if (!directPolza) {
    return executeTextRoute(
      "ai.text",
      input.executionProvider,
      input.executionProvider === "openrouter" ? "openrouter" : input.executionProvider === "gemini" ? "direct" : "auto"
    );
  }

  try {
    const directResult = await executeTextRoute("polza.text", input.executionProvider, "auto");
    if (!canFallbackFromPolza || !generationRunFailed(directResult)) return directResult;
  } catch (error) {
    if (!canFallbackFromPolza) throw error;
  }
  return executeTextRoute("ai.text", "auto", "auto");
}

function generationRunFailed(runResult: { status?: string; nodeResults?: Record<string, { status?: string } | undefined> }): boolean {
  return runResult.status === "failed" || runResult.nodeResults?.generate?.status === "failed";
}

async function runVideoModelForStackItem(input: { nodeId: string; modelId: string; executionProvider: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; prompt: string; images: GenerationImageInput[]; parameters: ImageGenerationSettings }) {
  if (input.executionProvider === "openrouter") return runOpenRouterVideoModelForStackItem(input);
  if (input.executionProvider !== "auto" && input.executionProvider !== "polza") throw new Error("Video generation is currently available through polza.ai or OpenRouter.");
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

async function runOpenRouterVideoModelForStackItem(input: { nodeId: string; modelId: string; prompt: string; images: GenerationImageInput[]; parameters: ImageGenerationSettings }): Promise<any> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OpenRouter is selected, but OpenRouter is not configured.");
  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/u, "");
  const createResponse = await fetch(`${baseUrl}/videos`, {
    method: "POST",
    headers: openRouterVideoHeaders(apiKey),
    body: JSON.stringify(await openRouterVideoRequestBody(input))
  });
  const created = await openRouterVideoJson(createResponse, "submit video generation request");
  const jobId = stringRecordValue(created, "id") ?? stringRecordValue(created, "generation_id");
  if (!jobId) throw new Error("OpenRouter video generation did not return a job id.");
  const completed = await pollOpenRouterVideoJob(baseUrl, apiKey, jobId);
  const videoUrl = Array.isArray(completed.unsigned_urls) ? completed.unsigned_urls.find((url): url is string => typeof url === "string" && url.trim().length > 0) : undefined;
  if (!videoUrl) throw new Error("OpenRouter video generation completed without a downloadable video URL.");
  return {
    status: "succeeded",
    logs: [{ nodeId: "generate", message: `Generated video with OpenRouter ${input.modelId}`, timestamp: new Date().toISOString() }],
    nodeResults: {
      generate: {
        status: "succeeded",
        output: {
          video: {
            path: videoUrl,
            localPath: videoUrl,
            filename: `${input.modelId.split("/").pop() || "openrouter-video"}.mp4`,
            mimeType: "video/mp4"
          },
          provider: "openrouter",
          model: input.modelId,
          providerModel: input.modelId,
          output: completed,
          status: "succeeded"
        }
      }
    }
  };
}

interface ConnectedCanvasInput {
  nodeId: string;
  type: string;
  text?: string;
  image?: GenerationImageInput;
}

interface GenerationImageInput {
  path: string;
  localPath?: string;
  mimeType: string;
  ref?: string;
  nodeId?: string;
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
      inputs.push({ nodeId: sourceNodeId, type: "image", image: item ? stackItemImageInput(libraryPath, nodePath, sourceNodeId, item) : undefined });
    }
    if (sourceNode?.type === "text") {
      const manifestPath = join(resolvePortablePath(libraryPath, sourceNode.nodePath), "snark.node.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TextNodeManifest;
      const stack = await readTextNodeStack(resolvePortablePath(libraryPath, sourceNode.nodePath), manifest);
      const selected = stack.find((item) => item.id === manifest.selectedStackItemId);
      inputs.push({ nodeId: sourceNodeId, type: "text", text: selected?.text ?? manifest.text });
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
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, sourceManifest.title || "Image");
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const contentPath = join(nodePath, "content");
  const extension = extname(sourceItem.file ?? sourceItem.externalUrl ?? "").toLowerCase() || ".png";
  const imageRelativePath = portableJoin("content", `000-import${extension}`);
  await mkdir(contentPath, { recursive: true });
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
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, sourceManifest.title || "Video");
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const extension = extname(sourceItem.file).toLowerCase() || ".mp4";
  const videoRelativePath = portableJoin("content", `000-import${extension}`);
  await mkdir(join(nodePath, "content"), { recursive: true });
  await copyFile(resolvePortablePath(sourceNodePath, sourceItem.file), resolvePortablePath(nodePath, videoRelativePath));

  const manifest: VideoNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "video",
    title,
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

export async function duplicateStackItemAsTextNode(input: DuplicateStackItemInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest: sourceManifest, nodePath: sourceNodePath } = await readTextNode(input.nodeId);
  const sourceItem = (await readTextNodeStack(sourceNodePath, sourceManifest)).find((item) => item.id === input.stackItemId);
  if (!sourceItem) throw new Error(`Text stack item "${input.stackItemId}" was not found.`);

  const now = new Date().toISOString();
  const id = `text_${shortId()}`;
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, sourceItem.title || "Text");
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const copiedFile = portableJoin("content", basename(sourceItem.file));
  await mkdir(join(nodePath, "content"), { recursive: true });
  await copyFile(resolvePortablePath(sourceNodePath, sourceItem.file), resolvePortablePath(nodePath, copiedFile));
  const manifest: TextNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "text",
    title,
    text: "",
    stackPath: "content",
    selectedStackItemId: textStackItemId(copiedFile),
    color: sourceManifest.color ?? "mint",
    createdAt: now,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), manifest);

  const canvas = await ensureCanvas(libraryPath);
  const sourceCanvasNode = canvas.nodes.find((candidate) => candidate.id === input.nodeId && candidate.type === "text");
  const width = sourceCanvasNode?.width ?? input.width ?? defaultNodeWidth;
  const height = sourceCanvasNode?.height ?? defaultNodeHeight;
  canvas.nodes.push({
    id,
    type: "text",
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

export async function importLocalFolderStackAsNode(input: ImportLocalFolderStackInput): Promise<LibrarySnapshot> {
  const scan = await scanLocalLibrary(input.sourcePath);
  if (input.stackKind === "image") return importImageAssetsAsStackNode(scan, input);
  if (input.stackKind === "video") return importVideoAssetsAsStackNode(scan, input);
  return importTextAssetsAsStackNode(scan, input);
}

export async function createEmptyCanvasNode(input: CreateNodeInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const now = new Date().toISOString();
  const id = `${input.type}_${shortId()}`;
  const width = input.width ?? defaultNodeWidth;
  const height = input.height ?? defaultNodeHeight;
  const defaultTitle = input.type === "image" ? "Image" : input.type === "video" ? "Video" : "Text";
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, defaultTitle);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  await mkdir(nodePath, { recursive: true });

  if (input.type === "image") {
    const manifest: ImageNodeManifest = {
      format: "snarkroute.node",
      version: "0.1",
      id,
      type: "image",
      title,
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
      title,
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
      title,
      text: "",
      stackPath: "content",
      color: "mint",
      createdAt: now,
      updatedAt: now
    };
    await writeJson(join(nodePath, "snark.node.json"), manifest);
    await mkdir(join(nodePath, "content"), { recursive: true });
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
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, `${manifest.title || manifest.type} copy`);
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

export async function duplicateCanvasNodeAsRepresentation(input: DuplicateCanvasNodeAsRepresentationInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const sourceCanvasNode = canvas.nodes.find((node) => node.id === input.nodeId);
  if (!sourceCanvasNode) throw new Error(`Node "${input.nodeId}" was not found.`);

  const sourcePath = resolvePortablePath(libraryPath, sourceCanvasNode.nodePath);
  const sourceManifest = JSON.parse(await readFile(join(sourcePath, "snark.node.json"), "utf8")) as ImageNodeManifest | VideoNodeManifest | TextNodeManifest | LibraryNodeManifest;
  const now = new Date().toISOString();
  const id = `${input.type}_${shortId()}`;
  const targetLabel = input.type === "image" ? "Image" : input.type === "video" ? "Video" : "Text";
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, `${sourceManifest.title || sourceManifest.type} ${targetLabel}`);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  await cp(sourcePath, nodePath, { recursive: true });

  const promptText = sourceManifest.type === "image" || sourceManifest.type === "video" ? await readCurrentPrompt(sourcePath) : sourcePromptText(sourceManifest);
  await writeJson(join(nodePath, "snark.node.json"), representationManifestFromSource(sourceManifest, input.type, id, title, now, promptText));
  if (input.type === "image" || input.type === "video") await writeCurrentPrompt(nodePath, promptText);

  const width = input.width ?? (input.type === "text" ? defaultNodeWidth : sourceCanvasNode.width);
  const height = input.height ?? (input.type === "text" ? 180 : sourceCanvasNode.height);
  canvas.nodes.push({
    id,
    type: input.type,
    nodePath: nodeRelativePath,
    x: Math.round(input.x),
    y: Math.round(input.y),
    width,
    height
  });
  const sourceId = input.connectFromNodeId ?? input.nodeId;
  if (sourceId) canvas.edges = [...(canvas.edges ?? []), { id: `edge_${shortId()}`, fromNodeId: sourceId, toNodeId: id, kind: "representation" }];
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function syncRepresentationEdge(edgeId: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const edge = (canvas.edges ?? []).find((candidate) => candidate.id === edgeId);
  if (!edge) throw new Error(`Edge "${edgeId}" was not found.`);
  if (edge.kind !== "representation") throw new Error(`Edge "${edgeId}" is not a representation link.`);
  const sourceNode = canvas.nodes.find((node) => node.id === edge.fromNodeId);
  const targetNode = canvas.nodes.find((node) => node.id === edge.toNodeId);
  if (!sourceNode || !targetNode) throw new Error("Representation source or target node was not found.");

  const sourcePath = resolvePortablePath(libraryPath, sourceNode.nodePath);
  const targetPath = resolvePortablePath(libraryPath, targetNode.nodePath);
  await copyMissingNodeContent(sourcePath, targetPath);

  const manifestPath = join(targetPath, "snark.node.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest | VideoNodeManifest | TextNodeManifest | LibraryNodeManifest;
  await writeJson(manifestPath, { ...manifest, updatedAt: new Date().toISOString() });
  return readLibrarySnapshot(libraryPath);
}

export async function updateTextNode(nodeId: string, updates: { text?: string; color?: string; modelId?: string; executionProvider?: string; fallbackAllowed?: boolean }): Promise<LibrarySnapshot> {
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
    modelId: updates.modelId ?? manifest.modelId,
    executionProvider: updates.executionProvider ?? manifest.executionProvider,
    fallbackAllowed: updates.fallbackAllowed ?? manifest.fallbackAllowed,
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
  const currentPath = resolvePortablePath(libraryPath, canvasNode.nodePath);
  const manifestPath = join(currentPath, "snark.node.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest | VideoNodeManifest | TextNodeManifest | LibraryNodeManifest;
  const location = await allocateCanvasNodeLocation(libraryPath, title.trim() || manifest.title, canvasNode.nodePath);
  const nextPath = resolvePortablePath(libraryPath, location.nodeRelativePath);
  if (nextPath !== currentPath) await rename(currentPath, nextPath);
  canvasNode.nodePath = location.nodeRelativePath;
  await writeJson(join(nextPath, "snark.node.json"), { ...manifest, title: location.title, updatedAt: new Date().toISOString() });
  await writeCanvas(libraryPath, canvas);
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
  const contentPath = join(resolvePortablePath(libraryPath, canvasNode.nodePath), "content");
  await mkdir(contentPath, { recursive: true });
  return contentPath;
}

export async function readImageNode(nodeId: string): Promise<{ manifest: ImageNodeManifest; nodePath: string }> {
  const { manifest, nodePath } = await readTypedCanvasNode(nodeId, "image");
  const stackManifest = await syncMediaStackWithContent(nodePath, manifest);
  return { manifest: { ...stackManifest, currentPrompt: await readCurrentPrompt(nodePath) }, nodePath };
}

export async function readVideoNode(nodeId: string): Promise<{ manifest: VideoNodeManifest; nodePath: string }> {
  const { manifest, nodePath } = await readTypedCanvasNode(nodeId, "video");
  const stackManifest = await syncMediaStackWithContent(nodePath, manifest);
  return { manifest: { ...stackManifest, currentPrompt: await readCurrentPrompt(nodePath) }, nodePath };
}

export async function readTextNode(nodeId: string): Promise<{ manifest: TextNodeManifest; nodePath: string }> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const canvasNode = canvas.nodes.find((node) => node.id === nodeId && node.type === "text");
  if (!canvasNode) throw new Error(`Text node "${nodeId}" was not found.`);
  const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
  const manifest = JSON.parse(await readFile(join(nodePath, "snark.node.json"), "utf8")) as TextNodeManifest;
  if (manifest.type !== "text") throw new Error(`Node "${nodeId}" is not a text node.`);
  return { manifest, nodePath };
}

export async function readLibraryNode(nodeId: string): Promise<{ manifest: LibraryNodeManifest; nodePath: string }> {
  return readTypedCanvasNode(nodeId, "library");
}

async function readTypedCanvasNode(nodeId: string, type: "image"): Promise<{ manifest: ImageNodeManifest; nodePath: string }>;
async function readTypedCanvasNode(nodeId: string, type: "video"): Promise<{ manifest: VideoNodeManifest; nodePath: string }>;
async function readTypedCanvasNode(nodeId: string, type: "library"): Promise<{ manifest: LibraryNodeManifest; nodePath: string }>;
async function readTypedCanvasNode(nodeId: string, type: "image" | "video" | "library"): Promise<{ manifest: ImageNodeManifest | VideoNodeManifest | LibraryNodeManifest; nodePath: string }> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const canvasNode = canvas.nodes.find((node) => node.id === nodeId);
  if (!canvasNode) throw new Error(`${type} node "${nodeId}" was not found.`);
  const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
  const manifestPath = join(nodePath, "snark.node.json");
  if (!await fileExists(manifestPath)) throw new Error(`${type} node "${nodeId}" was not found.`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest | VideoNodeManifest | LibraryNodeManifest;
  if (manifest.type !== type) throw new Error(`Node "${nodeId}" is not a ${type} node.`);
  return { manifest, nodePath };
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

async function ensureProjectLibrary(projectPath: string): Promise<void> {
  await mkdir(projectPath, { recursive: true });
  await ensureLibraryManifest(projectPath, {
    title: basename(projectPath) || "SnarkRoute Project",
    libraryKind: "workspace",
    contentKind: "mixed",
    defaultView: "canvas"
  });
  await ensureCanvas(projectPath);
}

async function projectSummary(projectPath: string, current: boolean, coverPath?: string): Promise<LibraryProjectSummary> {
  let id = projectIdFromPath(projectPath);
  let title = basename(projectPath) || "SnarkRoute Project";
  try {
    const manifest = await readLibraryManifest(projectPath);
    id = manifest.id || id;
    title = basename(projectPath) || manifest.title || title;
  } catch {
  }
  const cover = await findProjectCover(projectPath, coverPath).catch(() => null);
  return {
    id,
    title,
    path: projectPath,
    coverUrl: cover ? `/api/libraries/projects/${encodeURIComponent(id)}/cover` : null,
    current
  };
}

async function saveProjectPath(projectPath: string): Promise<void> {
  const registry = await readProjectRegistry();
  const normalized = resolve(projectPath);
  const existing = registry.projects.find((project) => resolve(project.path) === normalized);
  registry.projects = [
    { path: normalized, addedAt: existing?.addedAt ?? new Date().toISOString(), coverPath: existing?.coverPath },
    ...registry.projects.filter((project) => resolve(project.path) !== normalized)
  ];
  await writeProjectRegistry(registry);
}

async function readProjectRegistry(): Promise<LibraryProjectRegistry> {
  const path = join(librariesDirectory, projectRegistryFilename);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LibraryProjectRegistry>;
    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    return {
      version: 1,
      projects: projects
        .filter((project): project is LibraryProjectRegistryEntry => typeof project?.path === "string")
        .map((project) => ({
          path: resolve(project.path),
          addedAt: typeof project.addedAt === "string" ? project.addedAt : new Date().toISOString(),
          coverPath: typeof project.coverPath === "string" ? resolve(project.coverPath) : undefined
        }))
    };
  } catch {
    return { version: 1, projects: [] };
  }
}

async function writeProjectRegistry(registry: LibraryProjectRegistry): Promise<void> {
  await mkdir(librariesDirectory, { recursive: true });
  const paths = uniquePaths(registry.projects.map((project) => project.path));
  await writeJson(join(librariesDirectory, projectRegistryFilename), {
    version: 1,
    projects: paths.map((path) => ({
      path,
      addedAt: registry.projects.find((project) => resolve(project.path) === path)?.addedAt ?? new Date().toISOString(),
      coverPath: registry.projects.find((project) => resolve(project.path) === path)?.coverPath
    }))
  });
}

async function listProjectRecords(activePath = currentLibraryPath): Promise<LibraryProjectRegistryEntry[]> {
  const registry = await readProjectRegistry();
  const activeResolved = resolve(activePath);
  const activeEntry = registry.projects.find((project) => resolve(project.path) === activeResolved);
  const records = [
    { path: activeResolved, addedAt: activeEntry?.addedAt ?? new Date().toISOString(), coverPath: activeEntry?.coverPath },
    ...registry.projects.filter((project) => resolve(project.path) !== activeResolved)
  ];
  return uniquePaths(records.map((record) => record.path)).map((path) => records.find((record) => resolve(record.path) === path) ?? { path, addedAt: new Date().toISOString() });
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const normalized = resolve(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function projectIdFromPath(path: string): string {
  return `project_${Buffer.from(resolve(path), "utf8").toString("base64url")}`;
}

async function projectRecordById(projectId: string): Promise<LibraryProjectRegistryEntry | null> {
  for (const record of await listProjectRecords(await ensureCurrentLibrary())) {
    if (await projectIdForPath(record.path) === projectId) return record;
  }
  return null;
}

async function projectIdForPath(path: string): Promise<string> {
  try {
    const manifest = await readLibraryManifest(path);
    return manifest.id || projectIdFromPath(path);
  } catch {
    return projectIdFromPath(path);
  }
}

async function findProjectCover(libraryPath: string, preferredPath?: string): Promise<{ path: string; mimeType: string } | null> {
  if (preferredPath) {
    const resolvedPreferred = resolve(preferredPath);
    if (isWithinDirectory(libraryPath, resolvedPreferred) && await fileExists(resolvedPreferred)) {
      const extension = extname(resolvedPreferred).toLowerCase();
      if (isProjectImageExtension(extension)) return { path: resolvedPreferred, mimeType: localLibraryMimeType(extension) };
    }
  }
  try {
    const manifest = await readLibraryManifest(libraryPath);
    const canvas = await readCanvas(libraryPath, manifest);
    for (const canvasNode of canvas?.nodes ?? []) {
      if (canvasNode.type !== "image") continue;
      const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
      const manifestPath = join(nodePath, "snark.node.json");
      if (!await fileExists(manifestPath)) continue;
      const nodeManifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest;
      if (nodeManifest.type !== "image") continue;
      const item = nodeManifest.stack.find((entry) => entry.file);
      if (!item?.file) continue;
      const imagePath = resolvePortablePath(nodePath, item.file);
      if (await fileExists(imagePath)) return { path: imagePath, mimeType: item.mimeType };
    }
  } catch {
  }
  return (await findProjectImages(libraryPath))[0] ?? null;
}

async function findProjectImages(libraryPath: string): Promise<Array<{ path: string; mimeType: string }>> {
  const files = await listLocalLibraryFiles(libraryPath).catch(() => []);
  return files
    .filter((path) => isProjectImageExtension(extname(path).toLowerCase()) && isWithinDirectory(libraryPath, path))
    .map((path) => ({ path, mimeType: localLibraryMimeType(extname(path).toLowerCase()) }));
}

function isProjectImageExtension(extension: string): boolean {
  return extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".webp" || extension === ".gif";
}

function projectImageId(path: string): string {
  return Buffer.from(resolve(path), "utf8").toString("base64url");
}

async function ensureCurrentLibrary(): Promise<string> {
  const envPath = process.env.SNARKROUTE_LIBRARY_PATH ? resolve(process.env.SNARKROUTE_LIBRARY_PATH) : "";
  if (envPath) {
    if (envPath !== currentLibraryPath) currentLibraryPath = envPath;
  } else if (!currentLibraryInitialized) {
    const lastProjectPath = (await readProjectRegistry()).projects[0]?.path;
    if (lastProjectPath) currentLibraryPath = resolve(lastProjectPath);
  }
  currentLibraryInitialized = true;
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
      const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
      const hydratedManifest = { ...await syncMediaStackWithContent(nodePath, manifest), currentPrompt: await readCurrentPrompt(nodePath) };
      const activeStackItem = hydratedManifest.stack[hydratedManifest.activeStackIndex] ?? null;
      nodes.push({
        canvas: canvasNode,
        manifest: hydratedManifest,
        activeStackItem,
        previewUrl: activeStackItem ? `/api/libraries/current/image-nodes/${encodeURIComponent(hydratedManifest.id)}/stack/${encodeURIComponent(activeStackItem.id)}` : null
      });
    }
    if (manifest.type === "video") {
      const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
      const hydratedManifest = { ...await syncMediaStackWithContent(nodePath, manifest), currentPrompt: await readCurrentPrompt(nodePath) };
      const activeStackItem = hydratedManifest.stack[hydratedManifest.activeStackIndex] ?? null;
      nodes.push({
        canvas: canvasNode,
        manifest: hydratedManifest,
        activeStackItem,
        previewUrl: activeStackItem ? `/api/libraries/current/video-nodes/${encodeURIComponent(hydratedManifest.id)}/stack/${encodeURIComponent(activeStackItem.id)}` : null
      });
    }
    if (manifest.type === "text") {
      const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
      const stack = await readTextNodeStack(nodePath, manifest);
      const activeStackItem = stack.find((item) => item.id === manifest.selectedStackItemId) ?? null;
      nodes.push({
        canvas: canvasNode,
        manifest: { ...manifest, stackPath: manifest.stackPath ?? "content", selectedStackItemId: activeStackItem?.id },
        stack,
        activeStackItem,
        outputText: activeStackItem?.text ?? manifest.text,
        previewUrl: activeStackItem?.previewFile ? `/api/libraries/current/text-nodes/${encodeURIComponent(manifest.id)}/stack/${encodeURIComponent(activeStackItem.id)}/preview` : null
      });
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

function isWithinDirectory(root: string, path: string): boolean {
  const rootResolved = resolve(root);
  const rel = relative(rootResolved, resolve(path));
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel));
}

function portableJoin(...parts: string[]): string {
  return parts.join("/");
}

async function allocateCanvasNodeLocation(libraryPath: string, requestedTitle: string, currentRelativePath?: string): Promise<{ title: string; nodeRelativePath: string }> {
  const baseTitle = requestedTitle.trim() || "Node";
  for (let index = 1; index < 10000; index += 1) {
    const title = index === 1 ? baseTitle : `${baseTitle} (${index})`;
    const nodeRelativePath = portableJoin("nodes", `${nodeFolderName(title)}.node`);
    if (nodeRelativePath === currentRelativePath || !await pathExists(resolvePortablePath(libraryPath, nodeRelativePath))) {
      return { title, nodeRelativePath };
    }
  }
  throw new Error(`Could not allocate a folder for node "${baseTitle}".`);
}

function nodeFolderName(title: string): string {
  const sanitized = sanitizeFilename(title).replace(/[. ]+$/u, "").trim() || "Node";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(sanitized) ? `_${sanitized}` : sanitized;
}

function nextStackFilename(stack: ImageStackItem[], label: string, extension: string): string {
  const used = new Set(stack.map((item) => item.file));
  for (let index = 0; index < 10000; index += 1) {
    const candidate = portableJoin("content", `${String(index).padStart(3, "0")}-${label}${extension}`);
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

export async function createTextStackPreviewReadStream(nodeId: string, stackItemId: string): Promise<{ stream: ReturnType<typeof createReadStream>; mimeType: string }> {
  const { manifest, nodePath } = await readTextNode(nodeId);
  const item = (await readTextNodeStack(nodePath, manifest)).find((candidate) => candidate.id === stackItemId);
  if (!item?.previewFile) throw new Error(`Text stack preview "${stackItemId}" was not found.`);
  return { stream: createReadStream(resolvePortablePath(nodePath, item.previewFile)), mimeType: "image/png" };
}

async function readTextNodeStack(nodePath: string, manifest: TextNodeManifest): Promise<TextStackItem[]> {
  const directory = textNodeStackDirectory(nodePath, manifest);
  await mkdir(directory, { recursive: true });
  const promptLibrary = await loadPromptLibrary(directory);
  const promptItems: TextStackItem[] = promptLibrary.categories.flatMap((category) => category.prompts).map((prompt) => {
    const file = portableRelativePath(nodePath, prompt.path);
    const previewFile = prompt.path.toLowerCase().endsWith(".prompt.png")
      ? file
      : prompt.previewImage ? portableRelativePath(nodePath, resolve(dirname(prompt.path), prompt.previewImage)) : undefined;
    return {
      id: textStackItemId(file),
      file,
      title: prompt.title,
      text: prompt.text,
      source: "prompt",
      mimeType: prompt.path.toLowerCase().endsWith(".prompt.png") ? "image/png" : "text/markdown",
      previewFile
    };
  });
  const promptPaths = new Set(promptItems.map((item) => resolvePortablePath(nodePath, item.file)));
  const embeddedImageItems: TextStackItem[] = [];
  const textItems: TextStackItem[] = [];
  for (const path of await listLocalLibraryFiles(directory)) {
    const extension = extname(path).toLowerCase();
    if (extension === ".png" && !promptPaths.has(resolve(path))) {
      const parsed = parsePromptPngFile(await readFile(path), path);
      if ("prompt" in parsed) {
        const file = portableRelativePath(nodePath, path);
        embeddedImageItems.push({
          id: textStackItemId(file),
          file,
          title: parsed.prompt.title,
          text: parsed.prompt.text,
          source: "prompt",
          mimeType: "image/png",
          previewFile: file
        });
      }
      continue;
    }
    if ((extension !== ".txt" && extension !== ".md") || promptPaths.has(resolve(path)) || path.toLowerCase().endsWith(".prompt.md")) continue;
    const text = (await readFile(path, "utf8")).trim();
    if (!text) continue;
    const file = portableRelativePath(nodePath, path);
    textItems.push({
      id: textStackItemId(file),
      file,
      title: titleFromFilename(basename(path)),
      text,
      source: "text",
      mimeType: extension === ".md" ? "text/markdown" : "text/plain"
    });
  }
  const items = [...promptItems, ...embeddedImageItems, ...textItems];
  const datedItems = await Promise.all(items.map(async (item) => {
    const details = await stat(resolvePortablePath(nodePath, item.file));
    return { item, createdAt: details.birthtimeMs || details.mtimeMs };
  }));
  return datedItems.sort((left, right) => left.createdAt - right.createdAt || left.item.title.localeCompare(right.item.title)).map((entry) => entry.item);
}

async function syncMediaStackWithContent(nodePath: string, manifest: ImageNodeManifest): Promise<ImageNodeManifest>;
async function syncMediaStackWithContent(nodePath: string, manifest: VideoNodeManifest): Promise<VideoNodeManifest>;
async function syncMediaStackWithContent(nodePath: string, manifest: ImageNodeManifest | VideoNodeManifest): Promise<ImageNodeManifest | VideoNodeManifest> {
  const contentPath = join(nodePath, "content");
  const entries = await readdir(contentPath, { withFileTypes: true }).catch(() => []);
  const existingFiles = new Set(manifest.stack.flatMap((item) => item.file ? [item.file.toLowerCase()] : []));
  const newFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((file) => {
      const extension = extname(file).toLowerCase();
      return manifest.type === "image"
        ? extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".webp"
        : extension === ".mp4" || extension === ".webm" || extension === ".mov";
    })
    .filter((file) => !existingFiles.has(portableJoin("content", file).toLowerCase()));
  if (!newFiles.length) return manifest;
  const sortedFiles = await Promise.all(newFiles.map(async (file) => ({ file, details: await stat(join(contentPath, file)) })));
  sortedFiles.sort((left, right) => (left.details.birthtimeMs || left.details.mtimeMs) - (right.details.birthtimeMs || right.details.mtimeMs));
  const now = new Date().toISOString();
  const items: ImageStackItem[] = [];
  for (const entry of sortedFiles) {
    const extension = extname(entry.file).toLowerCase();
    const file = portableJoin("content", entry.file);
    if (manifest.type === "image") {
      const dimensions = readImageDimensions(await readFile(resolvePortablePath(nodePath, file)), extension);
      items.push({ id: `stack_${shortId()}`, file, source: "import", mimeType: mimeTypeFromExtension(extension), width: dimensions.width, height: dimensions.height, createdAt: now });
    } else {
      items.push({ id: `stack_${shortId()}`, file, source: "import", mimeType: videoMimeTypeFromExtension(extension), width: defaultNodeWidth, height: defaultNodeHeight, createdAt: now });
    }
  }
  const updated = { ...manifest, stack: [...manifest.stack, ...items], updatedAt: now };
  await writeJson(join(nodePath, "snark.node.json"), updated);
  return updated;
}

function textNodeStackDirectory(nodePath: string, manifest: TextNodeManifest): string {
  return resolvePortablePath(nodePath, manifest.stackPath ?? "content");
}

function portableRelativePath(root: string, path: string): string {
  const relativePath = relative(resolve(root), resolve(path)).split(sep).join("/");
  resolvePortablePath(root, relativePath);
  return relativePath;
}

function libraryAssetRef(relativePath: string): string {
  return `library://default/${relativePath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

function textStackItemId(file: string): string {
  return `text_${Buffer.from(file, "utf8").toString("base64url")}`;
}

function representationManifestFromSource(
  source: ImageNodeManifest | VideoNodeManifest | TextNodeManifest | LibraryNodeManifest,
  type: "image" | "video" | "text",
  id: string,
  title: string,
  now: string,
  promptText = ""
): ImageNodeManifest | VideoNodeManifest | TextNodeManifest {
  if (type === "text") {
    return {
      format: "snarkroute.node",
      version: "0.1",
      id,
      type,
      title,
      text: sourcePromptText(source, promptText),
      stackPath: "content",
      color: source.type === "text" ? source.color ?? "mint" : "mint",
      createdAt: now,
      updatedAt: now
    };
  }
  return {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type,
    title,
    stack: source.type === type ? structuredClone(source.stack) : [],
    activeStackIndex: source.type === type ? source.activeStackIndex : 0,
    createdAt: now,
    updatedAt: now
  };
}

function sourcePromptText(source: ImageNodeManifest | VideoNodeManifest | TextNodeManifest | LibraryNodeManifest, promptText = ""): string {
  if (source.type === "text") return source.text ?? "";
  if (source.type === "library") return source.sourcePath ?? "";
  return promptText;
}

async function copyMissingNodeContent(sourceNodePath: string, targetNodePath: string): Promise<void> {
  const sourceContent = join(sourceNodePath, "content");
  const targetContent = join(targetNodePath, "content");
  const entries = await readdir(sourceContent, { withFileTypes: true }).catch(() => []);
  if (!entries.length) return;
  await mkdir(targetContent, { recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const sourceFile = join(sourceContent, entry.name);
    const targetFile = join(targetContent, entry.name);
    if (await pathExists(targetFile)) continue;
    await copyFile(sourceFile, targetFile);
  }
}

function cleanTextTitle(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 96);
}

function firstTextLine(value: string): string {
  return cleanTextTitle(value.split(/\r?\n/u)[0]);
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
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

function stackItemImageInput(libraryPath: string, nodePath: string, nodeId: string, item: ImageStackItem): GenerationImageInput {
  if (item.externalUrl) return { path: item.externalUrl, ref: item.externalUrl, nodeId, mimeType: item.mimeType };
  if (!item.file) throw new Error(`Stack item "${item.id}" does not contain an image source.`);
  const path = resolvePortablePath(nodePath, item.file);
  return { path, localPath: path, ref: libraryAssetRef(portableRelativePath(libraryPath, path)), nodeId, mimeType: item.mimeType };
}

async function readGeneratedImageBuffer(path: string): Promise<Buffer> {
  if (!isRemoteUrl(path)) return readFile(path);
  const response = await fetchWithTimeout(path, 15000).catch((error) => {
    throw new Error(`Could not save generated image in its content folder: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!response.ok) throw new Error(`Could not save generated image in its content folder: download failed (${response.status}).`);
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
  sentImages: GenerationImageInput[],
  imageReferenceSyntax: string | undefined
): string {
  const inputById = new Map(inputs.map((entry) => [entry.nodeId, entry]));
  return promptTemplate.replace(/\[\[(text|image|video):([^\]]+)\]\]/g, (_token, type: string, nodeId: string) => {
    const input = inputById.get(nodeId);
    if (!input || input.type !== type) return "";
    if (type === "text") return input.text ?? "";
    if (!input.image) return "";
    const position = sentImages.findIndex((image) => image.path === input.image?.path);
    const referenceSyntax = imageReferenceSyntax?.trim() || "@image {index}";
    return position >= 0 ? referenceSyntax.replaceAll("{index}", String(position + 1)) : "";
  });
}

function imageNodeIdsFromPromptTemplate(promptTemplate: string): Set<string> {
  return new Set([...promptTemplate.matchAll(/\[\[image:([^\]]+)\]\]/g)].map((match) => match[1]).filter(Boolean));
}

function imageMetadataInputs(promptTemplate: string, inputs: ConnectedCanvasInput[], sentImages: GenerationImageInput[]): SnarkImageMetadata["generation"]["inputImages"] {
  const imageRoles = imageRolesFromPromptTemplate(promptTemplate);
  return sentImages.map((image) => {
    const input = inputs.find((entry) => entry.image?.path === image.path);
    return {
      ref: image.ref ?? "",
      nodeId: image.nodeId ?? input?.nodeId,
      mimeType: image.mimeType,
      role: input?.nodeId ? imageRoles.get(input.nodeId) : undefined
    };
  }).filter((image) => Boolean(image.ref));
}

function imageRolesFromPromptTemplate(promptTemplate: string): Map<string, string> {
  const roles = new Map<string, string>();
  const tokenPattern = /\[\[image:([^\]]+)\]\]/g;
  const matches = [...promptTemplate.matchAll(tokenPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const nodeId = match[1];
    const afterToken = match.index === undefined ? "" : promptTemplate.slice(match.index + match[0].length, matches[index + 1]?.index);
    const role = cleanImageRole(afterToken);
    if (role) roles.set(nodeId, role);
  }
  return roles;
}

function cleanImageRole(value: string): string | undefined {
  const firstLine = value.split(/\r?\n/)[0] ?? "";
  const role = firstLine.replace(/^[\s:;,\-.–—]+/u, "").replace(/\s+/g, " ").trim().replace(/[.;,:\s]+$/u, "");
  return role || undefined;
}

function imageGenerationParameters(
  modelId: string,
  executionProvider: string,
  fallbackAllowed: boolean | undefined,
  prompt: string,
  images: GenerationImageInput[],
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

async function openRouterVideoRequestBody(input: { modelId: string; prompt: string; images: GenerationImageInput[]; parameters: ImageGenerationSettings }): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: input.modelId,
    prompt: input.prompt
  };
  if (input.parameters.aspectRatio !== undefined) body.aspect_ratio = input.parameters.aspectRatio;
  if (input.parameters.resolution !== undefined) body.resolution = input.parameters.resolution;
  if (input.parameters.duration !== undefined) body.duration = Number(input.parameters.duration) || input.parameters.duration;
  if (input.parameters.generate_audio !== undefined) body.generate_audio = input.parameters.generate_audio;
  if (input.parameters.seed !== undefined) body.seed = Number(input.parameters.seed) || input.parameters.seed;
  const frameImages = await Promise.all(input.images.slice(0, 2).map(async (image, index) => ({
    frame_type: index === 0 ? "first_frame" : "last_frame",
    image_url: await imageInputAsOpenRouterUrl(image)
  })));
  if (frameImages.length > 0) body.frame_images = frameImages;
  return body;
}

async function imageInputAsOpenRouterUrl(image: GenerationImageInput): Promise<string> {
  const path = image.localPath ?? image.path;
  if (isRemoteUrl(path)) return path;
  const mimeType = image.mimeType ?? mimeTypeFromExtension(extname(path).toLowerCase());
  const buffer = await readFile(path);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function openRouterVideoHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  if (process.env.SNARKROUTE_SITE_URL) headers["HTTP-Referer"] = process.env.SNARKROUTE_SITE_URL;
  headers["X-OpenRouter-Title"] = process.env.OPENROUTER_APP_TITLE ?? "SnarkRoute";
  return headers;
}

async function pollOpenRouterVideoJob(baseUrl: string, apiKey: string, jobId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await delay(3000);
    const response = await fetch(`${baseUrl}/videos/${encodeURIComponent(jobId)}`, { headers: openRouterVideoHeaders(apiKey) });
    const status = await openRouterVideoJson(response, "poll video generation status");
    const state = stringRecordValue(status, "status")?.toLowerCase();
    if (state === "completed" || state === "succeeded") return status;
    if (state === "failed" || state === "cancelled" || state === "canceled") throw new Error(stringRecordValue(status, "error") ?? `OpenRouter video generation ${state}.`);
  }
  throw new Error("OpenRouter video generation timed out.");
}

async function openRouterVideoJson(response: Response, action: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text };
  }
  if (!response.ok) {
    const errorValue = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).error : undefined;
    const error = typeof errorValue === "string" ? errorValue : errorValue && typeof errorValue === "object" ? stringRecordValue(errorValue as Record<string, unknown>, "message") : undefined;
    throw new Error(`Could not ${action}: ${error ?? (response.statusText || String(response.status))}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`Could not ${action}: invalid OpenRouter response.`);
  return parsed as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function stringRecordValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerModeForExecutionProvider(executionProvider: string): string {
  return executionProvider === "openrouter" ? "openrouter" : executionProvider === "gemini" ? "direct" : "auto";
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
