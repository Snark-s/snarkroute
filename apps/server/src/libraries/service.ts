import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { librariesDirectory } from "../server-paths";
import { sanitizeFilename } from "../assets/service";
import { createRouteExecutor } from "../execution/service";

export type LibraryKind = "workspace" | "collection";
export type LibraryContentKind = "mixed" | "image" | "character" | "prompt" | "style";
export type LibraryDefaultView = "canvas" | "grid" | "list";

export interface SnarkLibraryManifest {
  format: "snarkroute.library";
  version: "0.1";
  id: string;
  title: string;
  libraryKind: LibraryKind;
  contentKind: LibraryContentKind;
  defaultView: LibraryDefaultView;
  canvas?: string;
  createdAt: string;
  updatedAt: string;
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

export interface TextNodeView {
  canvas: SnarkCanvasNode;
  manifest: TextNodeManifest;
  activeStackItem: null;
  previewUrl: null;
}

export type NodeView = ImageNodeView | TextNodeView;

export interface ImportImageInput {
  filename: string;
  dataBase64?: string;
  sourcePath?: string;
  dropX: number;
  dropY: number;
  width?: number;
  height?: number;
}

export interface CreateNodeInput {
  type: "image" | "text";
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

export interface GenerateImageNodeInput {
  nodeId: string;
  modelId: string;
  prompt?: string;
  providerId?: string;
}

export interface DuplicateStackItemInput {
  nodeId: string;
  stackItemId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

const manifestFilename = "snark.library.json";
const canvasFilename = "canvas.json";
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
  await writeJson(canvasPath, document);
  if (!manifest.canvas) await writeLibraryManifest(libraryPath, { ...manifest, canvas: canvasFilename, updatedAt: now });
  return document;
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
  return readLibrarySnapshot(libraryPath);
}

export async function generateImageNodeStackItem(input: GenerateImageNodeInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const { manifest, nodePath } = await readImageNode(input.nodeId);
  const activeItem = manifest.stack[manifest.activeStackIndex];
  const inputImages = await connectedImageInputs(libraryPath, input.nodeId);
  const sourceImage = activeItem ? stackItemImageInput(nodePath, activeItem) : undefined;
  const prompt = input.prompt?.trim() || "Create a polished image.";
  const runResult = await runImageModelForStackItem({
    nodeId: input.nodeId,
    modelId: input.modelId,
    providerId: input.providerId,
    prompt,
    sourceImage,
    inputImages
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
  const externalUrl = !generatedImage.localPath && isRemoteUrl(generatedPath) ? generatedPath : undefined;
  if (!externalUrl) {
    await mkdir(dirname(resolvePortablePath(nodePath, imageRelativePath)), { recursive: true });
    await copyFile(generatedPath, resolvePortablePath(nodePath, imageRelativePath));
  }

  const now = new Date().toISOString();
  const updatedManifest: ImageNodeManifest = {
    ...manifest,
    stack: [...manifest.stack, {
      id: `stack_${shortId()}`,
      file: externalUrl ? undefined : imageRelativePath,
      externalUrl,
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
  return readLibrarySnapshot(libraryPath);
}

async function runImageModelForStackItem(input: { nodeId: string; modelId: string; providerId?: string; prompt: string; sourceImage?: { path: string; localPath?: string; mimeType: string }; inputImages: Array<{ path: string; localPath?: string; mimeType: string }> }) {
  const nodeType = input.providerId === "polza" ? "polza.image.generate" : "ai.image.generate";
  const executor = await createRouteExecutor();
  const images = [
    ...input.inputImages,
    ...(input.sourceImage ? [input.sourceImage] : [])
  ].filter((image, index, all) => all.findIndex((candidate) => candidate.path === image.path) === index);
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
      params: {
        model: input.modelId,
        providerMode: input.providerId === "openrouter" ? "openrouter" : "auto",
        prompt: input.prompt,
        images,
        aspectRatio: "16:9",
        imageSize: "1K",
        imageResolution: "1K",
        quality: "high",
        outputFormat: "png"
      }
    }],
    edges: []
  };
  return executor.executeRoute(route);
}

async function connectedImageInputs(libraryPath: string, targetNodeId: string): Promise<Array<{ path: string; localPath?: string; mimeType: string }>> {
  const canvas = await ensureCanvas(libraryPath);
  const sourceNodeIds = (canvas.edges ?? []).filter((edge) => edge.toNodeId === targetNodeId).map((edge) => edge.fromNodeId);
  const images: Array<{ path: string; localPath?: string; mimeType: string }> = [];
  for (const sourceNodeId of sourceNodeIds) {
    const sourceNode = canvas.nodes.find((node) => node.id === sourceNodeId);
    if (sourceNode?.type !== "image") continue;
    const { manifest, nodePath } = await readImageNode(sourceNodeId);
    const item = manifest.stack[manifest.activeStackIndex];
    if (!item) continue;
    images.push(stackItemImageInput(nodePath, item));
  }
  return images;
}

function imageAssetFromGenerationOutput(output: unknown): { localPath?: string; path?: string; filename?: string; mimeType?: string; width?: unknown; height?: unknown } {
  if (!output || typeof output !== "object") throw new Error("Image generation returned no output.");
  const record = output as Record<string, unknown>;
  const image = record.image;
  if (!image || typeof image !== "object") throw new Error("Image generation returned no image asset.");
  return image as { localPath?: string; path?: string; filename?: string; mimeType?: string; width?: unknown; height?: unknown };
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

export async function createEmptyCanvasNode(input: CreateNodeInput): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const now = new Date().toISOString();
  const id = `${input.type}_${shortId()}`;
  const width = input.width ?? defaultNodeWidth;
  const height = input.height ?? defaultNodeHeight;
  const nodeRelativePath = portableJoin(
    input.type === "image" ? "image-nodes" : "text-nodes",
    `${input.type}-${id}.${input.type === "image" ? "imgnode" : "txtnode"}`
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

export async function renameCanvasNode(nodeId: string, title: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  const canvasNode = canvas.nodes.find((node) => node.id === nodeId);
  if (!canvasNode) throw new Error(`Node "${nodeId}" was not found.`);
  const manifestPath = join(resolvePortablePath(libraryPath, canvasNode.nodePath), "snark.node.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest | TextNodeManifest;
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
  // Keep the node folder on disk so local undo can restore the canvas entry.
  // Orphan cleanup should be a separate explicit maintenance action.
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
}

export async function deleteCanvasEdge(edgeId: string): Promise<LibrarySnapshot> {
  const libraryPath = await ensureCurrentLibrary();
  const canvas = await ensureCanvas(libraryPath);
  canvas.edges = (canvas.edges ?? []).filter((edge) => edge.id !== edgeId);
  await writeCanvas(libraryPath, canvas);
  return readLibrarySnapshot(libraryPath);
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
    if (manifest.id === nodeId) return { manifest, nodePath };
  }
  throw new Error(`Image node "${nodeId}" was not found.`);
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
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageNodeManifest | TextNodeManifest;
    if (manifest.type === "image") {
      const activeStackItem = manifest.stack[manifest.activeStackIndex] ?? null;
      nodes.push({
        canvas: canvasNode,
        manifest,
        activeStackItem,
        previewUrl: activeStackItem ? `/api/libraries/current/image-nodes/${encodeURIComponent(manifest.id)}/stack/${encodeURIComponent(activeStackItem.id)}` : null
      });
    }
    if (manifest.type === "text") {
      nodes.push({ canvas: canvasNode, manifest, activeStackItem: null, previewUrl: null });
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

function normalizedImageExtension(filename: string): ".png" | ".jpg" | ".jpeg" | ".webp" {
  const extension = extname(filename).toLowerCase();
  if (extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".webp") return extension;
  throw new Error("Supported image formats are .png, .jpg, .jpeg, and .webp.");
}

function stackItemImageInput(nodePath: string, item: ImageStackItem): { path: string; localPath?: string; mimeType: string } {
  if (item.externalUrl) return { path: item.externalUrl, mimeType: item.mimeType };
  if (!item.file) throw new Error(`Stack item "${item.id}" does not contain an image source.`);
  const path = resolvePortablePath(nodePath, item.file);
  return { path, localPath: path, mimeType: item.mimeType };
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

function mimeTypeFromExtension(extension: string): string {
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
