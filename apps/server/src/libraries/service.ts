import { createReadStream } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { ExecuteOptions, RunResult } from "@snarkroute/executor";
import type { OpenRoute } from "@snarkroute/protocol";
import { builtInNodeManifests, loadInstalledNodeManifests, loadPromptLibrary, parsePromptPngFile, writePngTextChunk, type PromptLibraryPrompt, type SnarkNodeManifest } from "@snarkroute/nodes";
import { librariesDirectory } from "../server-paths";
import { sanitizeFilename } from "../assets/service";
import { createRouteExecutor } from "../execution/service";
import { saveProviderUsageEventsForRunResult } from "../billing/provider-usage-events";
import { createTextPromptAsset } from "../prompt-library/service";
import { fetchWithTimeout } from "../services/http";
import { appMode } from "../services/env";
import { providerNodeManifests } from "../providers/provider-node-manifests";
import { loadCanvasActionManifests } from "../canvas-actions/service";
import { embedImageProvenance, imageMetadataSchema, type SnarkImageMetadata } from "./image-metadata";
import type {
  AppendImageStackInput,
  AppendAudioStackInput,
  AppendVideoStackInput,
  AppendTextNodeConversationMessageInput,
  CollectionNodeItem,
  CollectionNodeManifest,
  CollectionNodeStoredItem,
  CreateNodeInput,
  CropMetadata,
  DuplicateCanvasNodeAsRepresentationInput,
  DuplicateCanvasNodeInput,
  DuplicateStackItemInput,
  GenerateImageNodeInput,
  GenerateAudioNodeInput,
  GenerateTextNodeInput,
  GenerateVideoNodeInput,
  AudioNodeManifest,
  AudioNodeView,
  ImageGenerationSettings,
  ImageNodeManifest,
  ImageStackItem,
  ImportImageInput,
  ImportAudioInput,
  ImportLocalFolderStackInput,
  ImportLocalLibraryInput,
  ImportTextInput,
  ImportVideoInput,
  LibraryContentKind,
  LibraryDefaultView,
  LibraryKind,
  LibraryNodeManifest,
  LibraryProjectImageSummary,
  LibraryProjectRegistry,
  LibraryProjectRegistryEntry,
  LibraryProjectSummary,
  LibrarySnapshot,
  LibraryViewMode,
  LocalLibraryAsset,
  LocalLibraryManifest,
  LocalLibraryScanResult,
  NestedLibrary,
  NodeView,
  RunCanvasNodeActionInput,
  RunTextNodeConversationTurnInput,
  SnarkCanvasDocument,
  SnarkCanvasNode,
  SnarkLibraryManifest,
  TextNodeManifest,
  TextNodeConversation,
  TextNodeConversationMessage,
  TextNodeConversationPart,
  TextNodeConversationAttachmentInput,
  TextStackItem,
  UpdateMediaNodeRouteSettingsInput,
  VideoNodeManifest,
  VideoNodeView
} from "./types";

export type {
  AppendImageStackInput,
  AppendAudioStackInput,
  AppendVideoStackInput,
  AppendTextNodeConversationMessageInput,
  CollectionNodeItem,
  CollectionNodeManifest,
  CollectionNodeStoredItem,
  CreateNodeInput,
  CropMetadata,
  DuplicateCanvasNodeAsRepresentationInput,
  DuplicateCanvasNodeInput,
  DuplicateStackItemInput,
  GenerateImageNodeInput,
  GenerateAudioNodeInput,
  GenerateTextNodeInput,
  GenerateVideoNodeInput,
  ImageGenerationSettings,
  ImageNodeManifest,
  AudioNodeManifest,
  AudioNodeView,
  ImageStackItem,
  ImportImageInput,
  ImportAudioInput,
  ImportLocalFolderStackInput,
  ImportLocalLibraryInput,
  ImportTextInput,
  ImportVideoInput,
  LibraryContentKind,
  LibraryDefaultView,
  LibraryKind,
  LibraryNodeManifest,
  LibraryProjectImageSummary,
  LibraryProjectSummary,
  LibrarySnapshot,
  LibraryViewMode,
  LocalLibraryAsset,
  LocalLibraryManifest,
  LocalLibraryScanResult,
  NestedLibrary,
  NodeView,
  RunCanvasNodeActionInput,
  RunTextNodeConversationTurnInput,
  SnarkCanvasDocument,
  SnarkCanvasNode,
  SnarkLibraryManifest,
  TextNodeManifest,
  TextNodeConversation,
  TextNodeConversationMessage,
  TextNodeConversationPart,
  TextStackItem,
  UpdateMediaNodeRouteSettingsInput,
  VideoNodeManifest,
  VideoNodeView
} from "./types";

const manifestFilename = "snark.library.json";
const canvasFilename = "canvas.json";
const currentPromptFilename = "current-prompt.txt";
const conversationFilename = "conversation.json";
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
  const records = await listProjectRecords(activePath);
  const projects = await Promise.all(records.map((record) => projectSummary(record.path, record.path === activePath, record.coverPath)));
  return { projects };
}

export async function addLibraryProject(path: string): Promise<{ projects: LibraryProjectSummary[]; current: LibrarySnapshot }> {
  const projectPath = resolve(path);
  await ensureProjectLibrary(projectPath);
  await saveProjectPath(projectPath, { moveToTop: true, makeCurrent: true });
  currentLibraryPath = projectPath;
  return { projects: (await listLibraryProjects()).projects, current: await readLibrarySnapshot(projectPath) };
}

export async function openLibraryProject(path: string): Promise<{ projects: LibraryProjectSummary[]; current: LibrarySnapshot }> {
  const projectPath = resolve(path);
  await readLibraryManifest(projectPath);
  await saveProjectPath(projectPath, { moveToTop: false, makeCurrent: true });
  currentLibraryPath = projectPath;
  return { projects: (await listLibraryProjects()).projects, current: await readLibrarySnapshot(projectPath) };
}

export async function removeLibraryProject(path: string): Promise<{ projects: LibraryProjectSummary[]; current: LibrarySnapshot }> {
  const projectPath = resolve(path);
  const registry = await readProjectRegistry();
  registry.projects = registry.projects.filter((project) => resolve(project.path) !== projectPath);
  if (registry.currentProjectPath && resolve(registry.currentProjectPath) === projectPath) {
    registry.currentProjectPath = registry.projects[0]?.path ? resolve(registry.projects[0].path) : undefined;
  }
  await writeProjectRegistry(registry);
  if (resolve(currentLibraryPath) === projectPath) {
    currentLibraryPath = registry.currentProjectPath ? resolve(registry.currentProjectPath) : join(librariesDirectory, "default");
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
  if (canvas) await normalizeCollectionReferenceEdges(libraryPath, canvas);
  const nodes = canvas ? await readCanvasNodes(libraryPath, canvas) : [];
  return { manifest, path: libraryPath, nestedLibraries, canvas, nodes };
}

async function normalizeCollectionReferenceEdges(libraryPath: string, canvas: SnarkCanvasDocument): Promise<void> {
  const collectionIds = new Set(canvas.nodes.filter((node) => node.type === "collection").map((node) => node.id));
  let changed = false;
  canvas.edges = (canvas.edges ?? []).map((edge) => {
    if (!collectionIds.has(edge.fromNodeId) || edge.kind === "collectionItem") return edge;
    changed = true;
    return { ...edge, kind: "collectionItem" };
  });
  if (changed) await writeCanvas(libraryPath, canvas);
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
    canvas.edges = [...(canvas.edges ?? []), {
      id: `edge_${shortId()}`,
      fromNodeId: input.connectFromNodeId,
      toNodeId: id,
      kind: input.crop ? "crop" : undefined
    }];
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
  if (input.connectFromNodeId) {
    canvas.edges = [...(canvas.edges ?? []), { id: `edge_${shortId()}`, fromNodeId: input.connectFromNodeId, toNodeId: id }];
  }
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function importAudioAsNode(input: ImportAudioInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const extension = normalizedAudioExtension(input.filename);
  const id = `audio_${shortId()}`;
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, titleFromFilename(input.filename));
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const audioRelativePath = portableJoin("content", `000-import${extension}`);
  const audioPath = resolvePortablePath(nodePath, audioRelativePath);
  await mkdir(join(nodePath, "content"), { recursive: true });

  if (input.dataBase64) {
    await writeFile(audioPath, Buffer.from(input.dataBase64, "base64"));
  } else if (input.sourcePath) {
    await copyFile(input.sourcePath, audioPath);
  } else {
    throw new Error("dataBase64 or sourcePath is required.");
  }

  const now = new Date().toISOString();
  const manifest: AudioNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "audio",
    title,
    stack: [{
      id: `stack_${shortId()}`,
      file: audioRelativePath,
      source: "import",
      mimeType: audioMimeTypeFromExtension(extension),
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
    type: "audio",
    nodePath: nodeRelativePath,
    x: Math.round(input.dropX - width / 2),
    y: Math.round(input.dropY - height / 2),
    width,
    height
  });
  if (input.connectFromNodeId) {
    canvas.edges = [...(canvas.edges ?? []), { id: `edge_${shortId()}`, fromNodeId: input.connectFromNodeId, toNodeId: id }];
  }
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
  if (input.connectFromNodeId) {
    canvas.edges = [...(canvas.edges ?? []), { id: `edge_${shortId()}`, fromNodeId: input.connectFromNodeId, toNodeId: id }];
  }
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

async function importAudioAssetsAsStackNode(scan: LocalLibraryScanResult, input: ImportLocalFolderStackInput): Promise<LibrarySnapshot> {
  const audioAssets = scan.assets.filter((asset) => asset.kind === "audio");
  if (!audioAssets.length) throw new Error("Folder does not contain audio assets.");
  const libraryPath = await ensureCurrentLibrary();
  const now = new Date().toISOString();
  const id = `audio_${shortId()}`;
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, `${scan.title} Audio Stack`);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  await mkdir(join(nodePath, "content"), { recursive: true });

  const stack: ImageStackItem[] = [];
  for (const [index, asset] of audioAssets.entries()) {
    const extension = normalizedAudioExtension(asset.relativePath);
    const file = portableJoin("content", `${String(index + 1).padStart(3, "0")}-${sanitizeFilename(basename(asset.relativePath)) || `audio${extension}`}`);
    await copyFile(resolvePortablePath(scan.sourcePath, asset.relativePath), resolvePortablePath(nodePath, file));
    stack.push({ id: `stack_${shortId()}`, file, source: "folder-import", mimeType: audioMimeTypeFromExtension(extension), width: input.width ?? defaultNodeWidth, height: input.height ?? defaultNodeHeight, createdAt: now });
  }

  const manifest: AudioNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "audio",
    title,
    stack,
    activeStackIndex: 0,
    createdAt: now,
    updatedAt: now
  };
  await writeJson(join(nodePath, "snark.node.json"), manifest);
  await writeCurrentPrompt(nodePath, "");
  await addTypedStackCanvasNode(libraryPath, id, "audio", nodeRelativePath, input, defaultNodeWidth, defaultNodeHeight);
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
  type: "image" | "text" | "video" | "audio",
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

export async function appendAudioToNodeStack(input: AppendAudioStackInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readAudioNode(input.nodeId);
  const extension = normalizedAudioExtension(input.filename);
  const stackIndex = manifest.stack.length;
  const audioRelativePath = nextStackFilename(manifest.stack, "import", extension);
  const audioPath = resolvePortablePath(nodePath, audioRelativePath);
  await mkdir(join(nodePath, "content"), { recursive: true });

  if (input.dataBase64) {
    await writeFile(audioPath, Buffer.from(input.dataBase64, "base64"));
  } else if (input.sourcePath) {
    await copyFile(input.sourcePath, audioPath);
  } else {
    throw new Error("dataBase64 or sourcePath is required.");
  }

  const now = new Date().toISOString();
  const updatedManifest: AudioNodeManifest = {
    ...manifest,
    stack: [...manifest.stack, {
      id: `stack_${shortId()}`,
      file: audioRelativePath,
      source: "import",
      mimeType: audioMimeTypeFromExtension(extension),
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

export async function setImageNodeSelectedStackItems(nodeId: string, selectedStackItemIds: string[]): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readImageNode(nodeId);
  const requestedIds = new Set(selectedStackItemIds);
  const selectedIds = manifest.stack.filter((item) => requestedIds.has(item.id)).map((item) => item.id);
  if (selectedIds.length !== requestedIds.size) throw new Error("One or more selected stack items were not found.");
  await writeJson(join(nodePath, "snark.node.json"), {
    ...manifest,
    selectedStackItemIds: selectedIds,
    updatedAt: new Date().toISOString()
  });
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

export async function setAudioNodeActiveStackItem(nodeId: string, stackIndex: number): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readAudioNode(nodeId);
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
    selectedStackItemIds: manifest.selectedStackItemIds?.filter((id) => id !== stackItemId) ?? [],
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

export async function deleteAudioNodeStackItem(nodeId: string, stackItemId: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readAudioNode(nodeId);
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
  const promptTemplate = input.prompt?.trim() || "Create a polished image.";
  const inputImages = imageInputsForPrompt(orderedInputs, promptTemplate);
  const maxImageInputs = positiveInteger(input.maxImageInputs);
  const generationInputs = limitImages(
    inputImages.filter((image, index, all) => all.findIndex((candidate) => candidate.path === image.path) === index),
    maxImageInputs
  );
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
  const imageBuffer = await readGeneratedAssetBuffer(generatedPath, "image");
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
  const promptTemplate = input.prompt?.trim() || "Create a cinematic video.";
  const inputImages = imageInputsForPrompt(orderedInputs, promptTemplate);
  const generationInputs = limitImages(
    inputImages.filter((image, index, all) => all.findIndex((candidate) => candidate.path === image.path) === index),
    positiveInteger(input.maxImageInputs)
  );
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
  await writeFile(videoPath, await readGeneratedAssetBuffer(generatedPath, "video"));

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

export async function generateAudioNodeStackItem(input: GenerateAudioNodeInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readAudioNode(input.nodeId);
  const promptTemplate = input.prompt?.trim() || "Generate a short audio clip.";
  const connectedInputs = await connectedCanvasInputs(libraryPath, input.nodeId);
  const orderedInputs = orderConnectedInputs(connectedInputs, input.inputNodeIds);
  const mediaInputs = mediaInputsForPrompt(orderedInputs, promptTemplate);
  const prompt = resolveInputTokens(promptTemplate, orderedInputs, mediaInputs, input.imageReferenceSyntax);
  const generationSettings = sanitizeImageGenerationSettings(input.parameters);
  await writeCurrentPrompt(nodePath, promptTemplate);
  const runResult = await runAudioModelForStackItem({
    nodeId: input.nodeId,
    modelId: input.modelId,
    executionProvider: executionProviderForInput(input),
    prompt,
    mediaInputs,
    parameters: generationSettings
  });
  const generationResult = runResult.nodeResults.generate;
  if (runResult.status === "failed" || generationResult?.status === "failed") {
    throw new Error(generationResult?.error || "Audio generation failed.");
  }
  const generatedAudio = audioAssetFromGenerationOutput(generationResult?.output);
  const generatedPath = generatedAudio.localPath ?? generatedAudio.path;
  if (!generatedPath) throw new Error(`Model "${input.modelId}" did not return a saved audio path.`);
  const extension = normalizedGeneratedAudioExtension(generatedAudio.filename ?? generatedPath, generatedAudio.mimeType);
  const stackIndex = manifest.stack.length;
  const audioRelativePath = nextStackFilename(manifest.stack, "generation", extension);
  const audioPath = resolvePortablePath(nodePath, audioRelativePath);
  await mkdir(dirname(audioPath), { recursive: true });
  await writeFile(audioPath, await readGeneratedAssetBuffer(generatedPath, "audio"));

  const now = new Date().toISOString();
  const updatedManifest: AudioNodeManifest = {
    ...manifest,
    modelId: input.modelId,
    executionProvider: executionProviderForInput(input),
    fallbackAllowed: input.fallbackAllowed !== false,
    stack: [...manifest.stack, {
      id: `stack_${shortId()}`,
      file: audioRelativePath,
      source: "generation",
      mimeType: generatedAudio.mimeType ?? audioMimeTypeFromExtension(extension),
      coverUrl: generatedAudio.coverUrl,
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

export async function generateTextNodeStackItem(input: GenerateTextNodeInput): Promise<LibrarySnapshot> {
  const promptTemplate = input.prompt?.trim();
  if (!promptTemplate) throw new Error("Prompt is required.");
  const { text } = await runTextNodeModel(input, promptTemplate);
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

export async function appendTextNodeConversationMessage(input: AppendTextNodeConversationMessageInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readTextNode(input.nodeId);
  const conversation = await readTextNodeConversation(nodePath);
  const connectedInputs = await connectedCanvasInputs(libraryPath, input.nodeId);
  const content = [
    ...conversationPartsFromInput(input.content).map((part) =>
      part.type === "text" ? { ...part, text: resolveTextInputTokens(part.text, connectedInputs) } : part
    ),
    ...await materializeConversationAttachments(libraryPath, nodePath, input.nodeId, input.attachments)
  ];
  if (!content.length) throw new Error("Message content is required.");
  conversation.messages.push({
    id: `msg_${shortId()}`,
    role: input.role,
    createdAt: new Date().toISOString(),
    content
  });
  await writeTextNodeConversation(nodePath, conversation);
  await touchTextNodeManifest(nodePath, manifest);
  return readLibrarySnapshot(libraryPath);
}

export async function runTextNodeConversationTurn(input: RunTextNodeConversationTurnInput): Promise<LibrarySnapshot> {
  const promptTemplate = input.prompt?.trim();
  if (!promptTemplate) throw new Error("Prompt is required.");
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readTextNode(input.nodeId);
  const conversation = await readTextNodeConversation(nodePath);
  const connectedInputs = await connectedCanvasInputs(libraryPath, input.nodeId);
  const orderedInputs = orderConnectedInputs(connectedInputs, input.inputNodeIds);
  const promptContent: TextNodeConversationPart[] = [
    { type: "text", text: resolveTextInputTokens(promptTemplate, orderedInputs) },
    ...await materializeConversationAttachments(libraryPath, nodePath, input.nodeId, input.attachments)
  ];
  conversation.messages.push({
    id: `msg_${shortId()}`,
    role: "user",
    createdAt: new Date().toISOString(),
    content: promptContent
  });

  const images = limitImages(conversationImageInputs(nodePath, conversation), positiveInteger(input.maxImageInputs));
  const modelPrompt = conversationPrompt(conversation, images, input.imageReferenceSyntax);
  const { text, executionProvider } = await executeTextNodeModel(input, modelPrompt, images);
  conversation.messages.push({
    id: `msg_${shortId()}`,
    role: "assistant",
    createdAt: new Date().toISOString(),
    content: [{ type: "text", text }],
    model: { modelId: input.modelId, providerId: executionProvider }
  });
  await writeTextNodeConversation(nodePath, conversation);
  await writeJson(join(nodePath, "snark.node.json"), {
    ...manifest,
    modelId: input.modelId,
    executionProvider,
    fallbackAllowed: input.fallbackAllowed !== false,
    updatedAt: new Date().toISOString()
  });
  return readLibrarySnapshot(libraryPath);
}

async function runTextNodeModel(input: GenerateTextNodeInput, promptTemplate: string): Promise<{ text: string; executionProvider: string }> {
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
  return executeTextNodeModel(input, prompt, images);
}

async function executeTextNodeModel(input: GenerateTextNodeInput, prompt: string, images: GenerationImageInput[]): Promise<{ text: string; executionProvider: string }> {
  const executionProvider = executionProviderForInput(input);
  const runResult = await runTextModelForStackItem({
    nodeId: input.nodeId,
    modelId: input.modelId,
    executionProvider,
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
  return { text, executionProvider };
}

async function runImageModelForStackItem(input: { nodeId: string; modelId: string; executionProvider: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; prompt: string; images: GenerationImageInput[]; parameters: ImageGenerationSettings }) {
  if (!["auto", "polza", "openrouter", "gemini"].includes(input.executionProvider)) {
    throw new Error(`Execution provider "${input.executionProvider}" is not available for image generation.`);
  }
  const autoOnlyPolza = input.executionProvider === "auto" && input.availableExecutionProviders?.length === 1 && input.availableExecutionProviders[0] === "polza";
  const nodeType = input.executionProvider === "polza" || autoOnlyPolza ? "polza.image.generate" : "ai.image.generate";
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
  return executeSnarkRouteWithUsageStats(route);
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
  const executeTextRoute = (nodeType: "ai.text" | "polza.text", executionProvider: string, providerMode: string) => executeSnarkRouteWithUsageStats({
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

async function executeSnarkRouteWithUsageStats(route: OpenRoute, options?: ExecuteOptions): Promise<RunResult> {
  const executor = await createRouteExecutor();
  const runResult = options ? await executor.executeRoute(route, options) : await executor.executeRoute(route);
  await persistSnarkUsageStats(runResult);
  return runResult;
}

async function persistSnarkUsageStats(runResult: RunResult): Promise<void> {
  if (appMode() !== "cloud") return;
  try {
    await saveProviderUsageEventsForRunResult(runResult, { recordCredits: true });
  } catch {
    // Usage statistics must not break Snark canvas generation.
  }
}

async function runVideoModelForStackItem(input: { nodeId: string; modelId: string; executionProvider: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; prompt: string; images: GenerationImageInput[]; parameters: ImageGenerationSettings }) {
  if (input.executionProvider === "openrouter") return runOpenRouterVideoModelForStackItem(input);
  if (input.executionProvider !== "auto" && input.executionProvider !== "polza") throw new Error("Video generation is currently available through polza.ai or OpenRouter.");
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
  return executeSnarkRouteWithUsageStats(route);
}

async function runAudioModelForStackItem(input: { nodeId: string; modelId: string; executionProvider: string; prompt: string; mediaInputs: GenerationMediaInput[]; parameters: ImageGenerationSettings }) {
  const provider = audioExecutionProvider(input.executionProvider, input.modelId);
  if (provider !== "openrouter" && provider !== "polza" && provider !== "elevenlabs") {
    throw new Error(`Execution provider "${input.executionProvider}" is not available for audio generation.`);
  }
  if (input.mediaInputs.length > 0 && !audioModelAcceptsMediaInputs(provider, input.modelId)) {
    throw new Error("The selected audio execution path does not accept connected media inputs yet.");
  }
  if (provider === "polza") return runPolzaAudioModelForStackItem(input);
  if (provider === "elevenlabs") return runElevenLabsAudioModelForStackItem(input);
  return runOpenRouterAudioModelForStackItem(input);
}

function audioModelAcceptsMediaInputs(provider: string, modelId: string): boolean {
  return provider === "polza" && polzaAudioProviderModelId(modelId) === "suno/generate";
}

function audioExecutionProvider(executionProvider: string, modelId: string): "openrouter" | "polza" | "elevenlabs" | string {
  if (executionProvider !== "auto") return executionProvider;
  if (polzaAudioProviderModelId(modelId).startsWith("suno/")) return "polza";
  if (modelId.startsWith("elevenlabs/")) return "openrouter";
  if (modelId === "music_v2" || modelId === "eleven_text_to_sound_v2" || modelId.startsWith("eleven_")) return "elevenlabs";
  return "openrouter";
}

async function runOpenRouterAudioModelForStackItem(input: { nodeId: string; modelId: string; prompt: string; parameters: ImageGenerationSettings }) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OpenRouter is selected, but OpenRouter is not configured.");
  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/u, "");
  const responseFormat = audioResponseFormat(input.parameters);
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: openRouterVideoHeaders(apiKey),
    body: JSON.stringify({
      model: input.modelId,
      input: input.prompt,
      voice: stringSetting(input.parameters.voice) ?? "alloy",
      response_format: responseFormat
    })
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const text = bytes.toString("utf8");
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text };
    }
    const errorValue = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).error : undefined;
    const error = typeof errorValue === "string" ? errorValue : errorValue && typeof errorValue === "object" ? stringRecordValue(errorValue as Record<string, unknown>, "message") : undefined;
    throw new Error(`Could not generate audio: ${error ?? (response.statusText || String(response.status))}`);
  }
  const extension = ".mp3";
  const localPath = join(await ensureCurrentLibrary(), ".generated", `${input.nodeId}-${Date.now().toString(36)}${extension}`);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, bytes);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || audioMimeTypeFromExtension(extension);
  return audioGenerationRunResult("openrouter", input.modelId, localPath, mimeType, response.headers.get("x-generation-id") ?? undefined);
}

async function runPolzaAudioModelForStackItem(input: { nodeId: string; modelId: string; prompt: string; mediaInputs: GenerationMediaInput[]; parameters: ImageGenerationSettings }) {
  const apiKey = process.env.POLZA_AI_API_KEY?.trim();
  if (!apiKey) throw new Error("Polza is selected, but POLZA_AI_API_KEY is not configured.");
  const mediaUrl = polzaMediaUrl();
  const createResponse = await fetch(mediaUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(await polzaAudioRequestBody(input.modelId, input.prompt, input.parameters, input.mediaInputs))
  });
  const created = await providerJson(createResponse, "submit Polza audio generation request");
  const completed = await pollPolzaAudioJob(mediaUrl, apiKey, created);
  const audio = firstMediaAudio(completed);
  if (!audio) throw new Error("Polza audio generation did not return an audio asset.");
  const coverUrl = firstMediaArtwork(completed);
  const asset = await writeGeneratedAudioReference(audio, {
    provider: "polza",
    nodeId: input.nodeId,
    modelId: input.modelId
  });
  return audioGenerationRunResult("polza", input.modelId, asset.localPath, asset.mimeType, mediaOperationState(completed).id ?? mediaOperationState(created).id, coverUrl);
}

function polzaMediaUrl(id?: string): string {
  const configured = (process.env.POLZA_BASE_URL ?? "https://polza.ai/api").trim().replace(/\/+$/u, "");
  const mediaBase = configured.endsWith("/v1/media")
    ? configured
    : configured.endsWith("/v1")
      ? `${configured}/media`
      : configured.endsWith("/api")
        ? `${configured}/v1/media`
        : `${configured}/api/v1/media`;
  return id ? `${mediaBase}/${encodeURIComponent(id)}` : mediaBase;
}

async function runElevenLabsAudioModelForStackItem(input: { nodeId: string; modelId: string; prompt: string; parameters: ImageGenerationSettings }) {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) throw new Error("ElevenLabs is selected, but ELEVENLABS_API_KEY is not configured.");
  const baseUrl = (process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io/v1").replace(/\/+$/u, "");
  const response = await fetch(elevenLabsAudioUrl(baseUrl, input.modelId, input.parameters), {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(elevenLabsAudioRequestBody(input.modelId, input.prompt, input.parameters))
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`Could not generate ElevenLabs audio: ${providerErrorFromBytes(bytes, response)}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "audio/mpeg";
  const extension = normalizedGeneratedAudioExtension(`${input.modelId}.mp3`, mimeType);
  const localPath = join(await ensureCurrentLibrary(), ".generated", `${input.nodeId}-${Date.now().toString(36)}${extension}`);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, bytes);
  return audioGenerationRunResult("elevenlabs", input.modelId, localPath, mimeType, response.headers.get("request-id") ?? undefined);
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

type ConnectedCanvasInputType = "text" | "image" | "video" | "audio";

interface ConnectedCanvasInput {
  nodeId: string;
  type: ConnectedCanvasInputType;
  text?: string;
  image?: GenerationImageInput;
  media?: GenerationMediaInput;
}

interface GenerationImageInput {
  path: string;
  localPath?: string;
  mimeType: string;
  ref?: string;
  nodeId?: string;
}

interface GenerationMediaInput {
  type: "image" | "video" | "audio";
  path: string;
  localPath?: string;
  mimeType: string;
  ref?: string;
  nodeId?: string;
}

async function connectedCanvasInputs(libraryPath: string, targetNodeId: string): Promise<ConnectedCanvasInput[]> {
  const canvas = await ensureCanvas(libraryPath);
  const sourceNodeIds = (canvas.edges ?? []).filter((edge) => edge.toNodeId === targetNodeId && edge.kind !== "collectionItem").map((edge) => edge.fromNodeId);
  const inputs: ConnectedCanvasInput[] = [];
  for (const sourceNodeId of sourceNodeIds) {
    const sourceNode = canvas.nodes.find((node) => node.id === sourceNodeId);
    if (sourceNode?.type === "image") {
      const { manifest, nodePath } = await readImageNode(sourceNodeId);
      const item = manifest.stack[manifest.activeStackIndex];
      const image = item ? stackItemImageInput(libraryPath, nodePath, sourceNodeId, item) : undefined;
      inputs.push({ nodeId: sourceNodeId, type: "image", image, media: image ? { ...image, type: "image" } : undefined });
    }
    if (sourceNode?.type === "video") {
      const { manifest, nodePath } = await readVideoNode(sourceNodeId);
      const item = manifest.stack[manifest.activeStackIndex];
      inputs.push({ nodeId: sourceNodeId, type: "video", media: item ? stackItemMediaInput(nodePath, sourceNodeId, "video", item) : undefined });
    }
    if (sourceNode?.type === "audio") {
      const { manifest, nodePath } = await readAudioNode(sourceNodeId);
      const item = manifest.stack[manifest.activeStackIndex];
      inputs.push({ nodeId: sourceNodeId, type: "audio", media: item ? stackItemMediaInput(nodePath, sourceNodeId, "audio", item) : undefined });
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

function audioAssetFromGenerationOutput(output: unknown): { localPath?: string; path?: string; filename?: string; mimeType?: string; coverUrl?: string } {
  if (!output || typeof output !== "object") throw new Error("Audio generation returned no output.");
  const record = output as Record<string, unknown>;
  const audio = record.audio;
  if (!audio || typeof audio !== "object") throw new Error("Audio generation returned no audio asset.");
  return audio as { localPath?: string; path?: string; filename?: string; mimeType?: string; coverUrl?: string };
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

export async function duplicateStackItemAsConnectedAudioNode(input: DuplicateStackItemInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest: sourceManifest, nodePath: sourceNodePath } = await readAudioNode(input.nodeId);
  const sourceItem = sourceManifest.stack.find((item) => item.id === input.stackItemId);
  if (!sourceItem?.file) throw new Error(`Stack item "${input.stackItemId}" was not found.`);

  const now = new Date().toISOString();
  const id = `audio_${shortId()}`;
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, sourceManifest.title || "Audio");
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  const extension = extname(sourceItem.file).toLowerCase() || ".mp3";
  const audioRelativePath = portableJoin("content", `000-import${extension}`);
  await mkdir(join(nodePath, "content"), { recursive: true });
  await copyFile(resolvePortablePath(sourceNodePath, sourceItem.file), resolvePortablePath(nodePath, audioRelativePath));

  const manifest: AudioNodeManifest = {
    format: "snarkroute.node",
    version: "0.1",
    id,
    type: "audio",
    title,
    stack: [{ ...sourceItem, id: `stack_${shortId()}`, file: audioRelativePath, source: "import", createdAt: now }],
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
    type: "audio",
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
  if (input.stackKind === "audio") return importAudioAssetsAsStackNode(scan, input);
  return importTextAssetsAsStackNode(scan, input);
}

export async function createEmptyCanvasNode(input: CreateNodeInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const now = new Date().toISOString();
  const id = `${input.type}_${shortId()}`;
  const width = input.width ?? defaultNodeWidth;
  const height = input.height ?? defaultNodeHeight;
  const defaultTitle = input.variant === "note" ? "Note" : input.type === "image" ? "Image" : input.type === "video" ? "Video" : input.type === "audio" ? "Audio" : input.type === "collection" ? "Collection" : "Text";
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
  } else if (input.type === "audio") {
    const manifest: AudioNodeManifest = {
      format: "snarkroute.node",
      version: "0.1",
      id,
      type: "audio",
      title,
      stack: [],
      activeStackIndex: 0,
      createdAt: now,
      updatedAt: now
    };
    await writeJson(join(nodePath, "snark.node.json"), manifest);
    await writeCurrentPrompt(nodePath, "");
  } else if (input.type === "collection") {
    const manifest: CollectionNodeManifest = {
      format: "snarkroute.node",
      version: "0.1",
      id,
      type: "collection",
      title,
      createdAt: now,
      updatedAt: now
    };
    await writeJson(join(nodePath, "snark.node.json"), manifest);
  } else {
    const manifest: TextNodeManifest = {
      format: "snarkroute.node",
      version: "0.1",
      id,
      type: "text",
      variant: input.variant,
      title,
      text: "",
      stackPath: "content",
      color: input.variant === "note" ? "amber" : "mint",
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
  if (input.connectFromNodeId && input.variant !== "note") {
    canvas.edges = [...(canvas.edges ?? []), { id: `edge_${shortId()}`, fromNodeId: input.connectFromNodeId, toNodeId: id }];
  }
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function runCanvasNodeAction(input: RunCanvasNodeActionInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const action = await findCanvasActionManifest(input.actionId);
  if (!action) throw new Error(`Canvas action "${input.actionId}" was not found.`);
  const inputPort = action.inputs[0];
  const source = await canvasActionSourceInput(libraryPath, input.nodeId, inputPort.type);
  const targetNode = input.targetNodeId ? canvas.nodes.find((node) => node.id === input.targetNodeId) : undefined;
  if (input.targetNodeId && !targetNode) throw new Error(`Target node "${input.targetNodeId}" was not found.`);
  const runResult = await executeSnarkRouteWithUsageStats({
    routeVersion: "0.1",
    route: {
      id: `snarkroute-canvas-action-${action.id}-${input.nodeId}`,
      title: action.canvasAction?.title?.trim() || action.title,
      author: { name: "SnarkRoute" }
    },
    nodes: [
      { id: "source", type: "utility.null" },
      { id: "action", type: action.id, params: input.params ?? {} }
    ],
    edges: [{ from: "source", to: "action", fromPort: "value", toPort: inputPort.id }]
  }, {
    initialNodeOutputs: { source: { value: source.value } }
  });
  const actionResult = runResult.nodeResults.action;
  if (runResult.status !== "succeeded" || actionResult?.status !== "succeeded") {
    throw new Error(actionResult?.error || `Canvas action "${action.title}" failed.`);
  }
  const output = actionResult.output && typeof actionResult.output === "object" ? actionResult.output as Record<string, unknown> : {};
  let created = 0;
  for (const port of action.outputs) {
    const value = output[port.id];
    if (value === undefined || value === null) continue;
    if (targetNode) {
      if (targetNode.type !== port.type) continue;
      await appendCanvasActionOutputToTargetStack({
        targetNodeId: targetNode.id,
        title: port.label ?? action.canvasAction?.title ?? action.title,
        type: port.type,
        value
      });
      created += 1;
      continue;
    }
    await materializeCanvasActionOutput({
      libraryPath,
      sourceNodeId: input.nodeId,
      actionId: input.actionId,
      title: port.label ?? action.canvasAction?.title ?? action.title,
      type: port.type,
      value,
      x: (input.x ?? source.canvas.x + source.canvas.width + defaultNodeWidth / 2 + 84) + created * 36,
      y: (input.y ?? source.canvas.y + defaultNodeHeight / 2) + created * 36,
      width: input.width ?? defaultNodeWidth,
      height: input.height ?? defaultNodeHeight
    });
    created += 1;
  }
  if (created === 0) throw new Error(`Canvas action "${action.title}" did not return materializable outputs.`);
  return readLibrarySnapshot(libraryPath);
}

export async function duplicateCanvasNode(input: DuplicateCanvasNodeInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const sourceCanvasNode = canvas.nodes.find((node) => node.id === input.nodeId);
  if (!sourceCanvasNode) throw new Error(`Node "${input.nodeId}" was not found.`);

  const sourcePath = resolvePortablePath(libraryPath, sourceCanvasNode.nodePath);
  const manifest = JSON.parse(await readFile(join(sourcePath, "snark.node.json"), "utf8")) as ImageNodeManifest | VideoNodeManifest | AudioNodeManifest | TextNodeManifest | LibraryNodeManifest;
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
  const sourceManifest = JSON.parse(await readFile(join(sourcePath, "snark.node.json"), "utf8")) as ImageNodeManifest | VideoNodeManifest | AudioNodeManifest | TextNodeManifest | LibraryNodeManifest;
  const now = new Date().toISOString();
  const id = `${input.type}_${shortId()}`;
  const targetLabel = input.type === "image" ? "Image" : input.type === "video" ? "Video" : input.type === "audio" ? "Audio" : "Text";
  const { title, nodeRelativePath } = await allocateCanvasNodeLocation(libraryPath, `${sourceManifest.title || sourceManifest.type} ${targetLabel}`);
  const nodePath = resolvePortablePath(libraryPath, nodeRelativePath);
  await cp(sourcePath, nodePath, { recursive: true });

  const promptText = sourceManifest.type === "image" || sourceManifest.type === "video" || sourceManifest.type === "audio" ? await readCurrentPrompt(sourcePath) : sourcePromptText(sourceManifest);
  await writeJson(join(nodePath, "snark.node.json"), representationManifestFromSource(sourceManifest, input.type, id, title, now, promptText));
  if (input.type === "image" || input.type === "video" || input.type === "audio") await writeCurrentPrompt(nodePath, promptText);

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
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest | VideoNodeManifest | AudioNodeManifest | TextNodeManifest | LibraryNodeManifest;
  await writeJson(manifestPath, { ...manifest, updatedAt: new Date().toISOString() });
  return readLibrarySnapshot(libraryPath);
}

export async function updateTextNode(nodeId: string, updates: { text?: string; color?: string; inputMode?: "text" | "dialogue"; modelId?: string; executionProvider?: string; fallbackAllowed?: boolean }): Promise<LibrarySnapshot> {
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
    inputMode: updates.inputMode ?? manifest.inputMode,
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

export async function updateAudioNodePrompt(nodeId: string, prompt: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { nodePath } = await readAudioNode(nodeId);
  await writeCurrentPrompt(nodePath, prompt);
  return readLibrarySnapshot(libraryPath);
}

export async function updateMediaNodeRouteSettings(type: "image" | "video" | "audio", nodeId: string, input: UpdateMediaNodeRouteSettingsInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = type === "image" ? await readImageNode(nodeId) : type === "video" ? await readVideoNode(nodeId) : await readAudioNode(nodeId);
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
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest | VideoNodeManifest | AudioNodeManifest | TextNodeManifest | LibraryNodeManifest | CollectionNodeManifest;
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
  await moveCanvasNodeFolderToTrash(libraryPath, nodePath);
  await writeCanvas(libraryPath, canvas);
  await replaceDeletedRepresentativeImage(libraryPath, nodeId);
  return readLibrarySnapshot(libraryPath);
}

export async function duplicateCollectionItemAsNode(input: { nodeId: string; itemId: string; x: number; y: number; width?: number; height?: number }): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const collectionNode = canvas.nodes.find((node) => node.id === input.nodeId && node.type === "collection");
  if (!collectionNode) throw new Error(`Collection node "${input.nodeId}" was not found.`);
  const item = (await collectionNodeItems(libraryPath, canvas, input.nodeId)).find((candidate) => candidate.id === input.itemId);
  if (!item) throw new Error(`Collection item "${input.itemId}" was not found.`);
  const collectionPath = resolvePortablePath(libraryPath, collectionNode.nodePath);
  const sourcePath = resolvePortablePath(collectionPath, item.file);
  const existingNodeIds = new Set(canvas.nodes.map((node) => node.id));
  const filename = `${sanitizeFilename(item.title) || item.type}${extname(item.file)}`;
  const common = {
    filename,
    sourcePath,
    dropX: input.x,
    dropY: input.y,
    width: input.width,
    height: input.height
  };
  if (item.type === "image") await importImageAsNode(common);
  else if (item.type === "video") await importVideoAsNode(common);
  else if (item.type === "audio") await importAudioAsNode(common);
  else await importTextAsNode({
      filename: `${sanitizeFilename(item.title) || "text"}.md`,
      text: item.text ?? "",
      dropX: input.x,
      dropY: input.y,
      width: input.width,
      height: input.height
    });

  const nextCanvas = await ensureCanvas(libraryPath);
  const createdNode = nextCanvas.nodes.find((node) => !existingNodeIds.has(node.id));
  if (!createdNode) throw new Error("Collection item did not create a node.");
  nextCanvas.edges = [...(nextCanvas.edges ?? []), {
    id: `edge_${shortId()}`,
    fromNodeId: input.nodeId,
    toNodeId: createdNode.id,
    kind: "collectionItem"
  }];
  await writeCanvas(libraryPath, nextCanvas);
  return readLibrarySnapshot(libraryPath);
}

export async function trashOrphanCanvasNodeFolders(): Promise<{ snapshot: LibrarySnapshot; movedCount: number; movedNodePaths: string[]; failedCount: number; failedNodePaths: Array<{ nodePath: string; error: string }> }> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const hydratedNodes = await readCanvasNodes(libraryPath, canvas);
  const retainedNodeIds = new Set(hydratedNodes.map((node) => node.canvas.id));
  const retainedCanvasNodes = hydratedNodes.map((node) => node.canvas);
  const referencedNodePaths = new Set(retainedCanvasNodes.map((node) => node.nodePath.split("\\").join("/").toLowerCase()));
  const nodesDirectory = join(libraryPath, "nodes");
  const entries = await readdir(nodesDirectory, { withFileTypes: true }).catch(() => []);
  const movedNodePaths: string[] = [];
  const failedNodePaths: Array<{ nodePath: string; error: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".node")) continue;
    const nodePath = join(nodesDirectory, entry.name);
    const relativePath = portableRelativePath(libraryPath, nodePath);
    if (referencedNodePaths.has(relativePath.toLowerCase())) continue;
    try {
      await moveCanvasNodeFolderToTrash(libraryPath, nodePath);
      movedNodePaths.push(relativePath);
    } catch (error) {
      failedNodePaths.push({ nodePath: relativePath, error: errorMessageText(error) });
    }
  }

  canvas.nodes = retainedCanvasNodes;
  canvas.edges = (canvas.edges ?? []).filter((edge) => retainedNodeIds.has(edge.fromNodeId) && retainedNodeIds.has(edge.toNodeId));
  await writeCanvas(libraryPath, canvas);

  return { snapshot: await readLibrarySnapshot(libraryPath), movedCount: movedNodePaths.length, movedNodePaths, failedCount: failedNodePaths.length, failedNodePaths };
}

async function moveCanvasNodeFolderToTrash(libraryPath: string, nodePath: string): Promise<void> {
  if (!await pathExists(nodePath)) return;
  const trashDirectory = join(libraryPath, ".trash", "nodes");
  await mkdir(trashDirectory, { recursive: true });
  const targetPath = join(trashDirectory, `${basename(nodePath)}-${Date.now().toString(36)}-${shortId()}`);
  try {
    await rename(nodePath, targetPath);
  } catch (error) {
    await cp(nodePath, targetPath, { recursive: true, force: false, errorOnExist: true });
    try {
      await rm(nodePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch (removeError) {
      await rm(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => undefined);
      throw removeError;
    }
  }
}

function errorMessageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export async function readAudioNode(nodeId: string): Promise<{ manifest: AudioNodeManifest; nodePath: string }> {
  const { manifest, nodePath } = await readTypedCanvasNode(nodeId, "audio");
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
async function readTypedCanvasNode(nodeId: string, type: "audio"): Promise<{ manifest: AudioNodeManifest; nodePath: string }>;
async function readTypedCanvasNode(nodeId: string, type: "library"): Promise<{ manifest: LibraryNodeManifest; nodePath: string }>;
async function readTypedCanvasNode(nodeId: string, type: "image" | "video" | "audio" | "library"): Promise<{ manifest: ImageNodeManifest | VideoNodeManifest | AudioNodeManifest | LibraryNodeManifest; nodePath: string }> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const canvasNode = canvas.nodes.find((node) => node.id === nodeId);
  if (!canvasNode) throw new Error(`${type} node "${nodeId}" was not found.`);
  const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
  const manifestPath = join(nodePath, "snark.node.json");
  if (!await fileExists(manifestPath)) throw new Error(`${type} node "${nodeId}" was not found.`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest | VideoNodeManifest | AudioNodeManifest | LibraryNodeManifest;
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

export async function createAudioStackReadStream(nodeId: string, stackItemId: string): Promise<{ stream: ReturnType<typeof createReadStream>; mimeType: string }> {
  const { manifest, nodePath } = await readAudioNode(nodeId);
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
    coverUrl: cover ? `/api/libraries/projects/${encodeURIComponent(id)}/cover?v=${encodeURIComponent(projectImageId(cover.path))}` : null,
    current
  };
}

async function saveProjectPath(projectPath: string, options: { moveToTop: boolean; makeCurrent?: boolean }): Promise<void> {
  const registry = await readProjectRegistry();
  const normalized = resolve(projectPath);
  const existingIndex = registry.projects.findIndex((project) => resolve(project.path) === normalized);
  const entry = existingIndex >= 0
    ? { ...registry.projects[existingIndex], path: normalized }
    : { path: normalized, addedAt: new Date().toISOString() };
  if (existingIndex >= 0) registry.projects.splice(existingIndex, 1, entry);
  else if (options.moveToTop) registry.projects.unshift(entry);
  else registry.projects.push(entry);
  if (options.moveToTop && existingIndex >= 0) {
    registry.projects.splice(existingIndex, 1);
    registry.projects.unshift(entry);
  }
  if (options.makeCurrent) registry.currentProjectPath = normalized;
  await writeProjectRegistry(registry);
}

async function readProjectRegistry(): Promise<LibraryProjectRegistry> {
  const path = join(librariesDirectory, projectRegistryFilename);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LibraryProjectRegistry>;
    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    return {
      version: 1,
      currentProjectPath: typeof parsed.currentProjectPath === "string" ? resolve(parsed.currentProjectPath) : undefined,
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
  const currentProjectPath = registry.currentProjectPath ? resolve(registry.currentProjectPath) : undefined;
  await writeJson(join(librariesDirectory, projectRegistryFilename), {
    version: 1,
    currentProjectPath: currentProjectPath && paths.includes(currentProjectPath) ? currentProjectPath : paths[0],
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
    const registry = await readProjectRegistry();
    const lastProjectPath = registry.currentProjectPath ?? registry.projects[0]?.path;
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
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest | VideoNodeManifest | AudioNodeManifest | TextNodeManifest | LibraryNodeManifest | CollectionNodeManifest;
    if (manifest.type === "image") {
      const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
      const syncedManifest = await syncMediaStackWithContent(nodePath, manifest);
      const stackItemIds = new Set(syncedManifest.stack.map((item) => item.id));
      const hydratedManifest = {
        ...syncedManifest,
        selectedStackItemIds: syncedManifest.selectedStackItemIds?.filter((id) => stackItemIds.has(id)) ?? [],
        currentPrompt: await readCurrentPrompt(nodePath)
      };
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
    if (manifest.type === "audio") {
      const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
      const hydratedManifest = { ...await syncMediaStackWithContent(nodePath, manifest), currentPrompt: await readCurrentPrompt(nodePath) };
      const activeStackItem = hydratedManifest.stack[hydratedManifest.activeStackIndex] ?? null;
      nodes.push({
        canvas: canvasNode,
        manifest: hydratedManifest,
        activeStackItem,
        previewUrl: activeStackItem ? `/api/libraries/current/audio-nodes/${encodeURIComponent(hydratedManifest.id)}/stack/${encodeURIComponent(activeStackItem.id)}` : null
      });
    }
    if (manifest.type === "text") {
      const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
      const stack = await readTextNodeStack(nodePath, manifest);
      const activeStackItem = stack.find((item) => item.id === manifest.selectedStackItemId) ?? null;
      nodes.push({
        canvas: canvasNode,
        manifest: { ...manifest, inputMode: manifest.inputMode ?? "text", stackPath: manifest.stackPath ?? "content", selectedStackItemId: activeStackItem?.id },
        stack,
        conversation: await readTextNodeConversation(nodePath),
        activeStackItem,
        outputText: activeStackItem?.text ?? manifest.text,
        previewUrl: activeStackItem?.previewFile ? `/api/libraries/current/text-nodes/${encodeURIComponent(manifest.id)}/stack/${encodeURIComponent(activeStackItem.id)}/preview` : null
      });
    }
    if (manifest.type === "collection") {
      const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
      const synced = await syncCollectionNode(libraryPath, canvas, nodePath, manifest);
      nodes.push({
        canvas: canvasNode,
        manifest: synced.manifest,
        items: synced.items,
        activeStackItem: null,
        previewUrl: null
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

export async function createCollectionItemReadStream(nodeId: string, itemId: string): Promise<{ stream: ReturnType<typeof createReadStream>; mimeType: string }> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const canvasNode = canvas.nodes.find((node) => node.id === nodeId && node.type === "collection");
  if (!canvasNode) throw new Error(`Collection node "${nodeId}" was not found.`);
  const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
  const manifest = JSON.parse(await readFile(join(nodePath, "snark.node.json"), "utf8")) as CollectionNodeManifest;
  const item = manifest.items?.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Collection item "${itemId}" was not found.`);
  return { stream: createReadStream(resolvePortablePath(nodePath, item.file)), mimeType: item.mimeType };
}

export async function deleteCollectionNodeItem(nodeId: string, itemId: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const canvasNode = canvas.nodes.find((node) => node.id === nodeId && node.type === "collection");
  if (!canvasNode) throw new Error(`Collection node "${nodeId}" was not found.`);
  const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
  const manifestPath = join(nodePath, "snark.node.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CollectionNodeManifest;
  const item = (await syncCollectionNode(libraryPath, canvas, nodePath, manifest)).items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Collection item "${itemId}" was not found.`);
  if (item.manual) {
    await rm(resolvePortablePath(nodePath, item.file), { force: true });
    await writeJson(manifestPath, { ...manifest, items: (manifest.items ?? []).filter((candidate) => candidate.id !== itemId), updatedAt: new Date().toISOString() });
  } else {
    canvas.edges = (canvas.edges ?? []).filter((edge) => !(edge.toNodeId === nodeId && edge.fromNodeId === item.sourceNodeId));
    await writeCanvas(libraryPath, canvas);
  }
  return readLibrarySnapshot(libraryPath);
}

interface DesiredCollectionItem extends Omit<CollectionNodeStoredItem, "file"> {
  sourcePath?: string;
  externalUrl?: string;
}

async function collectionNodeItems(libraryPath: string, canvas: SnarkCanvasDocument, collectionNodeId: string): Promise<CollectionNodeItem[]> {
  const canvasNode = canvas.nodes.find((node) => node.id === collectionNodeId && node.type === "collection");
  if (!canvasNode) return [];
  const nodePath = resolvePortablePath(libraryPath, canvasNode.nodePath);
  const manifest = JSON.parse(await readFile(join(nodePath, "snark.node.json"), "utf8")) as CollectionNodeManifest;
  return (await syncCollectionNode(libraryPath, canvas, nodePath, manifest)).items;
}

async function syncCollectionNode(
  libraryPath: string,
  canvas: SnarkCanvasDocument,
  nodePath: string,
  manifest: CollectionNodeManifest
): Promise<{ manifest: CollectionNodeManifest; items: CollectionNodeItem[] }> {
  const sourceNodeIds = (canvas.edges ?? []).filter((edge) => edge.toNodeId === manifest.id).map((edge) => edge.fromNodeId);
  const desired: DesiredCollectionItem[] = [];
  for (const sourceNodeId of sourceNodeIds) {
    const sourceNode = canvas.nodes.find((node) => node.id === sourceNodeId);
    if (sourceNode?.type === "image") {
      const { manifest, nodePath } = await readImageNode(sourceNodeId);
      const synced = await syncMediaStackWithContent(nodePath, manifest);
      const selected = new Set(synced.selectedStackItemIds ?? []);
      const stackItems = synced.stack.length > 1 ? synced.stack.filter((item) => selected.has(item.id)) : synced.stack;
      for (const item of stackItems) {
        desired.push({
          id: collectionItemId(sourceNodeId, item.id),
          type: "image",
          sourceNodeId,
          stackItemId: item.id,
          title: synced.title,
          mimeType: item.mimeType,
          sourcePath: item.file ? resolvePortablePath(nodePath, item.file) : undefined,
          externalUrl: item.externalUrl
        });
      }
    }
    if (sourceNode?.type === "video" || sourceNode?.type === "audio") {
      const typed = sourceNode.type === "video" ? await readVideoNode(sourceNodeId) : await readAudioNode(sourceNodeId);
      const item = typed.manifest.stack[typed.manifest.activeStackIndex];
      if (item) {
        desired.push({
          id: collectionItemId(sourceNodeId, item.id),
          type: sourceNode.type,
          sourceNodeId,
          stackItemId: item.id,
          title: typed.manifest.title,
          mimeType: item.mimeType,
          sourcePath: item.file ? resolvePortablePath(typed.nodePath, item.file) : undefined,
          externalUrl: item.externalUrl
        });
      }
    }
    if (sourceNode?.type === "text") {
      const { manifest, nodePath } = await readTextNode(sourceNodeId);
      const stack = await readTextNodeStack(nodePath, manifest);
      const selected = stack.find((item) => item.id === manifest.selectedStackItemId);
      desired.push({
        id: collectionItemId(sourceNodeId, selected?.id ?? "draft"),
        type: "text",
        sourceNodeId,
        stackItemId: selected?.id,
        title: selected?.title ?? manifest.title,
        text: selected?.text ?? manifest.text,
        mimeType: "text/markdown"
      });
    }
  }

  const contentPath = join(nodePath, "content");
  await mkdir(contentPath, { recursive: true });
  const previousManagedFiles = new Set((manifest.items ?? []).filter((item) => !item.manual).map((item) => basename(item.file)));
  const textStagingPath = join(nodePath, ".collection-text-sync");
  await rm(textStagingPath, { recursive: true, force: true });
  const storedItems: CollectionNodeStoredItem[] = [];
  for (const item of desired) {
    if (item.type === "text" && !item.text?.trim()) continue;
    const extension = item.type === "text" ? ".prompt.md" : collectionItemExtension(item);
    const itemHash = createHash("sha256").update(item.id).digest("hex").slice(0, 20);
    const file = portableJoin("content", `${item.type}-${itemHash}${extension}`);
    const destination = resolvePortablePath(nodePath, file);
    if (item.type === "text") {
      const saved = await createTextPromptAsset(textStagingPath, { title: item.title, prompt: item.text, category: "text-stack" });
      await copyFile(saved.promptPath, destination);
    } else if (item.sourcePath) {
      await copyFile(item.sourcePath, destination);
    } else if (item.externalUrl) {
      const response = await fetchWithTimeout(item.externalUrl, 15000);
      if (!response.ok) throw new Error(`Could not copy collection item "${item.title}" (${response.status}).`);
      await writeFile(destination, Buffer.from(await response.arrayBuffer()));
    } else {
      continue;
    }
    storedItems.push({
      id: item.id,
      type: item.type,
      sourceNodeId: item.sourceNodeId,
      stackItemId: item.stackItemId,
      title: item.title,
      file,
      mimeType: item.mimeType,
      text: item.text
    });
  }
  await rm(textStagingPath, { recursive: true, force: true });

  const expectedFiles = new Set(storedItems.map((item) => basename(item.file)));
  for (const filename of await readdir(contentPath)) {
    if (!expectedFiles.has(filename) && previousManagedFiles.has(filename)) await rm(join(contentPath, filename), { force: true });
  }

  for (const filename of await readdir(contentPath)) {
    if (expectedFiles.has(filename)) continue;
    const type = collectionManualItemType(filename);
    if (!type) continue;
    const file = portableJoin("content", filename);
    storedItems.push({
      id: `manual:${createHash("sha256").update(filename).digest("hex").slice(0, 20)}`,
      type,
      sourceNodeId: "",
      title: basename(filename, extname(filename)),
      file,
      mimeType: type === "image" ? mimeTypeFromExtension(extname(filename)) : type === "video" ? videoMimeTypeFromExtension(extname(filename)) : type === "audio" ? audioMimeTypeFromExtension(extname(filename)) : "text/markdown",
      text: type === "text" ? await readFile(join(contentPath, filename), "utf8") : undefined,
      manual: true
    });
  }

  const nextManifest = JSON.stringify(manifest.items ?? []) === JSON.stringify(storedItems)
    ? manifest
    : { ...manifest, items: storedItems, updatedAt: new Date().toISOString() };
  if (nextManifest !== manifest) await writeJson(join(nodePath, "snark.node.json"), nextManifest);
  return {
    manifest: nextManifest,
    items: storedItems.map((item) => ({
      ...item,
      previewUrl: item.type === "text" ? undefined : `/api/libraries/current/collection-nodes/${encodeURIComponent(manifest.id)}/items/${encodeURIComponent(item.id)}/content`
    }))
  };
}

function collectionManualItemType(filename: string): CollectionNodeStoredItem["type"] | null {
  const extension = extname(filename).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"].includes(extension)) return "image";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(extension)) return "video";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".flac"].includes(extension)) return "audio";
  if ([".txt", ".md", ".prompt"].includes(extension) || filename.toLowerCase().endsWith(".prompt.md")) return "text";
  return null;
}

function collectionItemExtension(item: DesiredCollectionItem): string {
  const sourceExtension = extname(item.sourcePath ?? "").toLowerCase();
  if (sourceExtension && sourceExtension.length <= 8) return sourceExtension;
  if (item.mimeType === "image/png") return ".png";
  if (item.mimeType === "image/jpeg") return ".jpg";
  if (item.mimeType === "image/webp") return ".webp";
  if (item.mimeType === "video/webm") return ".webm";
  if (item.mimeType === "video/quicktime") return ".mov";
  if (item.mimeType.startsWith("video/")) return ".mp4";
  if (item.mimeType === "audio/wav") return ".wav";
  if (item.mimeType.startsWith("audio/")) return ".mp3";
  return ".bin";
}

function collectionItemId(sourceNodeId: string, stackItemId: string): string {
  return `${sourceNodeId}:${stackItemId}`;
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

export async function createTextNodeConversationImageReadStream(nodeId: string, file: string): Promise<{ stream: ReturnType<typeof createReadStream>; mimeType: string }> {
  const { nodePath } = await readTextNode(nodeId);
  return { stream: createReadStream(resolvePortablePath(nodePath, file)), mimeType: mimeTypeFromExtension(extname(file).toLowerCase()) };
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
async function syncMediaStackWithContent(nodePath: string, manifest: AudioNodeManifest): Promise<AudioNodeManifest>;
async function syncMediaStackWithContent(nodePath: string, manifest: ImageNodeManifest | VideoNodeManifest | AudioNodeManifest): Promise<ImageNodeManifest | VideoNodeManifest | AudioNodeManifest> {
  const contentPath = join(nodePath, "content");
  const entries = await readdir(contentPath, { withFileTypes: true }).catch(() => []);
  const existingFiles = new Set(manifest.stack.flatMap((item) => item.file ? [item.file.toLowerCase()] : []));
  const newFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((file) => {
      const extension = extname(file).toLowerCase();
      if (manifest.type === "image") return extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".webp";
      if (manifest.type === "video") return extension === ".mp4" || extension === ".webm" || extension === ".mov";
      return extension === ".mp3" || extension === ".wav" || extension === ".ogg" || extension === ".m4a" || extension === ".flac";
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
    } else if (manifest.type === "video") {
      items.push({ id: `stack_${shortId()}`, file, source: "import", mimeType: videoMimeTypeFromExtension(extension), width: defaultNodeWidth, height: defaultNodeHeight, createdAt: now });
    } else {
      items.push({ id: `stack_${shortId()}`, file, source: "import", mimeType: audioMimeTypeFromExtension(extension), width: defaultNodeWidth, height: defaultNodeHeight, createdAt: now });
    }
  }
  const updated = { ...manifest, stack: [...manifest.stack, ...items], updatedAt: now };
  await writeJson(join(nodePath, "snark.node.json"), updated);
  return updated;
}

function textNodeStackDirectory(nodePath: string, manifest: TextNodeManifest): string {
  return resolvePortablePath(nodePath, manifest.stackPath ?? "content");
}

async function readTextNodeConversation(nodePath: string): Promise<TextNodeConversation> {
  const path = join(nodePath, conversationFilename);
  if (!await fileExists(path)) return emptyTextNodeConversation();
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<TextNodeConversation>;
  return {
    version: 1,
    conversationId: typeof parsed.conversationId === "string" && parsed.conversationId.trim() ? parsed.conversationId : `conv_${shortId()}`,
    messages: Array.isArray(parsed.messages) ? parsed.messages.filter(isTextNodeConversationMessage) : []
  };
}

async function writeTextNodeConversation(nodePath: string, conversation: TextNodeConversation): Promise<void> {
  await writeJson(join(nodePath, conversationFilename), conversation);
}

function emptyTextNodeConversation(): TextNodeConversation {
  return { version: 1, conversationId: `conv_${shortId()}`, messages: [] };
}

function isTextNodeConversationMessage(value: unknown): value is TextNodeConversationMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<TextNodeConversationMessage>;
  return Boolean(record.id)
    && (record.role === "user" || record.role === "assistant" || record.role === "system")
    && typeof record.createdAt === "string"
    && Array.isArray(record.content)
    && record.content.every(isTextNodeConversationPart);
}

function isTextNodeConversationPart(value: unknown): value is TextNodeConversationPart {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<TextNodeConversationPart>;
  if (record.type === "text") return typeof record.text === "string";
  if (record.type === "image") return typeof record.file === "string" && record.file.trim().length > 0;
  return false;
}

function conversationPartsFromInput(content: string | TextNodeConversationPart[] | undefined): TextNodeConversationPart[] {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.filter(isTextNodeConversationPart);
}

async function materializeConversationAttachments(libraryPath: string, nodePath: string, nodeId: string, attachments: TextNodeConversationAttachmentInput[] | undefined): Promise<TextNodeConversationPart[]> {
  if (!attachments?.length) return [];
  const connectedInputs = await connectedCanvasInputs(libraryPath, nodeId);
  const parts: TextNodeConversationPart[] = [];
  for (const attachment of attachments) {
    const sourceImage = attachment.nodeId ? connectedInputs.find((input) => input.nodeId === attachment.nodeId)?.image : undefined;
    const sourcePath = sourceImage?.localPath ?? sourceImage?.path ?? (attachment.file ? resolvePortablePath(nodePath, attachment.file) : undefined);
    if (!sourcePath) continue;
    const extension = normalizedImageExtension(sourcePath);
    const targetRelativePath = nextConversationAttachmentFilename(nodePath, extension);
    const targetPath = resolvePortablePath(nodePath, targetRelativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    parts.push({ type: "image", file: portableRelativePath(nodePath, targetPath), alt: attachment.alt });
  }
  return parts;
}

function nextConversationAttachmentFilename(nodePath: string, extension: string): string {
  for (let index = 0; index < 10000; index += 1) {
    const filename = `att_${Date.now().toString(36)}_${shortId()}${extension}`;
    const relativePath = `content/${filename}`;
    if (!isAbsolute(relativePath)) return relativePath;
  }
  throw new Error("Could not allocate an attachment filename.");
}

function conversationImageInputs(nodePath: string, conversation: TextNodeConversation): GenerationImageInput[] {
  const seen = new Set<string>();
  const images: GenerationImageInput[] = [];
  for (const message of conversation.messages) {
    for (const part of message.content) {
      if (part.type !== "image" || seen.has(part.file)) continue;
      seen.add(part.file);
      const path = resolvePortablePath(nodePath, part.file);
      images.push({ path, localPath: path, mimeType: mimeTypeFromExtension(extname(part.file).toLowerCase()), ref: part.file, nodeId: part.file });
    }
  }
  return images;
}

function conversationPrompt(conversation: TextNodeConversation, images: GenerationImageInput[], imageReferenceSyntax: string | undefined): string {
  return conversation.messages.map((message) => {
    const content = message.content.map((part) => {
      if (part.type === "text") return part.text;
      const position = images.findIndex((image) => image.ref === part.file);
      if (position < 0) return "";
      return (imageReferenceSyntax?.trim() || "@image {index}").replaceAll("{index}", String(position + 1));
    }).join("\n").trim();
    return `${message.role.toUpperCase()}:\n${content}`;
  }).join("\n\n");
}

async function touchTextNodeManifest(nodePath: string, manifest: TextNodeManifest): Promise<void> {
  await writeJson(join(nodePath, "snark.node.json"), { ...manifest, updatedAt: new Date().toISOString() });
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
  source: ImageNodeManifest | VideoNodeManifest | AudioNodeManifest | TextNodeManifest | LibraryNodeManifest,
  type: "image" | "video" | "audio" | "text",
  id: string,
  title: string,
  now: string,
  promptText = ""
): ImageNodeManifest | VideoNodeManifest | AudioNodeManifest | TextNodeManifest {
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

function sourcePromptText(source: ImageNodeManifest | VideoNodeManifest | AudioNodeManifest | TextNodeManifest | LibraryNodeManifest, promptText = ""): string {
  if (source.type === "text") return source.text ?? "";
  if (source.type === "library") return source.sourcePath ?? "";
  return promptText;
}

async function findCanvasActionManifest(actionId: string): Promise<SnarkNodeManifest | null> {
  const manifests = [
    ...builtInNodeManifests,
    ...providerNodeManifests(),
    ...await loadInstalledNodeManifests(),
    ...await loadCanvasActionManifests()
  ];
  return manifests.find((manifest) =>
    manifest.id === actionId
    && manifest.enabled !== false
    && manifest.canvasAction?.enabled === true
    && manifest.inputs.length === 1
    && isCanvasActionPortType(manifest.inputs[0].type)
    && manifest.outputs.length > 0
    && manifest.outputs.every((output) => isCanvasActionPortType(output.type))
  ) ?? null;
}

async function canvasActionSourceInput(libraryPath: string, nodeId: string, expectedType: string): Promise<{ value: unknown; canvas: SnarkCanvasNode }> {
  const canvas = await ensureCanvas(libraryPath);
  const canvasNode = canvas.nodes.find((node) => node.id === nodeId);
  if (!canvasNode) throw new Error(`Node "${nodeId}" was not found.`);
  if (canvasNode.type !== expectedType) throw new Error(`Canvas action expects ${expectedType}, but node "${nodeId}" is ${canvasNode.type}.`);
  if (expectedType === "image") {
    const { manifest, nodePath } = await readImageNode(nodeId);
    const item = manifest.stack[manifest.activeStackIndex];
    if (!item) throw new Error("Image node has no active stack item.");
    return { value: stackItemImageInput(libraryPath, nodePath, nodeId, item), canvas: canvasNode };
  }
  if (expectedType === "video" || expectedType === "audio") {
    const typed = expectedType === "video" ? await readVideoNode(nodeId) : await readAudioNode(nodeId);
    const item = typed.manifest.stack[typed.manifest.activeStackIndex];
    if (!item) throw new Error(`${expectedType === "video" ? "Video" : "Audio"} node has no active stack item.`);
    return { value: stackItemMediaInput(typed.nodePath, nodeId, expectedType, item), canvas: canvasNode };
  }
  const { manifest, nodePath } = await readTextNode(nodeId);
  const active = (await readTextNodeStack(nodePath, manifest)).find((item) => item.id === manifest.selectedStackItemId);
  return { value: active?.text ?? manifest.text ?? "", canvas: canvasNode };
}

async function materializeCanvasActionOutput(input: { libraryPath: string; sourceNodeId: string; actionId: string; title: string; type: string; value: unknown; x: number; y: number; width: number; height: number }): Promise<void> {
  if (input.type === "text") {
    const text = textFromActionOutput(input.value);
    if (!text.trim()) return;
    await importTextAsNode({
      filename: `${sanitizeFilename(input.title) || "output"}.txt`,
      text,
      dropX: input.x,
      dropY: input.y,
      width: input.width,
      height: 180
    });
    await connectLatestCanvasNode(input.libraryPath, input.sourceNodeId, "canvasAction", input.actionId);
    return;
  }
  const asset = assetFromActionOutput(input.value);
  const sourcePath = asset.localPath ?? asset.path;
  if (!sourcePath) return;
  if (input.type === "image") {
    await importImageAsNode({
      filename: asset.filename ?? (basename(sourcePath) || "output.png"),
      sourcePath: await localActionAssetPath(sourcePath, "image"),
      dropX: input.x,
      dropY: input.y,
      width: input.width,
      height: input.height
    });
  } else if (input.type === "video") {
    await importVideoAsNode({
      filename: asset.filename ?? (basename(sourcePath) || "output.mp4"),
      sourcePath: await localActionAssetPath(sourcePath, "video"),
      dropX: input.x,
      dropY: input.y,
      width: input.width,
      height: input.height
    });
  } else if (input.type === "audio") {
    await importAudioAsNode({
      filename: asset.filename ?? (basename(sourcePath) || "output.mp3"),
      sourcePath: await localActionAssetPath(sourcePath, "audio"),
      dropX: input.x,
      dropY: input.y,
      width: input.width,
      height: input.height
    });
  }
  if (input.type === "image" || input.type === "video" || input.type === "audio") await connectLatestCanvasNode(input.libraryPath, input.sourceNodeId, "canvasAction", input.actionId);
}

async function appendCanvasActionOutputToTargetStack(input: { targetNodeId: string; title: string; type: string; value: unknown }): Promise<void> {
  if (input.type === "text") {
    const text = textFromActionOutput(input.value);
    if (!text.trim()) return;
    await appendTextToNodeStack(input.targetNodeId, text, input.title);
    return;
  }
  const asset = assetFromActionOutput(input.value);
  const sourcePath = asset.localPath ?? asset.path;
  if (!sourcePath) return;
  if (input.type === "image") {
    await appendImageToNodeStack({
      nodeId: input.targetNodeId,
      filename: asset.filename ?? (basename(sourcePath) || "output.png"),
      sourcePath: await localActionAssetPath(sourcePath, "image")
    });
  } else if (input.type === "video") {
    await appendVideoToNodeStack({
      nodeId: input.targetNodeId,
      filename: asset.filename ?? (basename(sourcePath) || "output.mp4"),
      sourcePath: await localActionAssetPath(sourcePath, "video")
    });
  } else if (input.type === "audio") {
    await appendAudioToNodeStack({
      nodeId: input.targetNodeId,
      filename: asset.filename ?? (basename(sourcePath) || "output.mp3"),
      sourcePath: await localActionAssetPath(sourcePath, "audio")
    });
  }
}

async function localActionAssetPath(path: string, kind: "image" | "video" | "audio"): Promise<string> {
  if (!isRemoteUrl(path)) return path;
  const extension = kind === "image"
    ? normalizedGeneratedExtension(path)
    : kind === "video"
      ? normalizedGeneratedVideoExtension(path)
      : normalizedGeneratedAudioExtension(path);
  const temporaryPath = join(await ensureCurrentLibrary(), ".generated", `canvas-action-${Date.now().toString(36)}-${shortId()}${extension}`);
  await mkdir(dirname(temporaryPath), { recursive: true });
  await writeFile(temporaryPath, await readGeneratedAssetBuffer(path, kind));
  return temporaryPath;
}

async function connectLatestCanvasNode(libraryPath: string, sourceNodeId: string, kind?: "canvasAction", actionId?: string): Promise<void> {
  const canvas = await ensureCanvas(libraryPath);
  const target = canvas.nodes[canvas.nodes.length - 1];
  if (!target || target.id === sourceNodeId) return;
  canvas.edges = [...(canvas.edges ?? []), { id: `edge_${shortId()}`, fromNodeId: sourceNodeId, toNodeId: target.id, kind, actionId }];
  await writeCanvas(libraryPath, canvas);
}

function assetFromActionOutput(value: unknown): { localPath?: string; path?: string; filename?: string } {
  if (typeof value === "string") return { path: value, filename: basename(value) };
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const path = stringValue(record.localPath) ?? stringValue(record.path) ?? stringValue(record.url) ?? stringValue(record.file) ?? stringValue(record.image) ?? stringValue(record.video) ?? stringValue(record.audio);
  return {
    localPath: stringValue(record.localPath),
    path,
    filename: stringValue(record.filename) ?? (path ? basename(path) : undefined)
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function textFromActionOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const text = record.text ?? record.output ?? record.value;
  return typeof text === "string" ? text : JSON.stringify(value, null, 2);
}

function isCanvasActionPortType(value: string): boolean {
  return value === "image" || value === "video" || value === "audio" || value === "text";
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
  if (extension === ".mp3" || extension === ".wav" || extension === ".ogg" || extension === ".m4a" || extension === ".flac") return "audio";
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
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".flac") return "audio/flac";
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

function stackItemMediaInput(nodePath: string, nodeId: string, type: "video" | "audio", item: ImageStackItem): GenerationMediaInput {
  if (item.externalUrl) return { type, path: item.externalUrl, ref: item.externalUrl, nodeId, mimeType: item.mimeType };
  if (!item.file) throw new Error(`Stack item "${item.id}" does not contain a ${type} source.`);
  const path = resolvePortablePath(nodePath, item.file);
  return { type, path, localPath: path, ref: `@${type}`, nodeId, mimeType: item.mimeType };
}

async function readGeneratedAssetBuffer(path: string, kind: "image" | "video" | "audio"): Promise<Buffer> {
  if (!isRemoteUrl(path)) return readFile(path);
  const response = await fetchWithTimeout(path, 15000, { headers: generatedAssetDownloadHeaders(path) }).catch((error) => {
    throw new Error(`Could not save generated ${kind} in its content folder: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!response.ok) throw new Error(`Could not save generated ${kind} in its content folder: download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

function generatedAssetDownloadHeaders(path: string): Record<string, string> | undefined {
  if (!process.env.OPENROUTER_API_KEY || !isOpenRouterApiUrl(path)) return undefined;
  return { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY.trim()}` };
}

function isOpenRouterApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "openrouter.ai" && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizedAudioExtension(filename: string): ".mp3" | ".wav" | ".ogg" | ".m4a" | ".flac" {
  const extension = extname(filename).toLowerCase();
  if (extension === ".mp3" || extension === ".wav" || extension === ".ogg" || extension === ".m4a" || extension === ".flac") return extension;
  throw new Error("Supported audio formats are .mp3, .wav, .ogg, .m4a, and .flac.");
}

function normalizedGeneratedAudioExtension(filename: string, mimeType?: string): ".mp3" | ".wav" | ".ogg" | ".m4a" | ".flac" {
  try {
    return normalizedAudioExtension(filename);
  } catch {
    if (mimeType === "audio/wav") return ".wav";
    if (mimeType === "audio/ogg") return ".ogg";
    if (mimeType === "audio/mp4") return ".m4a";
    if (mimeType === "audio/flac") return ".flac";
    return ".mp3";
  }
}

function audioMimeTypeFromExtension(extension: string): string {
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".flac") return "audio/flac";
  return "application/octet-stream";
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
  sentMedia: Array<GenerationImageInput | GenerationMediaInput>,
  imageReferenceSyntax: string | undefined
): string {
  const inputById = new Map(inputs.map((entry) => [entry.nodeId, entry]));
  return promptTemplate.replace(/\[\[(text|image|video|audio):([^\]]+)\]\]/g, (_token, type: ConnectedCanvasInputType, nodeId: string) => {
    const input = inputById.get(nodeId);
    if (!input || input.type !== type) return "";
    if (type === "text") return input.text ?? "";
    const media = type === "image" ? input.image : input.media;
    if (!media) return "";
    const position = sentMedia.findIndex((entry) => entry.path === media.path);
    const defaultReferenceSyntax = type === "image" ? "@image {index}" : `@${type} {index}`;
    const referenceSyntax = type === "image" ? imageReferenceSyntax?.trim() || defaultReferenceSyntax : defaultReferenceSyntax;
    return position >= 0 ? referenceSyntax.replaceAll("{index}", String(position + 1)) : "";
  });
}

function resolveTextInputTokens(text: string, inputs: ConnectedCanvasInput[]): string {
  const textById = new Map(
    inputs.filter((entry) => entry.type === "text").map((entry) => [entry.nodeId, entry.text ?? ""])
  );
  if (!textById.size) return text;
  return text.replace(/\[\[text:([^\]]+)\]\]/g, (_token, nodeId: string) => textById.get(nodeId) ?? "");
}

function imageNodeIdsFromPromptTemplate(promptTemplate: string): Set<string> {
  return new Set([...promptTemplate.matchAll(/\[\[image:([^\]]+)\]\]/g)].map((match) => match[1]).filter(Boolean));
}

function imageInputsForPrompt(inputs: ConnectedCanvasInput[], promptTemplate: string): GenerationImageInput[] {
  const promptImageNodeIds = imageNodeIdsFromPromptTemplate(promptTemplate);
  return inputs
    .filter((entry) => entry.image && (promptImageNodeIds.size === 0 || promptImageNodeIds.has(entry.nodeId)))
    .map((entry) => entry.image!);
}

function mediaInputsForPrompt(inputs: ConnectedCanvasInput[], promptTemplate: string): GenerationMediaInput[] {
  const promptMediaNodeIds = new Set([...promptTemplate.matchAll(/\[\[(image|video|audio):([^\]]+)\]\]/g)].map((match) => match[2]).filter(Boolean));
  return inputs
    .filter((entry) => entry.media && (promptMediaNodeIds.size === 0 || promptMediaNodeIds.has(entry.nodeId)))
    .map((entry) => entry.media!);
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

async function polzaAudioRequestBody(model: string, prompt: string, parameters: ImageGenerationSettings, mediaInputs: GenerationMediaInput[] = []): Promise<Record<string, unknown>> {
  const providerModel = polzaAudioProviderModelId(model);
  const isSunoMusic = providerModel === "suno/generate";
  const input: Record<string, unknown> = { prompt: isSunoMusic ? sunoMusicPrompt(prompt, parameters) : prompt };
  const duration = numberSetting(parameters.duration ?? parameters.duration_seconds ?? parameters.durationSeconds);
  if (!isSunoMusic && duration !== undefined) input.duration = String(duration);
  if (!isSunoMusic && parameters.loop !== undefined) input.loop = booleanSetting(parameters.loop);
  if (isSunoMusic) {
    Object.assign(input, sunoMusicInputFields(prompt, parameters));
    const audioInput = await polzaInputAudio(mediaInputs.find((mediaInput) => mediaInput.type === "audio"));
    if (audioInput) input.input_audio = audioInput;
  } else {
    if (mediaInputs.length > 0) throw new Error(`Polza audio model "${providerModel}" does not accept connected media inputs yet.`);
    for (const [paramKey, bodyKey] of [
      ["style", "style"],
      ["lyrics", "lyrics"],
      ["title", "title"],
      ["negative_tags", "negative_tags"],
      ["negativeTags", "negative_tags"],
      ["language", "language"],
      ["tempo", "tempo"],
      ["voice_style", "voice_style"],
      ["voiceStyle", "voice_style"]
    ] as const) {
      const value = stringSetting(parameters[paramKey]);
      if (value) input[bodyKey] = value;
    }
    if (parameters.instrumental !== undefined) input.instrumental = booleanSetting(parameters.instrumental);
  }
  return {
    model: providerModel,
    input,
    async: true,
    user: stringSetting(parameters.user)
  };
}

function polzaAudioProviderModelId(model: string): string {
  return model === "suno/sounds" ? "suno/generate" : model;
}

async function polzaInputAudio(mediaInput: GenerationMediaInput | undefined): Promise<{ data: string; format: "mp3" | "wav" | "flac" | "m4a" } | undefined> {
  if (!mediaInput) return undefined;
  const sourcePath = mediaInput.localPath || mediaInput.path;
  const format = polzaAudioInputFormat(mediaInput.mimeType, sourcePath);
  let bytes: Buffer;
  if (isRemoteUrl(sourcePath)) {
    const response = await fetchWithTimeout(sourcePath, 30000, { headers: generatedAssetDownloadHeaders(sourcePath) });
    if (!response.ok) throw new Error(`Could not read connected audio input (${response.status}).`);
    bytes = Buffer.from(await response.arrayBuffer());
  } else {
    bytes = await readFile(sourcePath);
  }
  return { data: bytes.toString("base64"), format };
}

function polzaAudioInputFormat(mimeType: string | undefined, sourcePath: string): "mp3" | "wav" | "flac" | "m4a" {
  const normalizedMime = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (normalizedMime === "audio/mpeg" || normalizedMime === "audio/mp3") return "mp3";
  if (normalizedMime === "audio/wav" || normalizedMime === "audio/x-wav" || normalizedMime === "audio/wave") return "wav";
  if (normalizedMime === "audio/flac" || normalizedMime === "audio/x-flac") return "flac";
  if (normalizedMime === "audio/mp4" || normalizedMime === "audio/m4a" || normalizedMime === "audio/x-m4a") return "m4a";
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".wav") return "wav";
  if (extension === ".flac") return "flac";
  if (extension === ".m4a" || extension === ".mp4") return "m4a";
  return "mp3";
}

function sunoMusicMode(parameters: ImageGenerationSettings): "simple" | "custom" {
  return stringSetting(parameters.mode)?.toLowerCase() === "simple" ? "simple" : "custom";
}

function sunoMusicInputFields(prompt: string, parameters: ImageGenerationSettings): Record<string, unknown> {
  if (sunoMusicMode(parameters) !== "custom") {
    return parameters.instrumental === undefined ? {} : { instrumental: booleanSetting(parameters.instrumental) };
  }
  const fields: Record<string, unknown> = {};
  const style = sunoMusicStyle(parameters);
  const title = stringSetting(parameters.title);
  const version = stringSetting(parameters.version);
  if (style) fields.style = style;
  fields.title = title || sunoTitleFromPrompt(prompt);
  if (version) fields.version = version;
  return fields;
}

function sunoMusicPrompt(prompt: string, parameters: ImageGenerationSettings): string {
  if (sunoMusicMode(parameters) === "simple") return prompt;
  const lyrics = [prompt.trim(), stringSetting(parameters.lyrics)].filter(Boolean).join("\n\n");
  const additions: string[] = [];
  const negativeTags = stringSetting(parameters.negative_tags ?? parameters.negativeTags);
  const language = stringSetting(parameters.language);
  const tempo = stringSetting(parameters.tempo);
  const voiceStyle = stringSetting(parameters.voice_style ?? parameters.voiceStyle);
  if (language) additions.push(`Language: ${language}`);
  if (tempo) additions.push(`Tempo: ${tempo}`);
  if (voiceStyle) additions.push(`Vocal style: ${voiceStyle}`);
  if (lyrics) additions.push(`Lyrics:\n${lyrics}`);
  if (negativeTags) additions.push(`Avoid: ${negativeTags}`);
  return additions.length ? additions.join("\n") : prompt;
}

function sunoMusicStyle(parameters: ImageGenerationSettings): string | undefined {
  const explicit = stringSetting(parameters.style);
  const parts = [
    explicit,
    stringSetting(parameters.tempo),
    stringSetting(parameters.voice_style ?? parameters.voiceStyle),
    stringSetting(parameters.negative_tags ?? parameters.negativeTags) ? `avoid ${stringSetting(parameters.negative_tags ?? parameters.negativeTags)}` : undefined
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Music";
}

function sunoTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "Untitled";
  return firstLine.slice(0, 80);
}

async function pollPolzaAudioJob(mediaUrl: string, apiKey: string, initial: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (firstMediaAudio(initial)) return initial;
  const initialState = mediaOperationState(initial);
  const jobId = initialState.id;
  if (!jobId || (initialState.status !== "pending" && initialState.status !== "processing")) return initial;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await delay(3000);
    const response = await fetch(`${mediaUrl}/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const status = await providerJson(response, "poll Polza audio generation status");
    const state = mediaOperationState(status).status;
    if (state === "completed" || firstMediaAudio(status)) return status;
    if (state === "failed") throw new Error(`Polza audio generation failed (${jobId}). ${JSON.stringify(status.error ?? status)}`);
  }
  throw new Error(`Polza audio generation timed out (${jobId}).`);
}

function elevenLabsAudioUrl(baseUrl: string, modelId: string, parameters: ImageGenerationSettings): string {
  const outputFormat = elevenLabsOutputFormat(parameters);
  if (modelId === "music_v2") return `${baseUrl}/music?output_format=${encodeURIComponent(outputFormat)}`;
  if (modelId === "eleven_text_to_sound_v2") return `${baseUrl}/sound-generation?output_format=${encodeURIComponent(outputFormat)}`;
  const voiceId = elevenLabsVoiceId(parameters);
  return `${baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
}

function elevenLabsAudioRequestBody(modelId: string, prompt: string, parameters: ImageGenerationSettings): Record<string, unknown> {
  if (modelId === "music_v2") {
    return {
      prompt,
      music_length_ms: Math.round((numberSetting(parameters.duration ?? parameters.duration_seconds ?? parameters.durationSeconds) ?? 30) * 1000),
      model_id: modelId
    };
  }
  if (modelId === "eleven_text_to_sound_v2") {
    const body: Record<string, unknown> = {
      text: prompt,
      model_id: modelId
    };
    const duration = numberSetting(parameters.duration ?? parameters.duration_seconds ?? parameters.durationSeconds);
    if (duration !== undefined) body.duration_seconds = duration;
    if (parameters.loop !== undefined) body.loop = booleanSetting(parameters.loop);
    return body;
  }
  return {
    text: prompt,
    model_id: modelId
  };
}

function elevenLabsOutputFormat(parameters: ImageGenerationSettings): string {
  const format = stringSetting(parameters.output_format ?? parameters.outputFormat ?? parameters.response_format ?? parameters.responseFormat);
  if (format && format.includes("_")) return format;
  if (format === "wav") return "pcm_44100";
  if (format === "pcm") return "pcm_44100";
  return "mp3_44100_128";
}

function elevenLabsVoiceId(parameters: ImageGenerationSettings): string {
  const explicit = stringSetting(parameters.voice_id ?? parameters.voiceId);
  if (explicit) return explicit;
  const voice = stringSetting(parameters.voice);
  if (voice && voice !== "alloy") return voice;
  return process.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim() || "JBFqnCBsd6RMkjVDRZzb";
}

async function providerJson(response: Response, action: string): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(await response.arrayBuffer());
  let parsed: unknown = {};
  try {
    parsed = bytes.length > 0 ? JSON.parse(bytes.toString("utf8")) : {};
  } catch {
    parsed = { data: bytes.toString("utf8") };
  }
  if (!response.ok) throw new Error(`Could not ${action}: ${providerErrorFromParsed(parsed, response)}`);
  if (!parsed || typeof parsed !== "object") throw new Error(`Could not ${action}: invalid provider response.`);
  return parsed as Record<string, unknown>;
}

function providerErrorFromBytes(bytes: Buffer, response: Response): string {
  let parsed: unknown = {};
  try {
    parsed = bytes.length > 0 ? JSON.parse(bytes.toString("utf8")) : {};
  } catch {
    parsed = { error: bytes.toString("utf8") };
  }
  return providerErrorFromParsed(parsed, response);
}

function providerErrorFromParsed(parsed: unknown, response: Response): string {
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const detail = record.detail ?? record.error ?? record.message ?? record.msg;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (Array.isArray(detail)) {
      const messages = detail
        .map((entry) => typeof entry === "string"
          ? entry
          : entry && typeof entry === "object"
            ? stringRecordValue(entry as Record<string, unknown>, "message") ?? stringRecordValue(entry as Record<string, unknown>, "msg") ?? stringRecordValue(entry as Record<string, unknown>, "detail")
            : undefined)
        .filter(Boolean);
      if (messages.length > 0) return messages.join("; ");
      if (detail.length > 0) return JSON.stringify(detail).slice(0, 500);
    }
    if (detail && typeof detail === "object") {
      const message = stringRecordValue(detail as Record<string, unknown>, "message") ?? stringRecordValue(detail as Record<string, unknown>, "detail");
      if (message) return message;
      return JSON.stringify(detail).slice(0, 500);
    }
  }
  return response.statusText || String(response.status);
}

function mediaOperationState(value: unknown): { id?: string; status?: string } {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const id = stringRecordValue(record, "id") ?? stringRecordValue(record, "generation_id") ?? stringRecordValue(record, "job_id");
  const status = stringRecordValue(record, "status")?.toLowerCase();
  if (id || status) return { id, status };
  const text = nestedStatusText(value);
  const pending = /\b(pending|processing)\s*\(\s*([^)]+)\s*\)/i.exec(text);
  return pending ? { status: pending[1].toLowerCase(), id: pending[2].trim() } : {};
}

function nestedStatusText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(nestedStatusText).join(" ");
  if (!value || typeof value !== "object") return "";
  return Object.values(value as Record<string, unknown>).map(nestedStatusText).join(" ");
}

function firstMediaAudio(value: unknown): unknown {
  if (!value) return null;
  if (typeof value === "string") return looksLikeAudioReference(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const audio = firstMediaAudio(item);
      if (audio) return audio;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["url", "audio", "audio_url", "output_url", "file_url", "b64_json", "base64", "data"]) {
    const audio = firstMediaAudio(record[key]);
    if (audio) return audio;
  }
  for (const key of ["audios", "audio_files", "files", "outputs", "result", "results"]) {
    const audio = firstMediaAudio(record[key]);
    if (audio) return audio;
  }
  return null;
}

function firstMediaArtwork(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return looksLikeImageReference(value) ? value.trim() : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = firstMediaArtwork(item);
      if (image) return image;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["cover", "cover_url", "coverUrl", "artwork", "artwork_url", "artworkUrl", "image", "image_url", "imageUrl", "thumbnail", "thumbnail_url", "thumbnailUrl"]) {
    const image = firstMediaArtwork(record[key]);
    if (image) return image;
  }
  for (const key of ["metadata", "meta", "album", "track", "tracks", "files", "outputs", "result", "results", "data"]) {
    const image = firstMediaArtwork(record[key]);
    if (image) return image;
  }
  return undefined;
}

function looksLikeImageReference(value: string): boolean {
  const trimmed = value.trim();
  return /^data:image\//i.test(trimmed)
    || /^https?:\/\//i.test(trimmed) && /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(trimmed);
}

function looksLikeAudioReference(value: string): boolean {
  const trimmed = value.trim();
  return /^data:audio\//i.test(trimmed)
    || /^https?:\/\//i.test(trimmed) && /\.(mp3|wav|ogg|m4a|flac)(\?|#|$)/i.test(trimmed)
    || /^[A-Za-z0-9+/]+=*$/.test(trimmed.slice(0, 80));
}

async function writeGeneratedAudioReference(audio: unknown, options: { provider: string; nodeId: string; modelId: string }): Promise<{ localPath: string; mimeType: string }> {
  if (typeof audio !== "string" || !audio.trim()) throw new Error(`${options.provider} audio response did not include a usable audio URL or base64 payload.`);
  const value = audio.trim();
  let bytes: Buffer;
  let mimeType = "audio/mpeg";
  if (/^https?:\/\//i.test(value)) {
    const response = await fetchWithTimeout(value, 30000);
    if (!response.ok) throw new Error(`Could not download ${options.provider} audio output (${response.status}).`);
    bytes = Buffer.from(await response.arrayBuffer());
    mimeType = response.headers.get("content-type")?.split(";")[0] ?? audioMimeTypeFromUrl(value);
  } else {
    const dataUriMatch = /^data:([^;,]+);base64,(.+)$/i.exec(value);
    if (dataUriMatch) {
      mimeType = dataUriMatch[1];
      bytes = Buffer.from(dataUriMatch[2], "base64");
    } else {
      bytes = Buffer.from(value, "base64");
    }
  }
  const extension = normalizedGeneratedAudioExtension(`${options.modelId}.mp3`, mimeType);
  const localPath = join(await ensureCurrentLibrary(), ".generated", `${options.nodeId}-${Date.now().toString(36)}${extension}`);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, bytes);
  return { localPath, mimeType };
}

function audioMimeTypeFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".wav")) return "audio/wav";
    if (pathname.endsWith(".ogg")) return "audio/ogg";
    if (pathname.endsWith(".m4a")) return "audio/mp4";
    if (pathname.endsWith(".flac")) return "audio/flac";
  } catch {
    return "audio/mpeg";
  }
  return "audio/mpeg";
}

function audioGenerationRunResult(provider: string, modelId: string, localPath: string, mimeType: string, generationId?: string, coverUrl?: string) {
  return {
    status: "succeeded",
    logs: [{ nodeId: "generate", message: `Generated audio with ${provider} ${modelId}`, timestamp: new Date().toISOString() }],
    nodeResults: {
      generate: {
        status: "succeeded",
        error: undefined,
        output: {
          audio: {
            path: localPath,
            localPath,
            filename: `${modelId.split("/").pop() || `${provider}-audio`}${extname(localPath) || ".mp3"}`,
            mimeType,
            coverUrl
          },
          provider,
          model: modelId,
          providerModel: modelId,
          generationId,
          status: "succeeded"
        }
      }
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function stringRecordValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberSetting(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanSetting(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return Boolean(value);
}

function audioResponseFormat(parameters: ImageGenerationSettings): "mp3" {
  const requested = stringSetting(parameters.response_format ?? parameters.responseFormat);
  return requested === "mp3" ? "mp3" : "mp3";
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

