import type { PromptLibraryPrompt } from "@snarkroute/nodes";

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
  kind?: "representation" | "crop" | "imageCorrection" | "canvasAction" | "collectionItem";
  actionId?: string;
  correction?: ImageCorrectionSettings;
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
  selectedStackItemIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageCorrectionSettings {
  black: number;
  midpoint: number;
  white: number;
  shadowCurve: number;
  highlightCurve: number;
  brightness: number;
  contrast: number;
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
  selectedStackItemIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AudioNodeManifest {
  format: "snarkroute.node";
  version: "0.1";
  id: string;
  type: "audio";
  title: string;
  currentPrompt?: string;
  modelId?: string;
  executionProvider?: string;
  fallbackAllowed?: boolean;
  stack: ImageStackItem[];
  activeStackIndex: number;
  selectedStackItemIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TextNodeManifest {
  format: "snarkroute.node";
  version: "0.1";
  id: string;
  type: "text";
  variant?: "note";
  title: string;
  text: string;
  inputMode?: "text" | "dialogue";
  stackPath?: string;
  selectedStackItemId?: string;
  selectedStackItemIds?: string[];
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
  coverUrl?: string;
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

export type TextNodeConversationPart =
  | { type: "text"; text: string }
  | { type: "image"; file: string; alt?: string };

export interface TextNodeConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  content: TextNodeConversationPart[];
  model?: { modelId: string; providerId?: string };
}

export interface TextNodeConversation {
  version: 1;
  conversationId: string;
  messages: TextNodeConversationMessage[];
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

export interface LibraryProjectRegistry {
  version: 1;
  currentProjectPath?: string;
  projects: LibraryProjectRegistryEntry[];
}

export interface LibraryProjectRegistryEntry {
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

export interface AudioNodeView {
  canvas: SnarkCanvasNode;
  manifest: AudioNodeManifest;
  activeStackItem: ImageStackItem | null;
  previewUrl: string | null;
}

export interface TextNodeView {
  canvas: SnarkCanvasNode;
  manifest: TextNodeManifest;
  stack: TextStackItem[];
  conversation: TextNodeConversation;
  activeStackItem: TextStackItem | null;
  outputText: string;
  previewUrl: string | null;
}

export interface CollectionNodeManifest {
  format: "snarkroute.node";
  version: "0.1";
  id: string;
  type: "collection";
  title: string;
  items?: CollectionNodeStoredItem[];
  createdAt: string;
  updatedAt: string;
}

export interface CollectionNodeStoredItem {
  id: string;
  type: "image" | "video" | "audio" | "text";
  sourceNodeId: string;
  stackItemId?: string;
  title: string;
  file: string;
  mimeType: string;
  text?: string;
  manual?: boolean;
}

export interface CollectionNodeItem extends CollectionNodeStoredItem {
  previewUrl?: string;
}

export interface LibraryNodeView {
  canvas: SnarkCanvasNode;
  manifest: LibraryNodeManifest;
  scan: LocalLibraryScanResult;
  activeStackItem: null;
  previewUrl: string | null;
}

export interface CollectionNodeView {
  canvas: SnarkCanvasNode;
  manifest: CollectionNodeManifest;
  items: CollectionNodeItem[];
  activeStackItem: null;
  previewUrl: null;
}

export type NodeView = ImageNodeView | VideoNodeView | AudioNodeView | TextNodeView | LibraryNodeView | CollectionNodeView;

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
export interface ImportAudioInput extends ImportImageInput {}

export interface ImportTextInput {
  filename: string;
  text: string;
  dropX: number;
  dropY: number;
  width?: number;
  height?: number;
  connectFromNodeId?: string;
}

export interface CreateNodeInput {
  type: "image" | "video" | "audio" | "text" | "collection";
  variant?: "note";
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
export interface AppendAudioStackInput extends AppendImageStackInput {}

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
export interface GenerateAudioNodeInput extends GenerateImageNodeInput {}

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

export interface TextNodeConversationAttachmentInput {
  nodeId?: string;
  file?: string;
  alt?: string;
}

export interface AppendTextNodeConversationMessageInput {
  nodeId: string;
  role: "user" | "system";
  content?: string | TextNodeConversationPart[];
  attachments?: TextNodeConversationAttachmentInput[];
}

export interface RunTextNodeConversationTurnInput extends Omit<GenerateTextNodeInput, "prompt"> {
  prompt?: string;
  attachments?: TextNodeConversationAttachmentInput[];
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

export interface RunCanvasNodeActionInput {
  nodeId: string;
  actionId: string;
  targetNodeId?: string;
  params?: Record<string, unknown>;
  phase?: "prepare" | "complete";
  reuse?: boolean;
  continuationId?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface CanvasActionPrepareResult {
  continuationId: string;
  previews: Array<{ kind: "panorama360" | "splat"; src: string }>;
}

export interface DuplicateCanvasNodeInput {
  nodeId: string;
  x: number;
  y: number;
}

export interface DuplicateCanvasNodeAsRepresentationInput extends DuplicateCanvasNodeInput {
  type: "image" | "video" | "audio" | "text";
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
  stackKind: "image" | "text" | "video" | "audio";
  dropX: number;
  dropY: number;
  width?: number;
  height?: number;
}

