import "./styles.css";
import { ArrowUp, ChevronLeft, ChevronRight, Clipboard, Cog, Copy, Crop, Download, Expand, ExternalLink, FileDown, FileUp, Folder, FolderPlus, ImageIcon, ImagePlus, Layers3, Moon, PanelRight, RefreshCw, Save, Sun, Trash2, Video, Wallpaper, Wrench } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  fallbackModels,
  generationParameterSummary,
  loadModelCatalog,
  mergeModelsForDisplay,
  mergeProviderAndUserDefinedPickerModels,
  modelMatchesCatalogGroup,
  modelGenerationParameters,
  modelImageInputLimit,
  modelSelectionId,
  modelsCompatibleWithNodeInputs,
  modelsForContentKind,
  modelsForPickerContentKind,
  pickerContentKind,
  providerDisplayName,
  type ContentKind,
  type GenerationParameterValue,
  type ImageGenerationParameters,
  type ModelOption,
  type ModelParameterDefinition,
  type ModelRole,
  type ModelRouteSelection,
  type ProviderSettings
} from "./modelCatalog";
import { modelLogoForCatalogOption } from "./modelLogos";

type ThemeName = "day" | "night";
type BackgroundName = "plain" | "dots" | "grid" | "gears";
type LibraryViewMode = "media-folder" | "image-stack" | "text-library" | "prompt-library" | "board" | "workflow";

interface LibrarySnapshot {
  manifest: LibraryManifest;
  path: string;
  nestedLibraries: NestedLibrary[];
  canvas: CanvasDocument | null;
  nodes: NodeView[];
}

interface ProjectSummary {
  id: string;
  title: string;
  path: string;
  coverUrl: string | null;
  current: boolean;
}

interface ProjectListResponse {
  projects: ProjectSummary[];
}

interface ProjectMutationResponse {
  projects: ProjectSummary[];
  current: LibrarySnapshot;
}

interface ProjectImageSummary {
  id: string;
  title: string;
  url: string;
}

interface ProjectImagesResponse {
  images: ProjectImageSummary[];
}

interface LibraryManifest {
  id: string;
  title: string;
  libraryKind: string;
  contentKind: string;
  defaultView: string;
  canvas?: string;
}

interface NestedLibrary {
  id: string;
  title: string;
  path: string;
  libraryKind: string;
  contentKind: string;
  defaultView: string;
  hasCanvas: boolean;
}

interface CanvasDocument {
  nodes: CanvasNode[];
  edges?: CanvasEdge[];
}

interface CanvasNode {
  id: string;
  type: string;
  nodePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind?: "representation" | "crop";
  note?: string;
}

interface ImageNodeView {
  canvas: CanvasNode;
  manifest: ImageNodeManifest;
  activeStackItem: ImageStackItem | null;
  previewUrl: string | null;
}

interface ImageNodeManifest {
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
}

interface VideoNodeManifest {
  id: string;
  type: "video";
  title: string;
  currentPrompt?: string;
  modelId?: string;
  executionProvider?: string;
  fallbackAllowed?: boolean;
  stack: ImageStackItem[];
  activeStackIndex: number;
}

interface TextNodeManifest {
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
}

interface ImageStackItem {
  id: string;
  file?: string;
  externalUrl?: string;
  source: string;
  width: number;
  height: number;
}

interface TextStackItem {
  id: string;
  file: string;
  title: string;
  text: string;
  source: "prompt" | "text";
  mimeType: string;
  previewFile?: string;
}

interface VideoNodeView {
  canvas: CanvasNode;
  manifest: VideoNodeManifest;
  activeStackItem: ImageStackItem | null;
  previewUrl: string | null;
}

interface ContentContextMenu {
  x: number;
  y: number;
  nodeId: string;
  kind: "text" | "image" | "video";
}

interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CropDraft {
  sourceNodeId: string;
  cropNodeId?: string;
  title: string;
  src: string;
  rect: CropRect;
  aspectRatio: number | null;
}

interface CropMetadata {
  sourceNodeId: string;
  rect: CropRect;
  aspectRatio?: number | null;
}

interface LocalLibraryAsset {
  id: string;
  relativePath: string;
  title: string;
  kind: "image" | "video" | "audio" | "text" | "prompt" | "file";
  mimeType: string;
  embeddedPrompt?: {
    title: string;
    category: string;
    text: string;
    negativePrompt?: string;
    tags?: string[];
    source?: Record<string, unknown>;
    modelHints?: string[];
  };
}

interface LocalLibraryScanResult {
  sourcePath: string;
  title: string;
  description?: string;
  availableViews: LibraryViewMode[];
  assets: LocalLibraryAsset[];
  prompts: LocalLibraryAsset["embeddedPrompt"][];
  entryBoard?: string;
  entryWorkflow?: string;
  error?: string;
}

interface LibraryNodeManifest {
  id: string;
  type: "library";
  title: string;
  sourcePath: string;
  viewMode: LibraryViewMode;
}

interface LibraryNodeView {
  canvas: CanvasNode;
  manifest: LibraryNodeManifest;
  scan: LocalLibraryScanResult;
  activeStackItem: null;
  previewUrl: string | null;
}

type NodeView = ImageNodeView | VideoNodeView | TextNodeView | LibraryNodeView;
type EditableNodeView = ImageNodeView | VideoNodeView | TextNodeView;

interface TextNodeView {
  canvas: CanvasNode;
  manifest: TextNodeManifest;
  stack: TextStackItem[];
  activeStackItem: TextStackItem | null;
  outputText: string;
  previewUrl: string | null;
}

interface CanvasViewport {
  x: number;
  y: number;
  scale: number;
}

type DragState =
  | {
      kind: "canvas";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startPanX: number;
      startPanY: number;
      startScale: number;
    }
  | {
      kind: "node";
      pointerId: number;
      nodeId: string;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
      groupStartPositions?: { id: string; x: number; y: number }[];
    }
  | {
      kind: "connection";
      pointerId: number;
      direction: "fromOutput" | "fromInput";
      fromNodeId: string;
      toNodeId?: string;
      startX: number;
      startY: number;
      currentX: number;
      currentY: number;
    }
  | {
      kind: "stackItem";
      pointerId: number;
      nodeId: string;
      stackItemId: string;
      startClientX: number;
      startClientY: number;
      currentX: number;
      currentY: number;
    }
  | {
      kind: "selection";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      currentClientX: number;
      currentClientY: number;
      startX: number;
      startY: number;
      currentX: number;
      currentY: number;
    };

interface NodeCreateMenu {
  x: number;
  y: number;
  worldX: number;
  worldY: number;
  fromNodeId?: string;
}

interface InputNodeChip {
  id: string;
  title: string;
  type: string;
  text?: string;
  previewUrl: string | null;
  width?: number;
  height?: number;
  color?: string;
  activeStackIndex?: number;
}

interface StackItemMenu {
  x: number;
  y: number;
  nodeId: string;
  stackItemId: string;
}

interface LibraryAssetMenu {
  x: number;
  y: number;
  nodeId: string;
  assetId: string;
}

interface ProjectMenu {
  x: number;
  y: number;
  project: ProjectSummary;
}

interface CoverPickerState {
  project: ProjectSummary;
  images: ProjectImageSummary[];
}

interface SelectionMenu {
  x: number;
  y: number;
  nodeId: string;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}

interface FileSystemWritableFileStream {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface GenerationFeedback {
  busy: boolean;
  message: string;
  error?: boolean;
}

type ProviderId = "polza" | "openrouter" | "gemini" | "replicate" | "seedance" | "openai";
type NodeRepresentationType = "image" | "video" | "text";

interface ProviderDefinition {
  id: ProviderId;
  title: string;
  capabilityText: string;
  settingsEndpoint: string;
  keyField: string;
  testEndpoint?: string;
  refreshModels?: boolean;
}

interface LocalProviderConnection {
  id: string;
  title: string;
  endpointUrl: string;
  providerType: string;
  status: "saved" | "connected" | "error";
  statusReason?: string;
  models?: Array<{ id?: string; title?: string; modelName?: string }>;
}

const providerDefinitions: ProviderDefinition[] = [
  { id: "polza", title: "Polza", capabilityText: "Image generation catalog", settingsEndpoint: "/api/settings/polza-token", keyField: "polzaAiApiKey", refreshModels: true },
  { id: "openrouter", title: "OpenRouter", capabilityText: "Text and multimodal routed models", settingsEndpoint: "/api/settings/openrouter", keyField: "openRouterApiKey", testEndpoint: "/api/providers/openrouter/test", refreshModels: true },
  { id: "gemini", title: "Gemini", capabilityText: "Image generation / multimodal", settingsEndpoint: "/api/settings/gemini-token", keyField: "geminiApiKey" },
  { id: "replicate", title: "Replicate", capabilityText: "Hosted model endpoints", settingsEndpoint: "/api/settings/replicate-token", keyField: "replicateApiToken" },
  { id: "seedance", title: "Seedance", capabilityText: "Video generation endpoints", settingsEndpoint: "/api/settings/seedance-token", keyField: "seedanceApiKey", testEndpoint: "/api/providers/seedance/test" },
  { id: "openai", title: "OpenAI", capabilityText: "Model API connection", settingsEndpoint: "/api/settings/openai-token", keyField: "openAiApiKey" }
];

declare global {
  interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  }
}

const apiBase = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:4317";
const themeStorageKey = "snarkroute.theme";
const backgroundStorageKey = "snarkroute.canvasBackground";
const imageNodeWidth = 320;
const imageNodeHeight = 240;
const nodeTitleHeight = 24;
const textNodeBaseHeight = 180;
const activePromptHeight = 250;
const passiveFooterHeight = 42;
const minCanvasScale = 0.35;
const maxCanvasScale = 2.5;
const busyFaviconFrames = Array.from({ length: 8 }, (_, index) => busyFavicon(index * 45));
const backgroundOptions: { value: BackgroundName; label: string }[] = [
  { value: "plain", label: "Plain" },
  { value: "dots", label: "Dots" },
  { value: "grid", label: "Grid" },
  { value: "gears", label: "Gears" }
];
const nodeRepresentationOptions: Array<{ type: NodeRepresentationType; label: string }> = [
  { type: "image", label: "Image" },
  { type: "video", label: "Video" },
  { type: "text", label: "Text" }
];
function App() {
  const contentMenuRef = useRef<HTMLDivElement | null>(null);
  const [theme, setTheme] = useStoredSetting<ThemeName>(themeStorageKey, "night", ["day", "night"]);
  const [background, setBackground] = useStoredSetting<BackgroundName>(backgroundStorageKey, "gears", backgroundOptions.map((option) => option.value));
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("Opening local library...");
  const [isDragging, setIsDragging] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [viewport, setViewport] = useStoredJsonSetting<CanvasViewport>("snarkroute.canvasViewport", { x: 0, y: 0, scale: 1 });
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [nodeCreateMenu, setNodeCreateMenu] = useState<NodeCreateMenu | null>(null);
  const [previewImage, setPreviewImage] = useState<{ nodeId: string; title: string; index: number } | null>(null);
  const [cropDraft, setCropDraft] = useState<CropDraft | null>(null);
  const [openStackNodeId, setOpenStackNodeId] = useState<string | null>(null);
  const [stackItemMenu, setStackItemMenu] = useState<StackItemMenu | null>(null);
  const [contentMenu, setContentMenu] = useState<ContentContextMenu | null>(null);
  const [libraryAssetMenu, setLibraryAssetMenu] = useState<LibraryAssetMenu | null>(null);
  const [projectMenu, setProjectMenu] = useState<ProjectMenu | null>(null);
  const [coverPicker, setCoverPicker] = useState<CoverPickerState | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null);
  const [copiedNodeId, setCopiedNodeId] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>(fallbackModels);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [providerErrors, setProviderErrors] = useState<Partial<Record<string, string>>>({});
  const [providerNotice, setProviderNotice] = useState<Partial<Record<string, string>>>({});
  const [customModels, setCustomModels] = useStoredJsonSetting<ModelOption[]>("snarkroute.customModels", []);
  const [localProviders, setLocalProviders] = useStoredJsonSetting<LocalProviderConnection[]>("snarkroute.localProviders", []);
  const [modelSearchNodeId, setModelSearchNodeId] = useState<string | null>(null);
  const [modelSelections, setModelSelections] = useStoredJsonSetting<Record<string, string | ModelRouteSelection>>("snarkroute.nodeModels", {});
  const [generationFeedback, setGenerationFeedback] = useState<Record<string, GenerationFeedback>>({});
  const [edgeNoteDraft, setEdgeNoteDraft] = useState("");
  const generationRunning = Object.values(generationFeedback).some((feedback) => feedback.busy);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const interactionMovedRef = useRef(false);
  const undoStackRef = useRef<CanvasDocument[]>([]);
  const libraryMutationSeqRef = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const edge = (library?.canvas?.edges ?? []).find((candidate) => candidate.id === selectedEdgeId);
    setEdgeNoteDraft(edge?.note ?? "");
  }, [library?.canvas?.edges, selectedEdgeId]);

  useEffect(() => {
    void refreshLibrary();
  }, []);

  useEffect(() => {
    function refreshAfterExternalChange() {
      if (document.visibilityState === "visible") void refreshLibraryContents();
    }
    window.addEventListener("focus", refreshAfterExternalChange);
    document.addEventListener("visibilitychange", refreshAfterExternalChange);
    return () => {
      window.removeEventListener("focus", refreshAfterExternalChange);
      document.removeEventListener("visibilitychange", refreshAfterExternalChange);
    };
  }, []);

  useEffect(() => {
    void refreshModelsAndProviders(true);
  }, []);

  useEffect(() => {
    void refreshSavedLocalModelCatalogs();
  }, []);

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      const file = [...(event.clipboardData?.files ?? [])].find((item) => /\.(png|jpe?g|webp)$/i.test(item.name) || /^image\/(png|jpeg|webp)$/i.test(item.type));
      if (!file) return;
      event.preventDefault();
      void importImageFileAt(file, viewportCenterWorldPoint());
    }

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [library, viewport]);

  const nodes = useMemo(() => library?.nodes ?? [], [library]);
  const edges = library?.canvas?.edges ?? [];
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.canvas.id, node])), [nodes]);
  const availableCatalogModels = useMemo(() => availableModels, [availableModels]);
  const pickerCatalogModels = useMemo(() => mergeProviderAndUserDefinedPickerModels(availableCatalogModels, customModels), [availableCatalogModels, customModels]);
  const viewportScale = viewport.scale ?? 1;

  function beginLibraryMutation(): number {
    libraryMutationSeqRef.current += 1;
    return libraryMutationSeqRef.current;
  }

  function applyLibrarySnapshot(snapshot: LibrarySnapshot, mutationSeq?: number): boolean {
    if (mutationSeq !== undefined && mutationSeq < libraryMutationSeqRef.current) return false;
    setLibrary(snapshot);
    return true;
  }

  useEffect(() => {
    if (!dragState) return;
    const activeDrag = dragState;

    function handlePointerMove(event: PointerEvent) {
      if (event.pointerId !== activeDrag.pointerId) return;
      if (activeDrag.kind === "stackItem") {
        const moved = Math.hypot(event.clientX - activeDrag.startClientX, event.clientY - activeDrag.startClientY) > 6;
        if (moved) interactionMovedRef.current = true;
        const point = screenToWorld(event.clientX, event.clientY);
        setDragState({ ...activeDrag, currentX: point.x, currentY: point.y });
        return;
      }
      if (activeDrag.kind === "selection") {
        interactionMovedRef.current = true;
        const point = screenToWorld(event.clientX, event.clientY);
        setDragState({
          ...activeDrag,
          currentClientX: event.clientX,
          currentClientY: event.clientY,
          currentX: point.x,
          currentY: point.y
        });
        return;
      }
      if (activeDrag.kind === "connection") {
        interactionMovedRef.current = true;
        const point = screenToWorld(event.clientX, event.clientY);
        setDragState({ ...activeDrag, currentX: point.x, currentY: point.y });
        return;
      }
      if (activeDrag.kind === "canvas") {
        interactionMovedRef.current = true;
        setViewport({
          x: activeDrag.startPanX + event.clientX - activeDrag.startClientX,
          y: activeDrag.startPanY + event.clientY - activeDrag.startClientY,
          scale: activeDrag.startScale
        });
        return;
      }

      interactionMovedRef.current = true;
      const dx = (event.clientX - activeDrag.startClientX) / viewportScale;
      const dy = (event.clientY - activeDrag.startClientY) / viewportScale;
      if (activeDrag.groupStartPositions?.length) {
        updateNodePositions(activeDrag.groupStartPositions.map((node) => ({
          id: node.id,
          x: Math.round(node.x + dx),
          y: Math.round(node.y + dy)
        })));
      } else {
        updateNodePosition(
          activeDrag.nodeId,
          Math.round(activeDrag.startX + dx),
          Math.round(activeDrag.startY + dy)
        );
      }
    }

    function handlePointerUp(event: PointerEvent) {
      if (event.pointerId !== activeDrag.pointerId) return;
      if (activeDrag.kind === "node") {
        const dx = (event.clientX - activeDrag.startClientX) / viewportScale;
        const dy = (event.clientY - activeDrag.startClientY) / viewportScale;
        if (activeDrag.groupStartPositions?.length) {
          void persistNodePositions(activeDrag.groupStartPositions.map((node) => ({
            id: node.id,
            x: Math.round(node.x + dx),
            y: Math.round(node.y + dy)
          })));
        } else {
          void persistNodePosition(
            activeDrag.nodeId,
            Math.round(activeDrag.startX + dx),
            Math.round(activeDrag.startY + dy)
          );
        }
      }
      if (activeDrag.kind === "connection") {
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const input = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-node-input-id]") : null;
        const output = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-node-output-id]") : null;
        const toNodeId = input?.dataset.nodeInputId;
        const fromNodeId = output?.dataset.nodeOutputId;
        if (activeDrag.direction === "fromOutput" && toNodeId && toNodeId !== activeDrag.fromNodeId) {
          void addCanvasEdge(activeDrag.fromNodeId, toNodeId);
        } else if (activeDrag.direction === "fromInput" && fromNodeId && fromNodeId !== activeDrag.toNodeId) {
          void addCanvasEdge(fromNodeId, activeDrag.toNodeId ?? activeDrag.fromNodeId);
        } else {
          const point = screenToWorld(event.clientX, event.clientY);
          if (activeDrag.direction === "fromOutput") {
            setNodeCreateMenu({
              x: event.clientX,
              y: event.clientY,
              worldX: point.x,
              worldY: point.y,
              fromNodeId: activeDrag.fromNodeId
            });
          }
        }
      }
      if (activeDrag.kind === "stackItem") {
        const point = screenToWorld(event.clientX, event.clientY);
        if (interactionMovedRef.current && isPointInsideCanvas(event.clientX, event.clientY)) {
          void duplicateStackItemNode(activeDrag.nodeId, activeDrag.stackItemId, point);
        }
      }
      if (activeDrag.kind === "selection") {
        const bounds = normalizedRect(activeDrag.startX, activeDrag.startY, activeDrag.currentX, activeDrag.currentY);
        const selected = nodes.filter((node) => rectIntersects(bounds, node.canvas)).map((node) => node.canvas.id);
        setSelectedNodeIds(selected);
        setSelectedNodeId(selected[selected.length - 1] ?? null);
      }
      setDragState(null);
    }

    function handlePointerCancel(event: PointerEvent) {
      if (event.pointerId !== activeDrag.pointerId) return;
      interactionMovedRef.current = false;
      setDragState(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [dragState, library, viewport, viewportScale, nodes]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") {
        if (isTextEditingTarget(event.target)) return;
        event.preventDefault();
        void undoCanvas();
        return;
      }
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isTextEditingTarget(event.target)) return;
      if (selectedNodeId) {
        event.preventDefault();
        void deleteSelectedNodes(selectedNodeIds.length ? selectedNodeIds : [selectedNodeId]);
        return;
      }
      if (selectedEdgeId) {
        event.preventDefault();
        void deleteSelectedEdge(selectedEdgeId);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedNodeId, selectedNodeIds, selectedEdgeId]);

  useEffect(() => {
    function closeFloatingMenus(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest(".stackItemMenu, .contentMenu, .nodeCreateMenu, .selectionMenu, .projectMenu, .stackBoard, .modelMenu")) return;
      setStackItemMenu(null);
      setContentMenu(null);
      setSelectionMenu(null);
      setProjectMenu(null);
    }

    window.addEventListener("pointerdown", closeFloatingMenus);
    return () => window.removeEventListener("pointerdown", closeFloatingMenus);
  }, []);

  useEffect(() => {
    if (!contentMenu) return;
    const animationFrame = window.requestAnimationFrame(() => contentMenuRef.current?.focus());
    function closeOnFocusOutside(event: FocusEvent) {
      const target = event.target;
      if (target instanceof Node && contentMenuRef.current?.contains(target)) return;
      setContentMenu(null);
    }

    window.addEventListener("focusin", closeOnFocusOutside, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("focusin", closeOnFocusOutside, true);
    };
  }, [contentMenu]);

  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) return;
    const initialHref = icon.getAttribute("href") ?? "/snarkroute-icon.png";
    const initialType = icon.getAttribute("type");
    if (!generationRunning) {
      icon.href = initialHref;
      if (initialType) icon.type = initialType;
      return;
    }

    let frame = 0;
    icon.type = "image/svg+xml";
    icon.href = busyFaviconFrames[frame];
    const timer = window.setInterval(() => {
      frame = (frame + 1) % busyFaviconFrames.length;
      icon.href = busyFaviconFrames[frame];
    }, 120);
    return () => {
      window.clearInterval(timer);
      icon.href = initialHref;
      if (initialType) icon.type = initialType;
    };
  }, [generationRunning]);

  const connectionPreview = dragState?.kind === "connection" ? dragState : null;

  async function refreshLibrary() {
    try {
      setLoading(true);
      const [snapshot, projectList] = await Promise.all([
        apiGet<LibrarySnapshot>("/api/libraries/current"),
        apiGet<ProjectListResponse>("/api/libraries/projects")
      ]);
      applyLibrarySnapshot(snapshot);
      setProjects(projectList.projects);
      setStatus(snapshot.canvas ? "Canvas ready" : "Library has no canvas");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open local library.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshModelsAndProviders(refreshConnectedCatalogs = false) {
    try {
      const settings = await apiGet<ProviderSettings>("/api/settings");
      setProviderSettings(settings);
      const refreshErrors: Partial<Record<string, string>> = {};
      if (refreshConnectedCatalogs && settings.openrouter?.configured) {
        try {
          await apiPost("/api/providers/openrouter/refresh-model-catalog", {});
        } catch (error) {
          refreshErrors.openrouter = error instanceof Error ? error.message : "Catalog refresh failed.";
        }
      }
      const catalog = await loadModelCatalog(apiGet, settings);
      setAvailableModels(catalog.availableModels);
      setProviderErrors({ ...catalog.errors, ...refreshErrors });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load model sources.";
      setProviderErrors({ settings: message });
      setAvailableModels(fallbackModels);
    }
  }

  async function saveProviderToken(providerId: ProviderId, key: string, extras?: Record<string, string>) {
    const config = providerDefinitions.find((provider) => provider.id === providerId);
    if (!config || !key.trim()) return;
    try {
      await apiPost(config.settingsEndpoint, { [config.keyField]: key.trim(), ...(extras ?? {}) });
      let refreshWarning = "";
      if (providerId === "openrouter") {
        try {
          await apiPost("/api/providers/openrouter/refresh-model-catalog", {});
        } catch (error) {
          refreshWarning = error instanceof Error ? ` Catalog refresh failed: ${error.message}` : " Catalog refresh failed.";
        }
      }
      setProviderNotice((current) => ({ ...current, [providerId]: `Connection saved locally.${refreshWarning}` }));
      await refreshModelsAndProviders();
    } catch (error) {
      setProviderErrors((current) => ({ ...current, [providerId]: error instanceof Error ? error.message : "Connection failed." }));
    }
  }

  async function testProvider(providerId: ProviderId) {
    const config = providerDefinitions.find((provider) => provider.id === providerId);
    if (!config?.testEndpoint) {
      setProviderNotice((current) => ({ ...current, [providerId]: "Live connection test is not exposed by the server yet." }));
      return;
    }
    try {
      await apiPost(config.testEndpoint, {});
      setProviderNotice((current) => ({ ...current, [providerId]: "Connection test passed." }));
      setProviderErrors((current) => ({ ...current, [providerId]: undefined }));
    } catch (error) {
      setProviderErrors((current) => ({ ...current, [providerId]: error instanceof Error ? error.message : "Test failed." }));
    }
  }

  async function refreshProviderModels(providerId: ProviderId) {
    try {
      if (providerId === "openrouter") await apiPost("/api/providers/openrouter/refresh-model-catalog", {});
      await refreshModelsAndProviders();
      setProviderNotice((current) => ({ ...current, [providerId]: "Model catalog refreshed." }));
    } catch (error) {
      setProviderErrors((current) => ({ ...current, [providerId]: error instanceof Error ? error.message : "Refresh failed." }));
    }
  }

  function addCustomModel(profile: Omit<ModelOption, "isAvailable" | "statusReason">) {
    setCustomModels([
      ...customModels.filter((model) => model.id !== profile.id || model.providerId !== profile.providerId),
      { ...profile, isAvailable: true, statusReason: "User-defined model profile." }
    ]);
  }

  async function testAndSaveLocalProvider(profile: Omit<LocalProviderConnection, "status" | "statusReason">) {
    let result: Pick<LocalProviderConnection, "status" | "statusReason">;
    try {
      const response = await fetch(profile.endpointUrl, { method: "GET" });
      result = response.ok
        ? { status: "connected" }
        : { status: "error", statusReason: `Endpoint returned HTTP ${response.status}.` };
    } catch {
      result = { status: "error", statusReason: "Endpoint is unreachable from the browser or blocks CORS." };
    }
    let discoveredModels: LocalProviderConnection["models"];
    if (result.status === "connected" && supportsLocalModelDiscovery(profile.providerType)) {
      try {
        discoveredModels = await discoverLocalModels(profile.endpointUrl, profile.providerType);
      } catch (error) {
        result = { status: "error", statusReason: error instanceof Error ? error.message : "Could not discover local models." };
      }
    }
    setLocalProviders([...localProviders.filter((provider) => provider.id !== profile.id), { ...profile, ...result, models: discoveredModels }]);
  }

  async function refreshSavedLocalModelCatalogs() {
    const refreshable = localProviders.filter((provider) => provider.status === "connected" && supportsLocalModelDiscovery(provider.providerType));
    if (refreshable.length === 0) return;
    const refreshed = await Promise.all(localProviders.map(async (provider) => {
      if (provider.status !== "connected" || !supportsLocalModelDiscovery(provider.providerType)) return provider;
      try {
        return { ...provider, models: await discoverLocalModels(provider.endpointUrl, provider.providerType) };
      } catch {
        return provider;
      }
    }));
    setLocalProviders(refreshed);
  }

  async function openNestedLibrary(path: string) {
    try {
      const snapshot = await apiPost<LibrarySnapshot>("/api/libraries/open", { path });
      applyLibrarySnapshot(snapshot);
      setStatus(snapshot.canvas ? "Opened nested canvas" : "Opened collection library");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open nested library.");
    }
  }

  async function handleDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (!library) {
      setStatus(apiUnavailableMessage);
      return;
    }
    const files = [...event.dataTransfer.files];
    const file = files.find((item) => isImageFile(item) || isVideoFile(item) || isTextFile(item));
    const canvas = canvasRef.current;
    if (!file || !canvas) {
      setStatus("Drop an image, text file, or video. Folders use Add Folder so SnarkRoute can ask what typed node to create.");
      return;
    }

    const bounds = canvas.getBoundingClientRect();
    const dropX = (event.clientX - bounds.left + canvas.scrollLeft - viewport.x) / viewportScale;
    const dropY = (event.clientY - bounds.top + canvas.scrollTop - viewport.y) / viewportScale;
    if (isImageFile(file)) await importImageFileAt(file, { x: dropX, y: dropY });
    else if (isTextFile(file)) await importTextFileAt(file, { x: dropX, y: dropY });
    else await importVideoFileAt(file, { x: dropX, y: dropY });
  }

  async function importImageFileAt(file: File, point: { x: number; y: number }) {
    if (!library) {
      setStatus(apiUnavailableMessage);
      return;
    }
    setStatus(`Importing ${file.name || "clipboard image"}...`);
    try {
      const dataBase64 = await fileToBase64(file);
      const snapshot = await apiPost<LibrarySnapshot>("/api/libraries/current/import-image", {
        filename: file.name || `clipboard-${Date.now()}.png`,
        dataBase64,
        dropX: point.x,
        dropY: point.y,
        width: imageNodeWidth,
        height: imageNodeHeight
      });
      applyLibrarySnapshot(snapshot);
      void refreshProjects();
      setStatus("Image node imported");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Image import failed.");
    }
  }

  function handleCanvasPointerDown(event: React.PointerEvent<HTMLElement>) {
    if ((event.button !== 0 && event.button !== 1) || event.target !== event.currentTarget) return;
    if (event.button === 1) event.preventDefault();
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
    setNodeCreateMenu(null);
    setSelectionMenu(null);
    setStackItemMenu(null);
    interactionMovedRef.current = false;
    if (event.button === 0) {
      const point = screenToWorld(event.clientX, event.clientY);
      setDragState({
        kind: "selection",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        currentClientX: event.clientX,
        currentClientY: event.clientY,
        startX: point.x,
        startY: point.y,
        currentX: point.x,
        currentY: point.y
      });
      return;
    }
    setDragState({
      kind: "canvas",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: viewport.x,
      startPanY: viewport.y,
      startScale: viewportScale
    });
  }

  function handleCanvasWheel(event: React.WheelEvent<HTMLElement>) {
    if (event.target instanceof Element && event.target.closest("[data-canvas-wheel-scroll]")) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.scrollLeft = 0;
    canvas.scrollTop = 0;

    const bounds = canvas.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    const worldX = (pointerX - viewport.x) / viewportScale;
    const worldY = (pointerY - viewport.y) / viewportScale;
    const nextScale = clamp(viewportScale * Math.exp(-event.deltaY * 0.0012), minCanvasScale, maxCanvasScale);

    setViewport({
      x: Math.round(pointerX - worldX * nextScale),
      y: Math.round(pointerY - worldY * nextScale),
      scale: Number(nextScale.toFixed(3))
    });
  }

  function handleCanvasContextMenu(event: React.MouseEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    const point = screenToWorld(event.clientX, event.clientY);
    setContentMenu(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setNodeCreateMenu({
      x: event.clientX,
      y: event.clientY,
      worldX: point.x,
      worldY: point.y
    });
  }

  function handleNodePointerDown(event: React.PointerEvent<HTMLElement>, node: NodeView) {
    if (event.button === 1) {
      event.preventDefault();
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
      setNodeCreateMenu(null);
      interactionMovedRef.current = false;
      setDragState({
        kind: "canvas",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPanX: viewport.x,
        startPanY: viewport.y,
        startScale: viewportScale
      });
      return;
    }
    if (event.button !== 0) return;
    event.stopPropagation();
    setNodeCreateMenu(null);
    setSelectedEdgeId(null);
    interactionMovedRef.current = false;
    const groupIds = selectedNodeIds.includes(node.canvas.id) && selectedNodeIds.length > 1 ? selectedNodeIds : [];
    const groupStartPositions = groupIds
      .map((id) => nodes.find((entry) => entry.canvas.id === id)?.canvas)
      .filter((entry): entry is CanvasNode => Boolean(entry))
      .map((entry) => ({ id: entry.id, x: entry.x, y: entry.y }));
    setDragState({
      kind: "node",
      pointerId: event.pointerId,
      nodeId: node.canvas.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: node.canvas.x,
      startY: node.canvas.y,
      groupStartPositions: groupStartPositions.length > 1 ? groupStartPositions : undefined
    });
  }

  function handleOutputPointerDown(event: React.PointerEvent<HTMLElement>, node: NodeView) {
    if (event.button !== 0) return;
    event.stopPropagation();
    setNodeCreateMenu(null);
    setSelectedEdgeId(null);
    interactionMovedRef.current = false;
    const start = nodeOutputPoint(node.canvas);
    setDragState({
      kind: "connection",
      pointerId: event.pointerId,
      direction: "fromOutput",
      fromNodeId: node.canvas.id,
      startX: start.x,
      startY: start.y,
      currentX: start.x,
      currentY: start.y
    });
  }

  function handleInputPointerDown(event: React.PointerEvent<HTMLElement>, node: NodeView) {
    if (event.button !== 0) return;
    event.stopPropagation();
    setNodeCreateMenu(null);
    setSelectedEdgeId(null);
    interactionMovedRef.current = false;
    const start = nodeInputPoint(node.canvas);
    setDragState({
      kind: "connection",
      pointerId: event.pointerId,
      direction: "fromInput",
      fromNodeId: node.canvas.id,
      toNodeId: node.canvas.id,
      startX: start.x,
      startY: start.y,
      currentX: start.x,
      currentY: start.y
    });
  }

  function handleNodeClick(event: React.MouseEvent<HTMLElement>, node: NodeView) {
    event.stopPropagation();
    if (interactionMovedRef.current) {
      interactionMovedRef.current = false;
      return;
    }
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      setSelectedNodeIds((current) => {
        const next = current.includes(node.canvas.id) ? current.filter((id) => id !== node.canvas.id) : [...current, node.canvas.id];
        setSelectedNodeId(next[next.length - 1] ?? null);
        return next;
      });
    } else {
      setSelectedNodeId(node.canvas.id);
      setSelectedNodeIds([node.canvas.id]);
    }
    setSelectedEdgeId(null);
  }

  function handleNodeContextMenu(event: React.MouseEvent<HTMLElement>, node: NodeView) {
    event.preventDefault();
    event.stopPropagation();
    setContentMenu(null);
    const selection = selectedNodeIds.includes(node.canvas.id) ? selectedNodeIds : [node.canvas.id];
    setSelectedNodeId(node.canvas.id);
    setSelectedNodeIds(selection);
    setSelectedEdgeId(null);
    setSelectionMenu({ x: event.clientX, y: event.clientY, nodeId: node.canvas.id });
  }

  function updateNodePosition(nodeId: string, x: number, y: number) {
    setLibrary((current) => current ? mapLibraryNode(current, nodeId, x, y) : current);
  }

  function updateNodePositions(positions: { id: string; x: number; y: number }[]) {
    setLibrary((current) => current ? mapLibraryNodes(current, positions) : current);
  }

  function pushUndoSnapshot() {
    if (!library?.canvas) return;
    undoStackRef.current = [...undoStackRef.current.slice(-29), structuredClone(library.canvas)];
  }

  async function undoCanvas() {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    try {
      await apiPut<CanvasDocument>("/api/libraries/current/canvas", previous);
      await refreshLibrary();
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
      setStatus("Undo");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not undo.");
    }
  }

  async function persistNodePosition(nodeId: string, x: number, y: number) {
    if (!library?.canvas) return;
    pushUndoSnapshot();
    const canvas = {
      ...library.canvas,
      nodes: library.canvas.nodes.map((node) => node.id === nodeId ? { ...node, x, y } : node)
    };
    updateNodePosition(nodeId, x, y);
    try {
      await apiPut<CanvasDocument>("/api/libraries/current/canvas", canvas);
      setStatus("Canvas saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save canvas position.");
    }
  }

  async function persistNodePositions(positions: { id: string; x: number; y: number }[]) {
    if (!library?.canvas) return;
    pushUndoSnapshot();
    const byId = new Map(positions.map((position) => [position.id, position]));
    const canvas = {
      ...library.canvas,
      nodes: library.canvas.nodes.map((node) => {
        const position = byId.get(node.id);
        return position ? { ...node, x: position.x, y: position.y } : node;
      })
    };
    updateNodePositions(positions);
    try {
      await apiPut<CanvasDocument>("/api/libraries/current/canvas", canvas);
      setStatus("Canvas saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save canvas position.");
    }
  }

  async function addCanvasEdge(fromNodeId: string, toNodeId: string) {
    if (!library?.canvas) return;
    const exists = (library.canvas.edges ?? []).some((edge) => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId);
    if (exists) return;
    pushUndoSnapshot();
    const edge: CanvasEdge = { id: `edge_${Date.now().toString(36)}`, fromNodeId, toNodeId };
    const canvas = { ...library.canvas, edges: [...(library.canvas.edges ?? []), edge] };
    setLibrary((current) => current ? { ...current, canvas } : current);
    try {
      await apiPut<CanvasDocument>("/api/libraries/current/canvas", canvas);
      setStatus("Connection saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save connection.");
    }
  }

  async function syncRepresentationEdge(edgeId: string) {
    try {
      const snapshot = await apiPost<LibrarySnapshot>(`/api/libraries/current/edges/${encodeURIComponent(edgeId)}/sync-representation`, {});
      applyLibrarySnapshot(snapshot);
      setStatus("Representation refreshed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not refresh representation.");
    }
  }

  async function saveEdgeNote(edgeId: string, note: string) {
    if (!library?.canvas) return;
    const normalizedNote = note.trim();
    const canvas: CanvasDocument = {
      ...library.canvas,
      edges: (library.canvas.edges ?? []).map((edge) => edge.id === edgeId ? {
        ...edge,
        note: normalizedNote || undefined
      } : edge)
    };
    setLibrary((current) => current ? { ...current, canvas } : current);
    try {
      await apiPut<CanvasDocument>("/api/libraries/current/canvas", canvas);
      setStatus(normalizedNote ? "Edge note saved" : "Edge note cleared");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save edge note.");
    }
  }

  async function createConnectedNode(type: "image" | "video" | "text") {
    if (!nodeCreateMenu) return;
    const existingNodeIds = new Set(nodes.map((node) => node.canvas.id));
    const mutationSeq = beginLibraryMutation();
    setNodeCreateMenu(null);
    try {
      pushUndoSnapshot();
      const snapshot = await apiPost<LibrarySnapshot>("/api/libraries/current/nodes", {
        type,
        x: nodeCreateMenu.worldX,
        y: nodeCreateMenu.worldY,
        width: imageNodeWidth,
        height: type === "text" ? 180 : imageNodeHeight,
        connectFromNodeId: nodeCreateMenu.fromNodeId
      });
      if (!applyLibrarySnapshot(snapshot, mutationSeq)) return;
      const createdNodeId = snapshot.nodes.find((node) => !existingNodeIds.has(node.canvas.id))?.canvas.id ?? null;
      setSelectedNodeId(createdNodeId);
      setSelectedNodeIds(createdNodeId ? [createdNodeId] : []);
      setStatus(`${type === "image" ? "Image" : type === "video" ? "Video" : "Text"} node created`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create node.");
    }
  }

  async function createConnectedRepresentation(type: NodeRepresentationType) {
    if (!nodeCreateMenu?.fromNodeId) return;
    const existingNodeIds = new Set(nodes.map((node) => node.canvas.id));
    const mutationSeq = beginLibraryMutation();
    setNodeCreateMenu(null);
    try {
      pushUndoSnapshot();
      const width = imageNodeWidth;
      const height = type === "text" ? 180 : imageNodeHeight;
      const snapshot = await apiPost<LibrarySnapshot>(`/api/libraries/current/nodes/${encodeURIComponent(nodeCreateMenu.fromNodeId)}/duplicate-as`, {
        type,
        x: Math.round(nodeCreateMenu.worldX - width / 2),
        y: Math.round(nodeCreateMenu.worldY - height / 2),
        width,
        height,
        connectFromNodeId: nodeCreateMenu.fromNodeId
      });
      const createdNodeId = snapshot.nodes.find((node) => !existingNodeIds.has(node.canvas.id))?.canvas.id ?? null;
      if (!applyLibrarySnapshot(snapshot, mutationSeq)) return;
      setSelectedNodeId(createdNodeId);
      setSelectedNodeIds(createdNodeId ? [createdNodeId] : []);
      setStatus(`${representationLabel(type)} representation created`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create representation.");
    }
  }

  async function saveTextNode(nodeId: string, text: string) {
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/text-nodes/${encodeURIComponent(nodeId)}`, { text });
      applyLibrarySnapshot(snapshot);
      setStatus("Text saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save text.");
    }
  }

  async function saveTextNodeColor(nodeId: string, color: string) {
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/text-nodes/${encodeURIComponent(nodeId)}`, { color });
      applyLibrarySnapshot(snapshot);
      setStatus("Text color saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save text color.");
    }
  }

  async function refreshProjects() {
    try {
      const projectList = await apiGet<ProjectListResponse>("/api/libraries/projects");
      setProjects(projectList.projects);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load projects.");
    }
  }

  function applyProjectMutation(result: ProjectMutationResponse, message: string) {
    setLibrary(result.current);
    setProjects(result.projects);
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
    setProjectMenu(null);
    setStatus(message);
  }

  async function addProject() {
    try {
      setStatus("Selecting project folder...");
      const picked = await apiPost<{ path: string | null }>("/api/libraries/projects/pick-folder", {});
      if (!picked.path) {
        setStatus("Project selection canceled.");
        return;
      }
      const result = await apiPost<ProjectMutationResponse>("/api/libraries/projects/add", { path: picked.path });
      applyProjectMutation(result, "Project added.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not add project.");
    }
  }

  async function openProject(project: ProjectSummary) {
    try {
      const result = await apiPost<ProjectMutationResponse>("/api/libraries/projects/open", { path: project.path });
      applyProjectMutation(result, `Opened ${project.title}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open project.");
    }
  }

  async function copyProject(project: ProjectSummary) {
    try {
      await navigator.clipboard.writeText(project.path);
      setProjectMenu(null);
      setStatus("Project path copied.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not copy project.");
    }
  }

  async function pasteProject() {
    try {
      const path = (await navigator.clipboard.readText()).trim();
      if (!path) {
        setStatus("Clipboard does not contain a project path.");
        return;
      }
      const result = await apiPost<ProjectMutationResponse>("/api/libraries/projects/add", { path });
      applyProjectMutation(result, "Project pasted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not paste project.");
    }
  }

  async function removeProject(project: ProjectSummary) {
    if (!window.confirm(`Remove "${project.title}" from the project list? Files on disk will stay in place.`)) return;
    try {
      const result = await apiPost<ProjectMutationResponse>("/api/libraries/projects/remove", { path: project.path });
      applyProjectMutation(result, "Project removed from the list.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not remove project.");
    }
  }

  async function openProjectInExplorer(project: ProjectSummary) {
    try {
      await apiPost("/api/libraries/projects/open-folder", { path: project.path });
      setProjectMenu(null);
      setStatus("Project opened in Explorer.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open project folder.");
    }
  }

  async function importProject(project: ProjectSummary) {
    await openProject(project);
  }

  function exportProject(project: ProjectSummary) {
    const data = new Blob([`${JSON.stringify(project, null, 2)}\n`], { type: "application/json" });
    downloadBlob(data, `${safeDownloadName(project.title)}.snarkproject.json`);
    setProjectMenu(null);
    setStatus("Project descriptor exported.");
  }

  async function openCoverPicker(project: ProjectSummary) {
    try {
      const result = await apiGet<ProjectImagesResponse>(`/api/libraries/projects/${encodeURIComponent(project.id)}/images`);
      setProjectMenu(null);
      setCoverPicker({ project, images: result.images });
      setStatus(result.images.length ? "Choose a project cover." : "No images found in this project.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load project images.");
    }
  }

  async function chooseProjectCover(project: ProjectSummary, image: ProjectImageSummary) {
    try {
      const result = await apiPost<ProjectListResponse>(`/api/libraries/projects/${encodeURIComponent(project.id)}/cover`, { imageId: image.id });
      setProjects(result.projects);
      setCoverPicker(null);
      setStatus("Project cover updated.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update project cover.");
    }
  }

  async function importTextFileAt(file: File, point: { x: number; y: number }) {
    if (!library) {
      setStatus(apiUnavailableMessage);
      return;
    }
    setStatus(`Importing ${file.name || "text"}...`);
    try {
      const text = await file.text();
      const snapshot = await apiPost<LibrarySnapshot>("/api/libraries/current/import-text", {
        filename: file.name || `text-${Date.now()}.txt`,
        text,
        dropX: point.x,
        dropY: point.y,
        width: imageNodeWidth,
        height: 180
      });
      applyLibrarySnapshot(snapshot);
      setStatus("Text node imported");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Text import failed.");
    }
  }

  async function refreshLibraryContents() {
    try {
      applyLibrarySnapshot(await apiGet<LibrarySnapshot>("/api/libraries/current"));
    } catch {
      // Keep the current canvas visible when an external refresh is transiently unavailable.
    }
  }

  async function addTextToStack(nodeId: string, text: string) {
    try {
      await apiPut<LibrarySnapshot>(`/api/libraries/current/text-nodes/${encodeURIComponent(nodeId)}`, { text });
      const snapshot = await apiPost<LibrarySnapshot>(`/api/libraries/current/text-nodes/${encodeURIComponent(nodeId)}/stack`, { text });
      applyLibrarySnapshot(snapshot);
      setStatus("Text added to stack");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not add text to stack.");
    }
  }

  async function setActiveTextStackItem(nodeId: string, selectedStackItemId: string | null) {
    const mutationSeq = beginLibraryMutation();
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/text-nodes/${encodeURIComponent(nodeId)}/stack/active`, { selectedStackItemId });
      if (!applyLibrarySnapshot(snapshot, mutationSeq)) return;
      setStatus(selectedStackItemId ? "Stack text selected" : "Draft text selected");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not select text.");
    }
  }

  async function saveTextRouteSettings(nodeId: string, selection: ModelRouteSelection) {
    setModelSelections({ ...modelSelections, [nodeId]: selection });
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/text-nodes/${encodeURIComponent(nodeId)}`, selection);
      applyLibrarySnapshot(snapshot);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save text generation route.");
    }
  }

  async function runTextGeneration(nodeId: string, selection: ModelRouteSelection, availableExecutionProviders: string[], prompt: string, inputNodeIds?: string[], maxImageInputs?: number, imageReferenceSyntax?: string) {
    setModelSearchNodeId(null);
    setOpenStackNodeId(null);
    setStackItemMenu(null);
    setSelectionMenu(null);
    setNodeCreateMenu(null);
    try {
      setStatus("Generating text...");
      setGenerationFeedback((current) => ({ ...current, [nodeId]: { busy: true, message: "Generating..." } }));
      await apiPut<LibrarySnapshot>(`/api/libraries/current/text-nodes/${encodeURIComponent(nodeId)}`, { text: prompt });
      const snapshot = await apiPost<LibrarySnapshot>(`/api/libraries/current/text-nodes/${encodeURIComponent(nodeId)}/generate`, {
        modelId: selection.modelId,
        prompt,
        executionProvider: selection.executionProvider,
        fallbackAllowed: selection.fallbackAllowed,
        availableExecutionProviders,
        inputNodeIds,
        maxImageInputs,
        imageReferenceSyntax
      });
      applyLibrarySnapshot(snapshot);
      setStatus("Generated text added to stack");
      setGenerationFeedback((current) => ({ ...current, [nodeId]: { busy: false, message: "Added to stack" } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not generate text.";
      setStatus(message);
      setGenerationFeedback((current) => ({ ...current, [nodeId]: { busy: false, message, error: true } }));
    }
  }

  async function saveMediaPrompt(nodeId: string, prompt: string) {
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/${mediaNodeRoute(nodeId)}/${encodeURIComponent(nodeId)}/prompt`, { prompt });
      applyLibrarySnapshot(snapshot);
      setStatus("Prompt saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save prompt.");
    }
  }

  async function saveMediaRouteSettings(type: "image" | "video", nodeId: string, selection: ModelRouteSelection) {
    setModelSelections({ ...modelSelections, [nodeId]: selection });
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/${type}-nodes/${encodeURIComponent(nodeId)}/route-settings`, selection);
      applyLibrarySnapshot(snapshot);
      setStatus("Execution route saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save execution route.");
    }
  }
  async function addLocalLibraryFolder() {
    const sourcePath = window.prompt("Add local library folder path");
    if (!sourcePath?.trim()) return;
    const mutationSeq = beginLibraryMutation();
    try {
      const point = viewportCenterWorldPoint();
      const scan = await apiPost<LocalLibraryScanResult>("/api/libraries/scan-local-library", { sourcePath: sourcePath.trim() });
      const action = chooseLocalFolderAction(scan);
      if (!action) return;
      if (action === "open") {
        const snapshot = await apiPost<LibrarySnapshot>("/api/libraries/current/import-local-library", {
          sourcePath: sourcePath.trim(),
          viewMode: "media-folder",
          dropX: point.x,
          dropY: point.y
        });
        if (!applyLibrarySnapshot(snapshot, mutationSeq)) return;
        setStatus("Folder opened as library");
        return;
      }
      const snapshot = await apiPost<LibrarySnapshot>("/api/libraries/current/import-local-folder-stack", {
        sourcePath: sourcePath.trim(),
        stackKind: action,
        dropX: point.x,
        dropY: point.y,
        width: imageNodeWidth,
        height: action === "text" ? 180 : imageNodeHeight
      });
      const createdNodeId = snapshot.nodes.find((node) => !nodes.some((currentNode) => currentNode.canvas.id === node.canvas.id))?.canvas.id ?? null;
      if (!applyLibrarySnapshot(snapshot, mutationSeq)) return;
      setSelectedNodeId(createdNodeId);
      setSelectedNodeIds(createdNodeId ? [createdNodeId] : []);
      setStatus(`${action === "image" ? "Image" : action === "video" ? "Video" : "Text"} stack node created`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not add local library folder.");
    }
  }

  async function setLibraryViewMode(nodeId: string, viewMode: LibraryViewMode) {
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/library-nodes/${encodeURIComponent(nodeId)}/view-mode`, { viewMode });
      applyLibrarySnapshot(snapshot);
      setStatus(`Opened library as ${libraryViewLabel(viewMode)}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not change library view.");
    }
  }

  async function importVideoFileAt(file: File, point: { x: number; y: number }) {
    if (!library) {
      setStatus(apiUnavailableMessage);
      return;
    }
    setStatus(`Importing ${file.name || "video"}...`);
    try {
      const dataBase64 = await fileToBase64(file);
      const snapshot = await apiPost<LibrarySnapshot>("/api/libraries/current/import-video", {
        filename: file.name || `video-${Date.now()}.mp4`,
        dataBase64,
        dropX: point.x,
        dropY: point.y,
        width: imageNodeWidth,
        height: imageNodeHeight
      });
      applyLibrarySnapshot(snapshot);
      setStatus("Video node imported");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Video import failed.");
    }
  }

  async function renameNode(nodeId: string, title: string) {
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/nodes/${encodeURIComponent(nodeId)}/title`, { title });
      applyLibrarySnapshot(snapshot);
      setStatus("Node renamed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not rename node.");
    }
  }

  function mediaNodeRoute(nodeId: string): "image-nodes" | "video-nodes" {
    return nodes.find((node) => node.canvas.id === nodeId)?.manifest.type === "video" ? "video-nodes" : "image-nodes";
  }

  async function uploadImageToNodeStack(nodeId: string) {
    const isVideo = mediaNodeRoute(nodeId) === "video-nodes";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = isVideo ? ".mp4,.webm,.mov,video/mp4,video/webm,video/quicktime" : ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        setStatus(`Adding ${file.name} to stack...`);
        const dataBase64 = await fileToBase64(file);
        const snapshot = await apiPost<LibrarySnapshot>(`/api/libraries/current/${mediaNodeRoute(nodeId)}/${encodeURIComponent(nodeId)}/stack`, {
          filename: file.name,
          dataBase64
        });
        applyLibrarySnapshot(snapshot);
        setSelectedNodeId(nodeId);
        setSelectedNodeIds([nodeId]);
        setStatus(`${isVideo ? "Video" : "Image"} added to stack`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : `Could not add ${isVideo ? "video" : "image"} to stack.`);
      }
    };
    input.click();
  }

  async function openCropEditor(requestedSourceNodeId: string, cropNodeId?: string) {
    const requestedNode = nodes.find((candidate) => candidate.canvas.id === requestedSourceNodeId && candidate.manifest.type === "image") as ImageNodeView | undefined;
    const implicitCropNode = !cropNodeId && requestedNode?.manifest.crop?.sourceNodeId
      ? requestedNode
      : undefined;
    const resolvedCropNodeId = cropNodeId ?? implicitCropNode?.canvas.id;
    const sourceNodeId = implicitCropNode?.manifest.crop?.sourceNodeId ?? requestedSourceNodeId;
    const sourceNode = nodes.find((candidate) => candidate.canvas.id === sourceNodeId && candidate.manifest.type === "image") as ImageNodeView | undefined;
    const cropNode = resolvedCropNodeId ? nodes.find((candidate) => candidate.canvas.id === resolvedCropNodeId && candidate.manifest.type === "image") as ImageNodeView | undefined : undefined;
    if (!sourceNode?.previewUrl) {
      setStatus("Image node has no image to crop.");
      return;
    }
    const src = `${apiBase}${sourceNode.previewUrl}?v=${encodeURIComponent(sourceNode.activeStackItem?.id ?? sourceNode.manifest.id)}`;
    const response = await fetch(src);
    if (!response.ok) {
      setStatus("Could not load image for crop.");
      return;
    }
    const savedCrop = cropNode?.manifest.crop?.sourceNodeId === sourceNodeId ? cropNode.manifest.crop : undefined;
    setCropDraft({
      sourceNodeId,
      cropNodeId: resolvedCropNodeId,
      title: cropNode?.manifest.title || sourceNode.manifest.title || "Image",
      src: URL.createObjectURL(await response.blob()),
      rect: savedCrop?.rect ?? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      aspectRatio: savedCrop?.aspectRatio ?? null
    });
  }

  async function applyCropResult(draft: CropDraft, dataUrl: string) {
    const sourceNode = nodes.find((node) => node.canvas.id === draft.sourceNodeId);
    if (!sourceNode) return;
    const existingNodeIds = new Set(nodes.map((node) => node.canvas.id));
    const mutationSeq = beginLibraryMutation();
    try {
      pushUndoSnapshot();
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
      const crop = { sourceNodeId: draft.sourceNodeId, rect: draft.rect, aspectRatio: draft.aspectRatio };
      const snapshot = draft.cropNodeId
        ? await apiPost<LibrarySnapshot>(`/api/libraries/current/image-nodes/${encodeURIComponent(draft.cropNodeId)}/stack`, {
          filename: `${safeDownloadName(draft.title)} crop.png`,
          dataBase64: base64,
          crop
        })
        : await apiPost<LibrarySnapshot>("/api/libraries/current/import-image", {
          filename: `${safeDownloadName(draft.title)} crop.png`,
          dataBase64: base64,
          dropX: sourceNode.canvas.x + sourceNode.canvas.width + imageNodeWidth / 2 + 80,
          dropY: sourceNode.canvas.y + imageNodeHeight / 2,
          width: imageNodeWidth,
          height: imageNodeHeight,
          connectFromNodeId: draft.sourceNodeId,
          crop
        });
      if (!applyLibrarySnapshot(snapshot, mutationSeq)) return;
      const cropNodeId = draft.cropNodeId ?? snapshot.nodes.find((node) => !existingNodeIds.has(node.canvas.id))?.canvas.id ?? null;
      setSelectedNodeId(cropNodeId);
      setSelectedNodeIds(cropNodeId ? [cropNodeId] : []);
      setCropDraft(null);
      setStatus(draft.cropNodeId ? "Crop added to stack" : "Crop created");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not crop image.");
    }
  }

  async function setActiveStackImage(nodeId: string, activeStackIndex: number) {
    const mutationSeq = beginLibraryMutation();
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/${mediaNodeRoute(nodeId)}/${encodeURIComponent(nodeId)}/stack/active`, { activeStackIndex });
      if (!applyLibrarySnapshot(snapshot, mutationSeq)) return;
      setSelectedNodeId(nodeId);
      setSelectedNodeIds([nodeId]);
      setStatus("Stack item selected");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not select stack item.");
    }
  }

  async function runMediaGeneration(type: "image" | "video", nodeId: string, selection: ModelRouteSelection, availableExecutionProviders: string[], prompt: string, inputNodeIds?: string[], maxImageInputs?: number, imageReferenceSyntax?: string, parameters?: ImageGenerationParameters) {
    setModelSearchNodeId(null);
    setOpenStackNodeId(null);
    setStackItemMenu(null);
    setSelectionMenu(null);
    setNodeCreateMenu(null);
    try {
      setStatus(`Generating ${type}...`);
      setGenerationFeedback((current) => ({ ...current, [nodeId]: { busy: true, message: "Generating..." } }));
      const snapshot = await apiPost<LibrarySnapshot>(`/api/libraries/current/${type}-nodes/${encodeURIComponent(nodeId)}/generate`, {
        modelId: selection.modelId,
        prompt,
        executionProvider: selection.executionProvider,
        fallbackAllowed: selection.fallbackAllowed,
        availableExecutionProviders,
        inputNodeIds,
        maxImageInputs,
        imageReferenceSyntax,
        parameters
      });
      applyLibrarySnapshot(snapshot);
      if (type === "image") void refreshProjects();
      setSelectedNodeId(nodeId);
      setSelectedNodeIds([nodeId]);
      setStatus("Generation added to stack");
      setGenerationFeedback((current) => ({ ...current, [nodeId]: { busy: false, message: "Added to stack" } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not run generation.";
      setStatus(message);
      setGenerationFeedback((current) => ({ ...current, [nodeId]: { busy: false, message, error: true } }));
    }
  }

  async function duplicateStackItemNode(nodeId: string, stackItemId: string, point: { x: number; y: number }) {
    const existingNodeIds = new Set(nodes.map((node) => node.canvas.id));
    const mutationSeq = beginLibraryMutation();
    setStackItemMenu(null);
    try {
      pushUndoSnapshot();
      const nodeType = nodes.find((node) => node.canvas.id === nodeId)?.manifest.type;
      const route = nodeType === "text" ? "text-nodes" : mediaNodeRoute(nodeId);
      const snapshot = await apiPost<LibrarySnapshot>(
        `/api/libraries/current/${route}/${encodeURIComponent(nodeId)}/stack/${encodeURIComponent(stackItemId)}/duplicate-node`,
        { x: point.x, y: point.y, width: imageNodeWidth, height: imageNodeHeight }
      );
      const createdNodeId = snapshot.nodes.find((node) => !existingNodeIds.has(node.canvas.id))?.canvas.id ?? null;
      if (!applyLibrarySnapshot(snapshot, mutationSeq)) return;
      setOpenStackNodeId(null);
      setSelectedNodeId(createdNodeId);
      setSelectedNodeIds(createdNodeId ? [createdNodeId] : []);
      setStatus("Stack item pulled into a new node");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create node from stack item.");
    }
  }

  async function deleteStackItem(nodeId: string, stackItemId: string) {
    setStackItemMenu(null);
    try {
      const nodeType = nodes.find((node) => node.canvas.id === nodeId)?.manifest.type;
      const route = nodeType === "text" ? "text-nodes" : mediaNodeRoute(nodeId);
      const snapshot = await apiDelete<LibrarySnapshot>(`/api/libraries/current/${route}/${encodeURIComponent(nodeId)}/stack/${encodeURIComponent(stackItemId)}`);
      applyLibrarySnapshot(snapshot);
      setStatus("Stack item deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete stack item.");
    }
  }

  async function deleteLibraryAsset(nodeId: string, assetId: string) {
    setLibraryAssetMenu(null);
    try {
      const snapshot = await apiDelete<LibrarySnapshot>(`/api/libraries/current/library-nodes/${encodeURIComponent(nodeId)}/assets/${encodeURIComponent(assetId)}`);
      applyLibrarySnapshot(snapshot);
      setStatus("Library asset deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete library asset.");
    }
  }

  async function saveStackItem(nodeId: string, stackItemId: string) {
    setStackItemMenu(null);
    await downloadPreview(`${apiBase}/api/libraries/current/${mediaNodeRoute(nodeId)}/${encodeURIComponent(nodeId)}/stack/${encodeURIComponent(stackItemId)}`, "stack-item");
  }

  async function copyContent(menu: ContentContextMenu) {
    setContentMenu(null);
    const node = nodes.find((candidate) => candidate.canvas.id === menu.nodeId);
    try {
      if (menu.kind === "text") {
        const text = node?.manifest.type === "text" ? textNodeDisplayText(node as TextNodeView) : "";
        await navigator.clipboard.writeText(text);
        setStatus("Text copied");
        return;
      }
      const src = contentPreviewUrl(node);
      if (!src || menu.kind !== "image") return;
      await copyImageToClipboard(src);
      setStatus("Image copied");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not copy content.");
    }
  }

  async function saveContent(menu: ContentContextMenu) {
    setContentMenu(null);
    const node = nodes.find((candidate) => candidate.canvas.id === menu.nodeId);
    try {
      if (menu.kind === "text") {
        const text = node?.manifest.type === "text" ? textNodeDisplayText(node as TextNodeView) : "";
        downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `${safeDownloadName(node?.manifest.title ?? "text")}.txt`);
        setStatus("Text saved");
        return;
      }
      await downloadPreview(contentPreviewUrl(node), node?.manifest.title ?? menu.kind);
      setStatus(`${menu.kind === "video" ? "Video" : "Image"} saved`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save content.");
    }
  }

  async function useTextStackItemAsDraft(nodeId: string, stackItemId: string) {
    setStackItemMenu(null);
    const node = nodes.find((candidate): candidate is TextNodeView => candidate.canvas.id === nodeId && candidate.manifest.type === "text");
    const item = node?.stack.find((candidate) => candidate.id === stackItemId);
    if (!item) {
      setStatus("Could not find text stack item.");
      return;
    }
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/text-nodes/${encodeURIComponent(nodeId)}`, { text: item.text });
      applyLibrarySnapshot(snapshot);
      setSelectedNodeId(nodeId);
      setSelectedNodeIds([nodeId]);
      setStatus("Text copied into input field");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not place text into input field.");
    }
  }

  async function duplicateNode(nodeId: string, targetNodeId = nodeId, action = "duplicated") {
    setSelectionMenu(null);
    const targetNode = nodes.find((node) => node.canvas.id === targetNodeId);
    if (!targetNode) {
      setStatus("Could not find node to paste beside.");
      return;
    }
    try {
      pushUndoSnapshot();
      const existingIds = new Set(nodes.map((node) => node.canvas.id));
      const snapshot = await apiPost<LibrarySnapshot>(`/api/libraries/current/nodes/${encodeURIComponent(nodeId)}/duplicate`, {
        x: targetNode.canvas.x + 28,
        y: targetNode.canvas.y + 28
      });
      const created = snapshot.nodes.find((node) => !existingIds.has(node.canvas.id));
      applyLibrarySnapshot(snapshot);
      setSelectedNodeId(created?.canvas.id ?? null);
      setSelectedNodeIds(created ? [created.canvas.id] : []);
      setStatus(`Node ${action}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not duplicate node.");
    }
  }

  async function duplicateNodeAsRepresentation(nodeId: string, type: NodeRepresentationType) {
    setSelectionMenu(null);
    const sourceNode = nodes.find((node) => node.canvas.id === nodeId);
    if (!sourceNode) {
      setStatus("Could not find node to represent.");
      return;
    }
    try {
      pushUndoSnapshot();
      const existingIds = new Set(nodes.map((node) => node.canvas.id));
      const snapshot = await apiPost<LibrarySnapshot>(`/api/libraries/current/nodes/${encodeURIComponent(nodeId)}/duplicate-as`, {
        type,
        x: sourceNode.canvas.x + 28,
        y: sourceNode.canvas.y + 28,
        width: imageNodeWidth,
        height: type === "text" ? 180 : imageNodeHeight
      });
      const created = snapshot.nodes.find((node) => !existingIds.has(node.canvas.id));
      applyLibrarySnapshot(snapshot);
      setSelectedNodeId(created?.canvas.id ?? null);
      setSelectedNodeIds(created ? [created.canvas.id] : []);
      setStatus(`${representationLabel(type)} representation created`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create representation.");
    }
  }

  async function openNodeAsFolder(nodeId: string) {
    setSelectionMenu(null);
    try {
      await apiPost(`/api/libraries/current/nodes/${encodeURIComponent(nodeId)}/open-folder`, {});
      setStatus("Node folder opened");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open node folder.");
    }
  }

  function copyNode(nodeId: string) {
    setCopiedNodeId(nodeId);
    setSelectionMenu(null);
    setStatus("Node copied");
  }

  async function deleteSelectedNode(nodeId: string) {
    try {
      pushUndoSnapshot();
      const snapshot = await apiDelete<LibrarySnapshot>(`/api/libraries/current/nodes/${encodeURIComponent(nodeId)}`);
      applyLibrarySnapshot(snapshot);
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
      setSelectionMenu(null);
      setStatus("Node deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete node.");
    }
  }

  async function deleteSelectedNodes(nodeIds: string[]) {
    setSelectionMenu(null);
    try {
      pushUndoSnapshot();
      let snapshot: LibrarySnapshot | null = null;
      for (const nodeId of nodeIds) {
        snapshot = await apiDelete<LibrarySnapshot>(`/api/libraries/current/nodes/${encodeURIComponent(nodeId)}`);
      }
      if (snapshot) applyLibrarySnapshot(snapshot);
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
      setStatus(nodeIds.length > 1 ? "Nodes deleted" : "Node deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete nodes.");
    }
  }

  async function deleteSelectedEdge(edgeId: string) {
    try {
      pushUndoSnapshot();
      const snapshot = await apiDelete<LibrarySnapshot>(`/api/libraries/current/edges/${encodeURIComponent(edgeId)}`);
      applyLibrarySnapshot(snapshot);
      setSelectedEdgeId(null);
      setStatus("Connection deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete connection.");
    }
  }

  function screenToWorld(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (clientX - bounds.left + canvas.scrollLeft - viewport.x) / viewportScale,
      y: (clientY - bounds.top + canvas.scrollTop - viewport.y) / viewportScale
    };
  }

  function isPointInsideCanvas(clientX: number, clientY: number): boolean {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const bounds = canvas.getBoundingClientRect();
    return clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom;
  }

  function viewportCenterWorldPoint() {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const bounds = canvas.getBoundingClientRect();
    return screenToWorld(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
  }

  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const selectedEdgeNotePosition = selectedEdge ? edgeMidpoint(selectedEdge, new Map(nodes.map((node) => [node.canvas.id, node.canvas]))) : null;

  return (
    <main className={`livingCanvasShell${libraryOpen ? "" : " libraryCollapsed"}${inspectorOpen ? " inspectorOpen" : ""}`}>
      {libraryOpen && (
        <aside className="libraryRail" data-canvas-wheel-scroll onWheelCapture={(event) => event.stopPropagation()}>
          <div className="brand panelBrand">
            <img src="/snarkroute-icon.png" alt="" />
            <div>
              <h1>SnarkRoute</h1>
              <span>Living Canvas</span>
            </div>
          </div>
          <div className="panelTitle">
            <Folder size={17} />
            <h2>Projects</h2>
            <button className="panelCollapseButton" type="button" onClick={() => setLibraryOpen(false)} title="Collapse library">
              <PanelRight size={16} />
            </button>
          </div>
          <button className="addLibraryButton" type="button" onClick={() => void addProject()}>
            <FolderPlus size={15} />
            Add Project
          </button>
          {projects.length ? (
          <div className="projectList">
            {projects.map((project) => (
              <button
                key={`${project.id}-${project.path}`}
                className={`projectItem${project.current ? " isCurrent" : ""}`}
                type="button"
                onClick={() => void openProject(project)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setProjectMenu({ x: event.clientX, y: event.clientY, project });
                }}
                title={project.title}
              >
                <span className="projectThumb">
                  {project.coverUrl ? <img src={`${apiBase}${project.coverUrl}`} alt="" /> : <Folder size={42} />}
                </span>
                <span>{project.title}</span>
              </button>
            ))}
          </div>
          ) : null}
        </aside>
      )}
      {!libraryOpen && (
        <>
          <img className="collapsedBrandIcon" src="/snarkroute-icon.png" alt="SnarkRoute" />
          <button className="libraryReopenButton" type="button" onClick={() => setLibraryOpen(true)} title="Open library">
            <PanelRight size={16} />
          </button>
        </>
      )}

      <section
        ref={canvasRef}
        className={`canvas canvasBackground-${background}${isDragging ? " isDragging" : ""}${dragState?.kind === "canvas" ? " isPanning" : ""}`}
        style={canvasStyle(background, viewport)}
        onPointerDown={handleCanvasPointerDown}
        onContextMenu={handleCanvasContextMenu}
        onWheelCapture={handleCanvasWheel}
        onWheel={handleCanvasWheel}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => void handleDrop(event)}
      >
        <div className="canvasWorld" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewportScale})` }}>
          <CanvasEdges
            nodes={nodes}
            edges={edges}
            preview={connectionPreview}
            selectedEdgeId={selectedEdgeId}
            onSyncRepresentation={(edgeId) => void syncRepresentationEdge(edgeId)}
            onOpenCrop={(nodeId, cropNodeId) => void openCropEditor(nodeId, cropNodeId)}
            onSelectEdge={(edgeId) => {
              setSelectedEdgeId(edgeId);
              setSelectedNodeId(null);
              setSelectedNodeIds([]);
            }}
          />
          {nodes.map((node) => {
            if (node.manifest.type === "library") {
              return (
                <LibraryCardNode
                  key={node.manifest.id}
                  node={node as LibraryNodeView}
                  active={selectedNodeIds.length === 1 && selectedNodeId === node.canvas.id}
                  selected={selectedNodeIds.includes(node.canvas.id)}
                  onPointerDown={handleNodePointerDown}
                  onClick={handleNodeClick}
                  onContextMenu={handleNodeContextMenu}
                  onViewModeChange={(viewMode) => void setLibraryViewMode(node.manifest.id, viewMode)}
                  onAssetContextMenu={(event, nodeId, assetId) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setLibraryAssetMenu({ x: event.clientX, y: event.clientY, nodeId, assetId });
                  }}
                />
              );
            }
            const nodeKind = pickerContentKind(node.manifest.type) ?? pickerContentKind(node.canvas.type);
            const nodeModels = modelsForPickerContentKind(pickerCatalogModels, nodeKind);
            return (
              <ImageNode
              key={node.manifest.id}
              node={node as ImageNodeView | VideoNodeView | TextNodeView}
              active={selectedNodeIds.length === 1 && selectedNodeId === node.canvas.id}
              selected={selectedNodeIds.includes(node.canvas.id)}
              inputNodes={inputChipsForNode(node.canvas.id, edges, nodeById)}
              onPointerDown={handleNodePointerDown}
              onClick={handleNodeClick}
              onContextMenu={handleNodeContextMenu}
              onContentContextMenu={(event, targetNode, kind) => {
                event.preventDefault();
                event.stopPropagation();
                setSelectionMenu(null);
                setStackItemMenu(null);
                setContentMenu({ x: event.clientX, y: event.clientY, nodeId: targetNode.canvas.id, kind });
              }}
              onInputPointerDown={handleInputPointerDown}
              onOutputPointerDown={handleOutputPointerDown}
              onOpenPreview={(nodeId, index, title) => setPreviewImage({ nodeId, index, title })}
              onOpenCrop={openCropEditor}
              onUploadStackImage={(nodeId) => void uploadImageToNodeStack(nodeId)}
              openStack={openStackNodeId === node.canvas.id}
              onToggleStack={(nodeId) => setOpenStackNodeId((current) => current === nodeId ? null : nodeId)}
              onSelectStackImage={(nodeId, index) => {
                if (interactionMovedRef.current) {
                  interactionMovedRef.current = false;
                  return;
                }
                void setActiveStackImage(nodeId, index);
              }}
              onDragStackImage={(event, nodeId, stackItemId) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                interactionMovedRef.current = false;
                const point = screenToWorld(event.clientX, event.clientY);
                setDragState({
                  kind: "stackItem",
                  pointerId: event.pointerId,
                  nodeId,
                  stackItemId,
                  startClientX: event.clientX,
                  startClientY: event.clientY,
                  currentX: point.x,
                  currentY: point.y
                });
              }}
              onStackItemContextMenu={(event, nodeId, stackItemId) => {
                event.preventDefault();
                event.stopPropagation();
                setStackItemMenu({ x: event.clientX, y: event.clientY, nodeId, stackItemId });
              }}
              models={nodeModels}
              modelSelection={normalizedModelRouteSelection("modelId" in node.manifest && node.manifest.modelId ? {
                modelId: node.manifest.modelId,
                executionProvider: node.manifest.executionProvider ?? "auto",
                fallbackAllowed: node.manifest.fallbackAllowed !== false
              } : modelSelections[node.canvas.id], nodeModels[0])}
              generationFeedback={generationFeedback[node.canvas.id]}
              modelSearchOpen={modelSearchNodeId === node.canvas.id}
              onToggleModelSearch={(nodeId) => setModelSearchNodeId((current) => current === nodeId ? null : nodeId)}
              onOpenModels={() => setInspectorOpen(true)}
              onSelectModel={(nodeId, selection) => {
                if (node.manifest.type === "text") void saveTextRouteSettings(nodeId, selection);
                else void saveMediaRouteSettings(node.manifest.type as "image" | "video", nodeId, selection);
                setModelSearchNodeId(null);
              }}
              onChangeRouteSettings={(nodeId, selection) => {
                if (node.manifest.type === "text") void saveTextRouteSettings(nodeId, selection);
                else void saveMediaRouteSettings(node.manifest.type as "image" | "video", nodeId, selection);
              }}
              onRunGeneration={(nodeId, selection, availableExecutionProviders, prompt, inputNodeIds, maxImageInputs, imageReferenceSyntax, parameters) => void runMediaGeneration(node.manifest.type as "image" | "video", nodeId, selection, availableExecutionProviders, prompt, inputNodeIds, maxImageInputs, imageReferenceSyntax, parameters)}
              onSavePrompt={(nodeId, prompt) => void saveMediaPrompt(nodeId, prompt)}
              onSaveText={saveTextNode}
              onSaveTextColor={saveTextNodeColor}
              onAddTextToStack={(nodeId, text) => void addTextToStack(nodeId, text)}
              onSelectTextStackItem={(nodeId, stackItemId) => {
                if (interactionMovedRef.current) {
                  interactionMovedRef.current = false;
                  return;
                }
                setOpenStackNodeId(null);
                void setActiveTextStackItem(nodeId, stackItemId);
              }}
              onRunTextGeneration={(nodeId, selection, providers, prompt, inputNodeIds, maxImageInputs, imageReferenceSyntax) => void runTextGeneration(nodeId, selection, providers, prompt, inputNodeIds, maxImageInputs, imageReferenceSyntax)}
              onRenameNode={(nodeId, title) => void renameNode(nodeId, title)}
            />
            );
          })}
          {selectedEdge && selectedEdgeNotePosition ? (
            <div
              className="edgeNoteEditor"
              style={{ transform: `translate(${selectedEdgeNotePosition.x - 118}px, ${selectedEdgeNotePosition.y + 24}px)` }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <textarea
                value={edgeNoteDraft}
                placeholder="Заметка"
                autoFocus
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setEdgeNoteDraft(value);
                  void saveEdgeNote(selectedEdge.id, value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setSelectedEdgeId(null);
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") setSelectedEdgeId(null);
                }}
              />
            </div>
          ) : null}
          {dragState?.kind === "stackItem" && interactionMovedRef.current ? (
            <div
              className="stackItemDragPreview"
              style={{
                transform: `translate(${dragState.currentX - imageNodeWidth / 2}px, ${dragState.currentY - imageNodeHeight / 2}px)`,
                width: imageNodeWidth,
                height: imageNodeHeight
              }}
            >
              <span>Drop to create node</span>
            </div>
          ) : null}
        </div>
        {nodeCreateMenu && (
          <div className="nodeCreateMenu" style={{ left: nodeCreateMenu.x, top: nodeCreateMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => void createConnectedNode("image")}>Create image node</button>
            <button type="button" onClick={() => void createConnectedNode("video")}>Create video node</button>
            <button type="button" onClick={() => void createConnectedNode("text")}>Create text node</button>
            {(() => {
              const sourceNode = nodeCreateMenu.fromNodeId ? nodes.find((node) => node.canvas.id === nodeCreateMenu.fromNodeId) : null;
              if (!sourceNode || sourceNode.manifest.type === "text") return null;
              return (
                <div className="nodeCreateSubmenu">
                  <button type="button" className="nodeCreateSubmenuTrigger">Change representation to...</button>
                  <div className="nodeCreateSubmenuPanel">
                    {nodeRepresentationOptions
                      .filter((option) => option.type !== sourceNode.manifest.type)
                      .map((option) => (
                        <button key={option.type} type="button" onClick={() => void createConnectedRepresentation(option.type)}>
                          {option.label}
                        </button>
                      ))}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
        {dragState?.kind === "selection" && (
          <div
            className="selectionRect"
            style={selectionRectStyle(dragState.startClientX, dragState.startClientY, dragState.currentClientX, dragState.currentClientY)}
          />
        )}
      </section>
      {previewImage && (
        <div className="previewOverlay" role="dialog" aria-modal="true" onClick={() => setPreviewImage(null)}>
          <div className="previewDialog" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="previewClose" onClick={() => setPreviewImage(null)}>×</button>
            <StackPreview
              preview={previewImage}
              node={nodes.find((node) => node.canvas.id === previewImage.nodeId && (node.manifest.type === "image" || node.manifest.type === "video")) as ImageNodeView | VideoNodeView | undefined}
              onChangeIndex={(index) => setPreviewImage({ ...previewImage, index })}
              onMakeMain={(nodeId, index) => void setActiveStackImage(nodeId, index)}
            />
          </div>
        </div>
      )}
      {cropDraft ? (
        <CropEditor
          draft={cropDraft}
          onClose={() => setCropDraft(null)}
          onApply={(draft, dataUrl) => void applyCropResult(draft, dataUrl)}
        />
      ) : null}
      {stackItemMenu && (
        <div className="stackItemMenu" style={{ left: stackItemMenu.x, top: stackItemMenu.y }}>
          <button type="button" onClick={() => void duplicateStackItemNode(stackItemMenu.nodeId, stackItemMenu.stackItemId, screenToWorld(stackItemMenu.x, stackItemMenu.y))}>
            {nodes.find((node) => node.canvas.id === stackItemMenu.nodeId)?.manifest.type === "text" ? "Create text node" : "Transform to node"}
          </button>
          {nodes.find((node) => node.canvas.id === stackItemMenu.nodeId)?.manifest.type === "text" ? (
            <button type="button" onClick={() => void useTextStackItemAsDraft(stackItemMenu.nodeId, stackItemMenu.stackItemId)}>Use in text field</button>
          ) : null}
          <button type="button" onClick={() => void deleteStackItem(stackItemMenu.nodeId, stackItemMenu.stackItemId)}>Delete</button>
          {nodes.find((node) => node.canvas.id === stackItemMenu.nodeId)?.manifest.type !== "text" ? (
            <button type="button" onClick={() => void saveStackItem(stackItemMenu.nodeId, stackItemMenu.stackItemId)}>Save</button>
          ) : null}
        </div>
      )}
      {contentMenu && (
        <div ref={contentMenuRef} className="contentMenu" style={{ left: contentMenu.x, top: contentMenu.y }} tabIndex={-1}>
          {contentMenu.kind !== "video" ? (
            <button type="button" onClick={() => void copyContent(contentMenu)}><Copy size={14} /> Copy</button>
          ) : null}
          <button type="button" onClick={() => void saveContent(contentMenu)}><Save size={14} /> Save</button>
        </div>
      )}
      {projectMenu && (
        <div className="projectMenu" style={{ left: projectMenu.x, top: projectMenu.y }}>
          <button type="button" onClick={() => void copyProject(projectMenu.project)}><Copy size={14} /> Copy</button>
          <button type="button" onClick={() => void pasteProject()}><Clipboard size={14} /> Paste</button>
          <button type="button" onClick={() => void openCoverPicker(projectMenu.project)}><ImageIcon size={14} /> Choose Cover</button>
          <button type="button" onClick={() => void removeProject(projectMenu.project)}><Trash2 size={14} /> Delete</button>
          <button type="button" onClick={() => void openProjectInExplorer(projectMenu.project)}><ExternalLink size={14} /> Open in Explorer</button>
          <button type="button" onClick={() => void importProject(projectMenu.project)}><FileUp size={14} /> Import</button>
          <button type="button" onClick={() => exportProject(projectMenu.project)}><FileDown size={14} /> Export</button>
        </div>
      )}
      {coverPicker && (
        <div className="coverPickerOverlay" role="dialog" aria-modal="true" onClick={() => setCoverPicker(null)}>
          <div className="coverPickerDialog" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>{coverPicker.project.title}</strong>
              <button type="button" onClick={() => setCoverPicker(null)}>Close</button>
            </header>
            <div className="coverPickerGrid">
              {coverPicker.images.map((image) => (
                <button key={image.id} type="button" onClick={() => void chooseProjectCover(coverPicker.project, image)} title={image.title}>
                  <img src={`${apiBase}${image.url}`} alt="" />
                  <span>{image.title}</span>
                </button>
              ))}
              {coverPicker.images.length === 0 ? <p>No images found in this project.</p> : null}
            </div>
          </div>
        </div>
      )}
      {libraryAssetMenu && (
        <div className="stackItemMenu" style={{ left: libraryAssetMenu.x, top: libraryAssetMenu.y }}>
          <button type="button" onClick={() => void deleteLibraryAsset(libraryAssetMenu.nodeId, libraryAssetMenu.assetId)}>Delete from library</button>
        </div>
      )}
      {selectionMenu && selectedNodeIds.length > 0 && (
        <div className="selectionMenu" style={{ left: selectionMenu.x, top: selectionMenu.y }}>
          <button type="button" onClick={() => void duplicateNode(selectionMenu.nodeId)}>Duplicate node</button>
          {(() => {
            const sourceNode = nodes.find((node) => node.canvas.id === selectionMenu.nodeId);
            if (!sourceNode || sourceNode.manifest.type === "text") return null;
            return (
              <div className="nodeCreateSubmenu">
                <button type="button" className="nodeCreateSubmenuTrigger">Change representation to...</button>
                <div className="nodeCreateSubmenuPanel">
                  {nodeRepresentationOptions
                    .filter((option) => option.type !== sourceNode.manifest.type)
                    .map((option) => (
                      <button key={option.type} type="button" onClick={() => void duplicateNodeAsRepresentation(selectionMenu.nodeId, option.type)}>
                        {option.label}
                      </button>
                    ))}
                </div>
              </div>
            );
          })()}
          <button type="button" onClick={() => copyNode(selectionMenu.nodeId)}>Copy node</button>
          <button type="button" disabled={!copiedNodeId} onClick={() => copiedNodeId && void duplicateNode(copiedNodeId, selectionMenu.nodeId, "pasted")}>Paste node</button>
          <button type="button" onClick={() => void openNodeAsFolder(selectionMenu.nodeId)}>Open folder</button>
          <button type="button" onClick={() => void deleteSelectedNodes(selectedNodeIds)}>
            Delete {selectedNodeIds.length > 1 ? `${selectedNodeIds.length} nodes` : "node"}
          </button>
        </div>
      )}

      {inspectorOpen && (
        <aside className="inspector" data-canvas-wheel-scroll onWheelCapture={(event) => event.stopPropagation()}>
          <div className="toolbar panelToolbar" aria-label="Canvas controls">
            <button className="iconButton" type="button" onClick={() => setTheme(theme === "night" ? "day" : "night")} title={theme === "night" ? "Switch to day" : "Switch to night"}>
              {theme === "night" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <label className="sceneSelect" title="Canvas background">
              <Wallpaper size={17} />
              <select value={background} onChange={(event) => setBackground(event.target.value as BackgroundName)} aria-label="Canvas background">
                {backgroundOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button className="iconButton" type="button" onClick={() => setInspectorOpen(false)} title="Close context">
              <PanelRight size={18} />
            </button>
          </div>
          <ModelsPanel
            settings={providerSettings}
            errors={providerErrors}
            notices={providerNotice}
            models={availableCatalogModels}
            localProviders={localProviders}
            onConnect={saveProviderToken}
            onTest={testProvider}
            onRefresh={refreshProviderModels}
            onAddCustomModel={addCustomModel}
            onSaveLocalProvider={(profile) => void testAndSaveLocalProvider(profile)}
          />
        </aside>
      )}
      {!inspectorOpen && (
        <button className="inspectorReopenButton" type="button" onClick={() => setInspectorOpen(true)} title="Open context">
          <PanelRight size={18} />
        </button>
      )}
    </main>
  );
}

function ModelsPanel({
  settings,
  errors,
  notices,
  models,
  localProviders,
  onConnect,
  onTest,
  onRefresh,
  onAddCustomModel,
  onSaveLocalProvider
}: {
  settings: ProviderSettings | null;
  errors: Partial<Record<string, string>>;
  notices: Partial<Record<string, string>>;
  models: ModelOption[];
  localProviders: LocalProviderConnection[];
  onConnect: (providerId: ProviderId, key: string, extras?: Record<string, string>) => Promise<void>;
  onTest: (providerId: ProviderId) => Promise<void>;
  onRefresh: (providerId: ProviderId) => Promise<void>;
  onAddCustomModel: (profile: Omit<ModelOption, "isAvailable" | "statusReason">) => void;
  onSaveLocalProvider: (profile: Omit<LocalProviderConnection, "status" | "statusReason">) => void;
}) {
  return (
    <div className="modelsPanel">
      <div className="panelTitle">
        <Cog size={17} />
        <h2>Модели</h2>
      </div>
      <section className="modelsSection">
        <h3>Connected sources</h3>
        {providerDefinitions.map((definition) => (
          <ProviderConnectionCard
            key={definition.id}
            definition={definition}
            configured={Boolean(settings?.[definition.id]?.configured)}
            offline={Boolean(errors.settings)}
            error={errors[definition.id]}
            notice={notices[definition.id]}
            modelCounts={providerModelCounts(models, definition.id)}
            onConnect={onConnect}
            onTest={onTest}
            onRefresh={onRefresh}
          />
        ))}
        {localProviders.map((provider) => (
          <article className="providerCard" key={provider.id}>
            <div className="providerHeading">
              <strong>{provider.title}</strong>
              <span className={`providerStatus is-${provider.status}`}>{provider.status}</span>
            </div>
            <p>{provider.providerType} / {provider.endpointUrl}</p>
            {provider.statusReason ? <small className="providerMessage isError">{provider.statusReason}</small> : null}
          </article>
        ))}
      </section>
      <AvailableModels models={models} />
      <CustomModelForm onAdd={onAddCustomModel} />
      <LocalProviderForm onSave={onSaveLocalProvider} />
    </div>
  );
}

function ProviderConnectionCard({
  definition,
  configured,
  offline,
  error,
  notice,
  modelCounts,
  onConnect,
  onTest,
  onRefresh
}: {
  definition: ProviderDefinition;
  configured: boolean;
  offline: boolean;
  error?: string;
  notice?: string;
  modelCounts: string[];
  onConnect: (providerId: ProviderId, key: string, extras?: Record<string, string>) => Promise<void>;
  onTest: (providerId: ProviderId) => Promise<void>;
  onRefresh: (providerId: ProviderId) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [seedanceBackend, setSeedanceBackend] = useState("seedance-compatible");
  const status = offline ? "offline" : error ? "error" : configured ? "connected" : "missing key";

  async function connect() {
    if (!key.trim()) return;
    await onConnect(definition.id, key, definition.id === "seedance" ? { backend: seedanceBackend } : undefined);
    setKey("");
    setEditing(false);
  }

  return (
    <article className="providerCard">
      <div className="providerHeading">
        <strong>{definition.title}</strong>
        <span className={`providerStatus is-${status.replace(" ", "-")}`}>{status}</span>
      </div>
      <p>{definition.capabilityText}</p>
      {modelCounts.length > 0 ? <small>{modelCounts.join(" / ")}</small> : null}
      {error ? <small className="providerMessage isError">{error}</small> : notice ? <small className="providerMessage">{notice}</small> : null}
      {editing && (
        <div className="providerConnectForm">
          <input
            type="password"
            autoComplete="off"
            value={key}
            placeholder={`${definition.title} API key`}
            onChange={(event) => setKey(event.currentTarget.value)}
          />
          {definition.id === "seedance" ? (
            <select value={seedanceBackend} onChange={(event) => setSeedanceBackend(event.currentTarget.value)}>
              <option value="seedance-compatible">Compatible endpoint</option>
              <option value="byteplus-modelark">BytePlus ModelArk</option>
              <option value="volcengine-las">Volcengine LAS</option>
            </select>
          ) : null}
          <button type="button" disabled={!key.trim()} onClick={() => void connect()}>Save key</button>
        </div>
      )}
      <div className="providerActions">
        <button type="button" onClick={() => setEditing((value) => !value)}>{configured ? "Edit" : "Подключить"}</button>
        <button type="button" onClick={() => void onTest(definition.id)}>Test</button>
        {definition.refreshModels ? <button type="button" onClick={() => void onRefresh(definition.id)}>Refresh models</button> : null}
      </div>
    </article>
  );
}

function AvailableModels({ models }: { models: ModelOption[] }) {
  const groups: Array<{ label: string; includes: (model: ModelOption) => boolean }> = [
    { label: "Image", includes: (model) => modelMatchesAvailableGroup(model, "image") },
    { label: "Video", includes: (model) => modelMatchesAvailableGroup(model, "video") },
    { label: "Text", includes: (model) => modelMatchesAvailableGroup(model, "text") },
    { label: "Audio", includes: (model) => modelMatchesAvailableGroup(model, "audio") },
    { label: "Image upscalers", includes: (model) => modelMatchesAvailableGroup(model, "image-upscaler") },
    { label: "Video upscalers", includes: (model) => modelMatchesAvailableGroup(model, "video-upscaler") }
  ];
  return (
    <section className="modelsSection availableModels">
      <h3>Available models</h3>
      {groups.map(({ label, includes }) => {
        const entries = mergeModelsForDisplay(models.filter(includes));
        if (entries.length === 0) return null;
        return (
          <details className="modelGroup" key={label}>
            <summary>
              <strong>{label}</strong>
              <small>{entries.length}</small>
            </summary>
            <div className="modelGroupList">
              {entries.map(({ model, providers }) => {
                const source = providers.map(providerDisplayName).join(", ");
                return (
                <span className={model.isAvailable ? "" : "isUnavailable"} key={modelSelectionId(model)}>
                  {model.title} <small title={model.statusReason}>{source}</small>
                </span>
                );
              })}
            </div>
          </details>
        );
      })}
    </section>
  );
}

function modelMatchesAvailableGroup(model: ModelOption, group: ContentKind | ModelRole): boolean {
  return modelMatchesCatalogGroup(model, group);
}

function CustomModelForm({ onAdd }: { onAdd: (profile: Omit<ModelOption, "isAvailable" | "statusReason">) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [url, setUrl] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const [title, setTitle] = useState("");
  const [providerType, setProviderType] = useState("custom");
  const [inputKinds, setInputKinds] = useState("text");
  const [outputKinds, setOutputKinds] = useState("image");
  const [capabilities, setCapabilities] = useState("image.generate");

  function revealManualProfile() {
    setExpanded(true);
    setUnsupported(true);
  }

  function addProfile() {
    if (!title.trim() || !url.trim()) return;
    const accepts = parseKinds(inputKinds);
    const produces = parseKinds(outputKinds);
    if (produces.length === 0) return;
    onAdd({
      id: `custom:${url.trim()}`,
      title: title.trim(),
      providerId: providerType.trim() || "custom",
      source: "custom-link",
      contentKinds: produces,
      accepts,
      produces,
      capabilities: capabilities.split(",").map((value) => value.trim()).filter(Boolean)
    });
    setTitle("");
  }

  return (
    <section className="modelsSection addModelForm">
      <button className="modelsAddButton" type="button" onClick={() => setExpanded((value) => !value)}>+ Add model by link</button>
      {expanded && (
        <>
          <label>Model URL<input value={url} onChange={(event) => setUrl(event.currentTarget.value)} placeholder="https://..." /></label>
          <button type="button" disabled={!url.trim()} onClick={revealManualProfile}>Add</button>
          {unsupported && (
            <div className="manualProfile">
              <p>Автоматическое распознавание этой ссылки пока не поддерживается. Опишите модель вручную.</p>
              <label>Title<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
              <label>Provider type<input value={providerType} onChange={(event) => setProviderType(event.currentTarget.value)} /></label>
              <label>Endpoint URL<input value={url} onChange={(event) => setUrl(event.currentTarget.value)} /></label>
              <label>Input kinds<input value={inputKinds} onChange={(event) => setInputKinds(event.currentTarget.value)} /></label>
              <label>Output kinds<input value={outputKinds} onChange={(event) => setOutputKinds(event.currentTarget.value)} /></label>
              <label>Capabilities<input value={capabilities} onChange={(event) => setCapabilities(event.currentTarget.value)} /></label>
              <button type="button" disabled={!title.trim() || parseKinds(outputKinds).length === 0} onClick={addProfile}>Save custom profile</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function LocalProviderForm({ onSave }: { onSave: (profile: Omit<LocalProviderConnection, "status" | "statusReason">) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState("Local ComfyUI");
  const [providerType, setProviderType] = useState("ComfyUI");
  const [endpointUrl, setEndpointUrl] = useState("http://127.0.0.1:8188");
  return (
    <section className="modelsSection addModelForm">
      <button className="modelsAddButton" type="button" onClick={() => setExpanded((value) => !value)}>+ Add local model</button>
      {expanded && (
        <>
          <label>Title<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
          <label>Provider type<input value={providerType} onChange={(event) => setProviderType(event.currentTarget.value)} /></label>
          <label>Local endpoint URL<input value={endpointUrl} onChange={(event) => setEndpointUrl(event.currentTarget.value)} /></label>
          <button type="button" disabled={!endpointUrl.trim()} onClick={() => onSave({ id: `local:${endpointUrl.trim()}`, title, providerType, endpointUrl: endpointUrl.trim() })}>
            Test connection and save
          </button>
          <p>Workflow discovery and execution adapter will be added separately.</p>
        </>
      )}
    </section>
  );
}

function parseKinds(value: string): ContentKind[] {
  return value.split(",").map((kind) => kind.trim().toLowerCase()).filter((kind): kind is ContentKind => kind === "image" || kind === "video" || kind === "text" || kind === "audio");
}

function supportsLocalModelDiscovery(providerType: string): boolean {
  return /comfy|stable diffusion|a1111|automatic1111/i.test(providerType);
}

async function discoverLocalModels(endpointUrl: string, providerType: string): Promise<LocalProviderConnection["models"]> {
  const catalog = await apiGet<{ models?: LocalProviderConnection["models"] }>(`/api/local-stable-diffusion/models?endpoint=${encodeURIComponent(endpointUrl)}&providerType=${encodeURIComponent(providerType)}`);
  return catalog.models ?? [];
}

function providerModelCounts(models: ModelOption[], providerId: string): string[] {
  return (["image", "video", "text", "audio"] as ContentKind[]).flatMap((kind) => {
    const count = models.filter((model) => model.providerId === providerId && modelMatchesAvailableGroup(model, kind)).length;
    return count ? [`${kind}: ${count}`] : [];
  }).concat(
    models.some((model) => model.providerId === providerId && modelMatchesAvailableGroup(model, "image-upscaler")) ? ["image upscalers"] : [],
    models.some((model) => model.providerId === providerId && modelMatchesAvailableGroup(model, "video-upscaler")) ? ["video upscalers"] : []
  );
}

function LibraryCardNode({
  node,
  active,
  selected,
  onPointerDown,
  onClick,
  onContextMenu,
  onViewModeChange,
  onAssetContextMenu
}: {
  node: LibraryNodeView;
  active: boolean;
  selected: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLElement>, node: NodeView) => void;
  onClick: (event: React.MouseEvent<HTMLElement>, node: NodeView) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>, node: NodeView) => void;
  onViewModeChange: (viewMode: LibraryViewMode) => void;
  onAssetContextMenu: (event: React.MouseEvent<HTMLElement>, nodeId: string, assetId: string) => void;
}) {
  const images = node.scan.assets.filter((asset) => asset.kind === "image");
  const texts = node.scan.assets.filter((asset) => asset.kind === "text");
  const prompts = node.scan.assets.filter((asset) => asset.kind === "prompt" || asset.embeddedPrompt);
  const displayAssets = node.manifest.viewMode === "image-stack"
    ? images
    : node.manifest.viewMode === "text-library"
      ? texts
      : node.manifest.viewMode === "prompt-library"
        ? prompts
        : node.scan.assets;
  return (
    <article
      className={`libraryNode${active ? " isActive" : ""}${selected ? " isSelected" : ""}`}
      style={{ transform: `translate(${node.canvas.x}px, ${node.canvas.y}px)`, width: node.canvas.width, minHeight: node.canvas.height }}
      onPointerDown={(event) => onPointerDown(event, node)}
      onClick={(event) => onClick(event, node)}
      onContextMenu={(event) => onContextMenu(event, node)}
    >
      <header className="libraryNodeHeader">
        <Folder size={15} />
        <strong>{node.manifest.title}</strong>
      </header>
      <span className="libraryNodePath">{node.scan.sourcePath}</span>
      {node.scan.error ? <p className="libraryPlaceholder">Source unavailable: {node.scan.error}</p> : null}
      <label className="libraryModeSelect" onPointerDown={(event) => event.stopPropagation()}>
        <span>Open as</span>
        <select value={node.manifest.viewMode} onChange={(event) => onViewModeChange(event.target.value as LibraryViewMode)}>
          {node.scan.availableViews.map((mode) => <option key={mode} value={mode}>{libraryViewLabel(mode)}</option>)}
        </select>
      </label>
      <div className="libraryAssetGrid">
        {displayAssets.slice(0, 6).map((asset) => (
          <div key={asset.id} className="libraryAsset" title={asset.relativePath} onContextMenu={(event) => onAssetContextMenu(event, node.manifest.id, asset.id)}>
            {asset.kind === "image" ? <img src={libraryAssetUrl(node.manifest.id, asset.id)} alt="" /> : <span>{asset.kind === "prompt" || asset.embeddedPrompt ? "Prompt" : asset.kind}</span>}
            {asset.embeddedPrompt ? <small>Prompt inside</small> : null}
          </div>
        ))}
        {displayAssets.length === 0 ? <p className="libraryEmpty">No assets for this view.</p> : null}
      </div>
      {(node.manifest.viewMode === "board" || node.manifest.viewMode === "workflow") && (
        <p className="libraryPlaceholder">{node.manifest.viewMode === "board" ? "Board opening is reserved for the next canvas step." : "Workflow is available as an action source; execution wiring comes next."}</p>
      )}
    </article>
  );
}

function libraryViewLabel(mode: LibraryViewMode): string {
  const labels: Record<LibraryViewMode, string> = {
    "media-folder": "Media Folder",
    "image-stack": "Image Stack",
    "text-library": "Text Library",
    "prompt-library": "Prompt Library",
    board: "Board",
    workflow: "Workflow / Action Source"
  };
  return labels[mode];
}

function libraryAssetUrl(nodeId: string, assetId: string): string {
  return `${apiBase}/api/libraries/current/library-nodes/${encodeURIComponent(nodeId)}/assets/${encodeURIComponent(assetId)}`;
}

function CanvasEdges({
  nodes,
  edges,
  preview,
  selectedEdgeId,
  onSyncRepresentation,
  onOpenCrop,
  onSelectEdge
}: {
  nodes: NodeView[];
  edges: CanvasEdge[];
  preview: Extract<DragState, { kind: "connection" }> | null;
  selectedEdgeId: string | null;
  onSyncRepresentation: (edgeId: string) => void;
  onOpenCrop: (nodeId: string, cropNodeId?: string) => void;
  onSelectEdge: (edgeId: string) => void;
}) {
  const nodeById = new Map(nodes.map((node) => [node.canvas.id, node.canvas]));
  const viewById = new Map(nodes.map((node) => [node.canvas.id, node]));
  const previewSourceNode = preview ? viewById.get(preview.direction === "fromOutput" ? preview.fromNodeId : preview.toNodeId ?? preview.fromNodeId) : undefined;
  return (
    <svg className="canvasEdges">
      {edges.map((edge) => {
        const from = nodeById.get(edge.fromNodeId);
        const to = nodeById.get(edge.toNodeId);
        const sourceNode = viewById.get(edge.fromNodeId);
        if (!from || !to) return null;
        const start = nodeOutputPoint(from);
        const end = nodeInputPoint(to);
        const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
        return (
          <React.Fragment key={edge.id}>
            <path
              className={selectedEdgeId === edge.id ? "isSelected" : ""}
              d={edgePath(start, end)}
              style={{ "--edge-color": nodeTypeWireColor(sourceNode) } as React.CSSProperties}
              onClick={(event) => { event.stopPropagation(); onSelectEdge(edge.id); }}
            />
            {edge.kind === "representation" ? (
              <foreignObject x={midpoint.x - 14} y={midpoint.y - 14} width={28} height={28}>
                <button
                  className="edgeSyncButton"
                  type="button"
                  title="Refresh representation"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSyncRepresentation(edge.id);
                  }}
                >
                  <RefreshCw size={13} />
                </button>
              </foreignObject>
            ) : null}
            {edge.kind === "crop" ? (
              <foreignObject x={midpoint.x - 14} y={midpoint.y - 14} width={28} height={28}>
                <button
                  className="edgeSyncButton"
                  type="button"
                  title="Crop again"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenCrop(edge.fromNodeId, edge.toNodeId);
                  }}
                >
                  <Crop size={13} />
                </button>
              </foreignObject>
            ) : null}
            {edge.note ? (
              <foreignObject x={midpoint.x - 12} y={midpoint.y + 12} width={24} height={24}>
                <button
                  type="button"
                  className={`edgeNoteBadge${selectedEdgeId === edge.id ? " isSelected" : ""}`}
                  title={edge.note}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectEdge(edge.id);
                  }}
                />
              </foreignObject>
            ) : null}
          </React.Fragment>
        );
      })}
      {preview && <path className="edgePreview" d={edgePath({ x: preview.startX, y: preview.startY }, { x: preview.currentX, y: preview.currentY })} style={{ "--edge-color": nodeTypeWireColor(previewSourceNode) } as React.CSSProperties} />}
    </svg>
  );
}

const cropAspectOptions: Array<{ label: string; ratio: number | null }> = [
  { label: "Free", ratio: null },
  { label: "1:1", ratio: 1 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "3:4", ratio: 3 / 4 },
  { label: "16:9", ratio: 16 / 9 },
  { label: "9:16", ratio: 9 / 16 },
  { label: "3:2", ratio: 3 / 2 },
  { label: "2:3", ratio: 2 / 3 }
];

type CropCorner = "nw" | "ne" | "sw" | "se";

type CropDragState =
  | { kind: "move"; start: { x: number; y: number }; startRect: CropRect }
  | { kind: "resize"; corner: CropCorner; startRect: CropRect };

function CropEditor({
  draft,
  onClose,
  onApply
}: {
  draft: CropDraft;
  onClose: () => void;
  onApply: (draft: CropDraft, dataUrl: string) => void;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStateRef = useRef<CropDragState | null>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [rect, setRect] = useState(draft.rect);
  const [aspectRatio, setAspectRatio] = useState<number | null>(draft.aspectRatio);

  useEffect(() => {
    setRect(draft.rect);
    setAspectRatio(draft.aspectRatio);
  }, [draft]);

  function pointerPoint(event: React.PointerEvent<HTMLDivElement>) {
    const image = imageRef.current;
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1)
    };
  }

  function pointInRect(point: { x: number; y: number }, target: CropRect) {
    return point.x >= target.x && point.x <= target.x + target.width && point.y >= target.y && point.y <= target.y + target.height;
  }

  function cornerAt(point: { x: number; y: number }): CropCorner | null {
    const image = imageRef.current;
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    const thresholdX = Math.max(14 / Math.max(bounds.width, 1), 0.018);
    const thresholdY = Math.max(14 / Math.max(bounds.height, 1), 0.018);
    const corners: Array<{ corner: CropCorner; x: number; y: number }> = [
      { corner: "nw", x: rect.x, y: rect.y },
      { corner: "ne", x: rect.x + rect.width, y: rect.y },
      { corner: "sw", x: rect.x, y: rect.y + rect.height },
      { corner: "se", x: rect.x + rect.width, y: rect.y + rect.height }
    ];
    return corners.find((candidate) => Math.abs(point.x - candidate.x) <= thresholdX && Math.abs(point.y - candidate.y) <= thresholdY)?.corner ?? null;
  }

  function moveRect(state: Extract<CropDragState, { kind: "move" }>, point: { x: number; y: number }): CropRect {
    const dx = point.x - state.start.x;
    const dy = point.y - state.start.y;
    return {
      ...state.startRect,
      x: clamp(state.startRect.x + dx, 0, Math.max(0, 1 - state.startRect.width)),
      y: clamp(state.startRect.y + dy, 0, Math.max(0, 1 - state.startRect.height))
    };
  }

  function resizeRect(state: Extract<CropDragState, { kind: "resize" }>, point: { x: number; y: number }): CropRect {
    const minSize = 0.02;
    const start = state.startRect;
    const growsRight = state.corner === "ne" || state.corner === "se";
    const growsDown = state.corner === "sw" || state.corner === "se";
    const anchor = {
      x: growsRight ? start.x : start.x + start.width,
      y: growsDown ? start.y : start.y + start.height
    };
    const maxWidth = growsRight ? 1 - anchor.x : anchor.x;
    const maxHeight = growsDown ? 1 - anchor.y : anchor.y;
    let width = clamp(Math.abs(point.x - anchor.x), minSize, Math.max(minSize, maxWidth));
    let height = clamp(Math.abs(point.y - anchor.y), minSize, Math.max(minSize, maxHeight));

    if (aspectRatio && naturalSize.width > 0 && naturalSize.height > 0) {
      const normalizedRatio = aspectRatio * naturalSize.height / naturalSize.width;
      if (width / Math.max(height, 0.001) > normalizedRatio) width = height * normalizedRatio;
      else height = width / normalizedRatio;
      if (width > maxWidth) {
        width = Math.max(minSize, maxWidth);
        height = width / normalizedRatio;
      }
      if (height > maxHeight) {
        height = Math.max(minSize, maxHeight);
        width = height * normalizedRatio;
      }
    }

    return {
      x: growsRight ? anchor.x : anchor.x - width,
      y: growsDown ? anchor.y : anchor.y - height,
      width,
      height
    };
  }

  function applyAspect(ratio: number | null) {
    setAspectRatio(ratio);
    if (!ratio || naturalSize.width <= 0 || naturalSize.height <= 0) return;
    const normalizedRatio = ratio * naturalSize.height / naturalSize.width;
    let width = rect.width;
    let height = width / normalizedRatio;
    if (height > 1) {
      height = rect.height;
      width = height * normalizedRatio;
    }
    setRect({
      x: clamp(rect.x + rect.width / 2 - width / 2, 0, Math.max(0, 1 - width)),
      y: clamp(rect.y + rect.height / 2 - height / 2, 0, Math.max(0, 1 - height)),
      width: clamp(width, 0.02, 1),
      height: clamp(height, 0.02, 1)
    });
  }

  function crop() {
    const image = imageRef.current;
    if (!image || naturalSize.width <= 0 || naturalSize.height <= 0) return;
    const sourceX = Math.round(rect.x * naturalSize.width);
    const sourceY = Math.round(rect.y * naturalSize.height);
    const sourceWidth = Math.max(1, Math.round(rect.width * naturalSize.width));
    const sourceHeight = Math.max(1, Math.round(rect.height * naturalSize.height));
    const canvas = document.createElement("canvas");
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
    onApply({ ...draft, rect, aspectRatio }, canvas.toDataURL("image/png"));
  }

  return (
    <div className="cropOverlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="cropWindow" onClick={(event) => event.stopPropagation()}>
        <header>
          <strong>{draft.title}</strong>
          <button type="button" onClick={onClose}>×</button>
        </header>
        <div className="cropBody">
          <div className="cropStage">
            <div
              className="cropFrame"
              onPointerDown={(event) => {
                const point = pointerPoint(event);
                if (!point) return;
                const corner = cornerAt(point);
                if (corner) dragStateRef.current = { kind: "resize", corner, startRect: rect };
                else if (pointInRect(point, rect)) dragStateRef.current = { kind: "move", start: point, startRect: rect };
                else return;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const state = dragStateRef.current;
                const point = pointerPoint(event);
                if (!state || !point) return;
                setRect(state.kind === "move" ? moveRect(state, point) : resizeRect(state, point));
              }}
              onPointerUp={() => { dragStateRef.current = null; }}
              onPointerCancel={() => { dragStateRef.current = null; }}
            >
              <img
                ref={imageRef}
                src={draft.src}
                alt=""
                draggable={false}
                onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              />
              <div className="cropShade" style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${rect.y * 100}%, ${rect.x * 100}% ${rect.y * 100}%, ${rect.x * 100}% ${(rect.y + rect.height) * 100}%, ${(rect.x + rect.width) * 100}% ${(rect.y + rect.height) * 100}%, ${(rect.x + rect.width) * 100}% ${rect.y * 100}%, 0 ${rect.y * 100}%)` }} />
              <div className="cropBox" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}>
                <span className="cropHandle isNorthWest" />
                <span className="cropHandle isNorthEast" />
                <span className="cropHandle isSouthWest" />
                <span className="cropHandle isSouthEast" />
              </div>
            </div>
          </div>
          <aside>
            <span>Format</span>
            <div className="cropAspectGrid">
              {cropAspectOptions.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={option.ratio === aspectRatio ? "isSelected" : ""}
                  onClick={() => applyAspect(option.ratio)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="cropReadout">
              <span>x {Math.round(rect.x * naturalSize.width)}</span>
              <span>y {Math.round(rect.y * naturalSize.height)}</span>
              <span>w {Math.round(rect.width * naturalSize.width)}</span>
              <span>h {Math.round(rect.height * naturalSize.height)}</span>
            </div>
            <button type="button" className="cropApply" onClick={crop}><Crop size={16} /> Crop</button>
          </aside>
        </div>
      </div>
    </div>
  );
}

function ImageNode({
  node,
  active,
  selected,
  inputNodes,
  onPointerDown,
  onClick,
  onContextMenu,
  onContentContextMenu,
  onInputPointerDown,
  onOutputPointerDown,
  onOpenPreview,
  onOpenCrop,
  onUploadStackImage,
  openStack,
  onToggleStack,
  onSelectStackImage,
  onDragStackImage,
  onStackItemContextMenu,
  models,
  modelSelection,
  generationFeedback,
  modelSearchOpen,
  onToggleModelSearch,
  onOpenModels,
  onSelectModel,
  onChangeRouteSettings,
  onRunGeneration,
  onSavePrompt,
  onSaveText,
  onSaveTextColor,
  onAddTextToStack,
  onSelectTextStackItem,
  onRunTextGeneration,
  onRenameNode
}: {
  node: EditableNodeView;
  active: boolean;
  selected: boolean;
  inputNodes: InputNodeChip[];
  onPointerDown: (event: React.PointerEvent<HTMLElement>, node: NodeView) => void;
  onClick: (event: React.MouseEvent<HTMLElement>, node: NodeView) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>, node: NodeView) => void;
  onContentContextMenu: (event: React.MouseEvent<HTMLElement>, node: EditableNodeView, kind: "text" | "image" | "video") => void;
  onInputPointerDown: (event: React.PointerEvent<HTMLElement>, node: NodeView) => void;
  onOutputPointerDown: (event: React.PointerEvent<HTMLElement>, node: NodeView) => void;
  onOpenPreview: (nodeId: string, index: number, title: string) => void;
  onOpenCrop: (nodeId: string) => void;
  onUploadStackImage: (nodeId: string) => void;
  openStack: boolean;
  onToggleStack: (nodeId: string) => void;
  onSelectStackImage: (nodeId: string, index: number) => void;
  onDragStackImage: (event: React.PointerEvent<HTMLElement>, nodeId: string, stackItemId: string) => void;
  onStackItemContextMenu: (event: React.MouseEvent<HTMLElement>, nodeId: string, stackItemId: string) => void;
  models: ModelOption[];
  modelSelection: ModelRouteSelection;
  generationFeedback?: GenerationFeedback;
  modelSearchOpen: boolean;
  onToggleModelSearch: (nodeId: string) => void;
  onOpenModels: () => void;
  onSelectModel: (nodeId: string, selection: ModelRouteSelection) => void;
  onChangeRouteSettings: (nodeId: string, selection: ModelRouteSelection) => void;
  onRunGeneration: (nodeId: string, selection: ModelRouteSelection, availableExecutionProviders: string[], prompt: string, inputNodeIds?: string[], maxImageInputs?: number, imageReferenceSyntax?: string, parameters?: ImageGenerationParameters) => void;
  onSavePrompt: (nodeId: string, prompt: string) => void;
  onSaveText: (nodeId: string, text: string) => void;
  onSaveTextColor: (nodeId: string, color: string) => void;
  onAddTextToStack: (nodeId: string, text: string) => void;
  onSelectTextStackItem: (nodeId: string, stackItemId: string | null) => void;
  onRunTextGeneration: (nodeId: string, selection: ModelRouteSelection, availableExecutionProviders: string[], prompt: string, inputNodeIds?: string[], maxImageInputs?: number, imageReferenceSyntax?: string) => void;
  onRenameNode: (nodeId: string, title: string) => void;
}) {
  const previewUrl = node.previewUrl ? `${apiBase}${node.previewUrl}?v=${encodeURIComponent(node.activeStackItem?.id ?? node.manifest.id)}` : "";
  const isVideoNode = node.manifest.type === "video";
  const stackCount = node.manifest.type === "text" ? (node as TextNodeView).stack.length : node.manifest.stack.length;
  const activeIndex = node.manifest.type !== "text" && stackCount ? node.manifest.activeStackIndex + 1 : 0;
  const [prompt, setPrompt] = useState(node.manifest.type === "text" ? "" : node.manifest.currentPrompt ?? "");
  const [draftText, setDraftText] = useState(node.manifest.type === "text" ? node.manifest.text : "");
  const [modelQuery, setModelQuery] = useState("");
  const [orderedInputNodes, setOrderedInputNodes] = useState(inputNodes);
  const [parametersOpen, setParametersOpen] = useState(false);
  const [routeSettingsOpen, setRouteSettingsOpen] = useState(false);
  const [promptInsertRequest, setPromptInsertRequest] = useState<{ token: string; sequence: number } | null>(null);
  const promptInsertSequence = useRef(0);
  const textBaseHeight = node.manifest.type === "text" ? Math.min(node.canvas.height, textNodeBaseHeight) : node.canvas.height;
  const hasImageInput = inputNodes.some((input) => input.type === "image") || (node.manifest.type === "image" && node.manifest.stack.length > 0);
  const compatibleModels = modelsCompatibleWithNodeInputs(models, node.manifest.type as ContentKind, hasImageInput);
  const displayModels = mergeModelsForDisplay(compatibleModels);
  const selectedDisplayModel = displayModels.find((entry) =>
    entry.routes.some((route) => route.id === modelSelection.modelId && (modelSelection.executionProvider === "auto" || route.providerId === modelSelection.executionProvider))
  ) ?? displayModels.find((entry) => entry.model.id === modelSelection.modelId);
  const selectedRoutes = selectedDisplayModel?.routes ?? [];
  const selectedModel: ModelOption = selectedRoutes.find((model) => model.providerId === modelSelection.executionProvider) ?? selectedRoutes[0] ?? compatibleModels[0] ?? {
    id: "",
    title: "Select model",
    providerId: "none",
    contentKinds: [node.manifest.type === "text" ? "text" : isVideoNode ? "video" : "image"],
    accepts: ["text"],
    produces: [node.manifest.type === "text" ? "text" : isVideoNode ? "video" : "image"],
    capabilities: [],
    isAvailable: false
  };
  const effectiveSelection: ModelRouteSelection = selectedRoutes.length && selectedModel.id !== modelSelection.modelId
    ? { modelId: selectedModel.id, executionProvider: "auto", fallbackAllowed: true }
    : modelSelection;
  const normalizedModelQuery = modelQuery.toLowerCase();
  const visibleModels = displayModels.filter(({ model, providers, routes }) =>
    model.title.toLowerCase().includes(normalizedModelQuery)
    || model.id.toLowerCase().includes(normalizedModelQuery)
    || providers.some((provider) => provider.toLowerCase().includes(normalizedModelQuery) || providerDisplayName(provider).toLowerCase().includes(normalizedModelQuery))
    || routes.some((route) => route.title.toLowerCase().includes(normalizedModelQuery) || route.id.toLowerCase().includes(normalizedModelQuery))
  );
  const selectedModelLogo = modelLogoForOption(selectedModel);
  const selectedModelKey = `${selectedModel.id}:${effectiveSelection.executionProvider}`;
  const parameterDefinitions = selectedModel.generationParameters ?? [];
  const imageInputs = orderedInputNodes.filter((input) => input.type === "image");
  const inputAspectRatio = node.manifest.type === "text" ? undefined : aspectRatioFromInputs(orderedInputNodes) ?? "16:9";
  const [generationParameters, setGenerationParameters] = useState<ImageGenerationParameters>(() => defaultGenerationParametersForNode(selectedModel, parameterDefinitions, inputAspectRatio));
  const maxImageInputs = modelImageInputLimit(selectedModel);
  const activeInputNodes = orderedInputNodes.filter((input) => !inputChipInactive(input, imageInputs, maxImageInputs));
  useEffect(() => {
    setOrderedInputNodes((current) => {
      const byId = new Map(inputNodes.map((input) => [input.id, input]));
      return [...current.filter((input) => byId.has(input.id)).map((input) => byId.get(input.id)!), ...inputNodes.filter((input) => !current.some((existing) => existing.id === input.id))];
    });
  }, [inputNodes]);
  useEffect(() => {
    setGenerationParameters(defaultGenerationParametersForNode(selectedModel, parameterDefinitions, inputAspectRatio));
    setParametersOpen(false);
  }, [selectedModelKey, inputAspectRatio]);
  useEffect(() => {
    if (node.manifest.type === "text") setDraftText(node.manifest.text);
  }, [node.manifest.id, node.manifest.type === "text" ? node.manifest.text : ""]);

  function insertInputToken(input: InputNodeChip) {
    if (inputChipInactive(input, imageInputs, maxImageInputs)) return;
    const token = `[[${input.type === "text" ? "text" : input.type === "video" ? "video" : "image"}:${input.id}]]`;
    promptInsertSequence.current += 1;
    setPromptInsertRequest({ token, sequence: promptInsertSequence.current });
  }

  function moveInputChip(draggedId: string, beforeId: string) {
    if (draggedId === beforeId) return;
    setOrderedInputNodes((current) => {
      const dragged = current.find((input) => input.id === draggedId);
      if (!dragged) return current;
      const rest = current.filter((input) => input.id !== draggedId);
      const targetIndex = rest.findIndex((input) => input.id === beforeId);
      if (targetIndex < 0) return [...rest, dragged];
      return [...rest.slice(0, targetIndex), dragged, ...rest.slice(targetIndex)];
    });
  }
  if (node.manifest.type === "text") {
    const textNode = node as TextNodeView;
    const textStackIsEmpty = textNode.stack.length === 0;
    const unsavedDraftText = draftText.trim();
    const outputText = textStackIsEmpty ? draftText : textNode.outputText;
    return (
      <article
        className={`textNode${active ? " isActive" : ""}${selected ? " isSelected" : ""}`}
        style={{
          "--image-height": `${textBaseHeight}px`,
          transform: `translate(${node.canvas.x}px, ${node.canvas.y}px)`,
          width: node.canvas.width,
          height: textBaseHeight + nodeTitleHeight
        } as React.CSSProperties}
        onPointerDown={(event) => onPointerDown(event, node)}
        onClick={(event) => onClick(event, node)}
        onContextMenu={(event) => onContextMenu(event, node)}
      >
        <div className="nodeTitle textNodeTitle">
          {active ? (
            <input
              defaultValue={node.manifest.title}
              aria-label="Node title"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onBlur={(event) => onRenameNode(node.manifest.id, event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          ) : <span>{node.manifest.title || "Text"}</span>}
        </div>
        <div className="nodeHandleLine nodeHandleLineInput" />
        <div className="nodeHandleLine nodeHandleLineOutput" />
        <div className="nodeHandle nodeHandleInput" title="Input" data-node-input-id={node.canvas.id} onPointerDown={(event) => onInputPointerDown(event, node)} />
        <div className="nodeHandle nodeHandleOutput" title="Output" data-node-output-id={node.canvas.id} onPointerDown={(event) => onOutputPointerDown(event, node)} />
        <div className={`textNodePreview textColor-${node.manifest.color ?? "mint"}`} onContextMenu={(event) => onContentContextMenu(event, node, "text")}>
          <small className="textOutputLabel">Output text</small>
          <div className="textNodeOutput" data-canvas-wheel-scroll>{outputText || "No text selected"}</div>
          {textStackIsEmpty && unsavedDraftText ? <small className="textStackDraftNotice">Input field, not saved in stack</small> : null}
          {active ? (
            <>
              <button
                className="stackMenu textStackMenu"
                type="button"
                aria-label="Text stack"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleStack(node.manifest.id);
                }}
              >
                {stackCount || 0}
              </button>
              {openStack ? (
                <div className="textStackBoard" data-canvas-wheel-scroll onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                  {textNode.stack.length ? textNode.stack.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={item.id === textNode.manifest.selectedStackItemId ? "isActive" : ""}
                      onPointerDown={(event) => onDragStackImage(event, node.manifest.id, item.id)}
                      onClick={() => onSelectTextStackItem(node.manifest.id, item.id)}
                      onContextMenu={(event) => onStackItemContextMenu(event, node.manifest.id, item.id)}
                    >
                      {item.previewFile ? <img src={`${apiBase}/api/libraries/current/text-nodes/${encodeURIComponent(node.manifest.id)}/stack/${encodeURIComponent(item.id)}/preview`} alt="" /> : null}
                      <strong>{item.title}</strong>
                      <span>{item.text}</span>
                    </button>
                  )) : (
                    <div className="textStackDraftFallback">
                      <strong>Input field</strong>
                      <span>{unsavedDraftText || "Empty stack"}</span>
                      {unsavedDraftText ? <small>Not saved in stack</small> : null}
                    </div>
                  )}
                </div>
              ) : null}
              <div className="textColorSwatches" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                {["mint", "violet", "amber", "rose"].map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`textSwatch textSwatch-${color}${textNode.manifest.color === color ? " isSelected" : ""}`}
                    aria-label={`Set ${color} color`}
                    onClick={() => onSaveTextColor(node.manifest.id, color)}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>
        {active ? (
          <footer className="promptPanel textPromptPanel" onPointerDown={(event) => event.stopPropagation()}>
            <div className="inputChips">
              {orderedInputNodes.length ? orderedInputNodes.map((input) => {
                const inactive = inputChipInactive(input, imageInputs, maxImageInputs);
                return (
                  <button
                    type="button"
                    className={`inputChip${input.type === "text" ? ` textColor-${input.color ?? "mint"}` : ""}${inactive ? " isInactive" : ""}`}
                    style={input.type === "text" ? inputTextChipStyle(input) : undefined}
                    key={input.id}
                    draggable
                    title={inactive ? "Model image input limit exceeded" : `Insert ${input.title} into prompt`}
                    onDragStart={(event) => event.dataTransfer.setData("text/snarkroute-input-node", input.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      moveInputChip(event.dataTransfer.getData("text/snarkroute-input-node"), input.id);
                    }}
                    onClick={() => insertInputToken(input)}
                  >
                    <InputChipThumb input={input} />
                  </button>
                );
              }) : <span className="inputChip isEmpty">No inputs</span>}
            </div>
            <div className="textPromptEditor">
              <PromptComposer
                value={draftText}
                inputNodes={orderedInputNodes}
                maxImageInputs={maxImageInputs}
                insertRequest={promptInsertRequest}
                onInsertRequestHandled={() => setPromptInsertRequest(null)}
                onOpenInputPreview={(input) => input.type === "image" && onOpenPreview(input.id, input.activeStackIndex ?? 0, input.title)}
                onChange={setDraftText}
                onBlur={() => onSaveText(node.manifest.id, draftText)}
              />
              <button
                type="button"
                className="textAddStackButton"
                aria-label="Add text to stack"
                disabled={!draftText.trim()}
                onClick={() => onAddTextToStack(node.manifest.id, draftText)}
              >
                <Save size={16} />
              </button>
            </div>
            <div className="promptMeta">
              <div className="modelPicker">
                <button
                  type="button"
                  className="modelPickerButton"
                  aria-label={`Choose text model: ${selectedModel.title}`}
                  title={selectedModel.title}
                  disabled={!selectedModel.id}
                  onClick={() => onToggleModelSearch(node.manifest.id)}
                >
                  <img src={selectedModelLogo.src} alt="" />
                </button>
                {modelSearchOpen ? (
                  <div className="modelMenu" onPointerDown={(event) => event.stopPropagation()}>
                    <input value={modelQuery} placeholder="Search model" onChange={(event) => setModelQuery(event.currentTarget.value)} />
                    <div className="modelMenuList" data-canvas-wheel-scroll>
                      {visibleModels.map(({ model, providers }) => (
                        <button key={model.id} type="button" onClick={() => onSelectModel(node.manifest.id, { modelId: model.id, executionProvider: "auto", fallbackAllowed: true })}>
                          <img src={modelLogoForOption(model).src} alt="" />
                          <span><strong>{model.title}</strong><small>{model.id}{providers.length > 1 ? ` - ${providers.map(providerDisplayName).join(", ")}` : ""}</small></span>
                        </button>
                      ))}
                      {visibleModels.length === 0 ? (
                        <div className="modelMenuEmpty">
                          <span>Нет подключённых текстовых моделей</span>
                          <button type="button" onClick={onOpenModels}>Открыть панель моделей</button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="routeSettings">
                <button type="button" className="routeSettingsButton" aria-label={`Execution route for ${selectedModel.title}`} aria-expanded={routeSettingsOpen} disabled={!selectedModel.id} onClick={() => setRouteSettingsOpen((current) => !current)}>
                  <Wrench size={13} />
                </button>
                {routeSettingsOpen ? (
                  <div className="routeSettingsMenu" onPointerDown={(event) => event.stopPropagation()}>
                    <strong>{selectedModel.title}</strong>
                    <small className="routeModelId">{selectedModel.id}</small>
                    <label>
                      Run via
                      <select value={effectiveSelection.executionProvider} onChange={(event) => onChangeRouteSettings(node.manifest.id, { ...effectiveSelection, executionProvider: event.currentTarget.value })}>
                        <option value="auto">Auto</option>
                        {selectedRoutes.map((route) => <option key={route.providerId} value={route.providerId}>{executionRouteDisplayName(route.providerId)}</option>)}
                      </select>
                    </label>
                    <label className="fallbackSetting">
                      <input type="checkbox" checked={effectiveSelection.fallbackAllowed} onChange={(event) => onChangeRouteSettings(node.manifest.id, { ...effectiveSelection, fallbackAllowed: event.currentTarget.checked })} />
                      Fallback allowed
                    </label>
                  </div>
                ) : null}
              </div>
              {generationFeedback ? <span className={generationFeedback.error ? "generationStatus isError" : "generationStatus"}>{generationFeedback.message}</span> : null}
              <button
                type="button"
                aria-label="Run"
                disabled={!draftText.trim() || !selectedModel.id || generationFeedback?.busy}
                onClick={() => {
                  setRouteSettingsOpen(false);
                  onRunTextGeneration(node.manifest.id, effectiveSelection, selectedRoutes.map((route) => route.providerId), draftText, activeInputNodes.map((input) => input.id), maxImageInputs, selectedModel.imageReferenceSyntax);
                }}
              >
                {generationFeedback?.busy ? <BusyGears /> : <ArrowUp size={16} />}
              </button>
            </div>
          </footer>
        ) : null}
      </article>
    );
  }
  const mediaNode = node as ImageNodeView | VideoNodeView;
  return (
    <article
      className={`imageNode${isVideoNode ? " videoNode" : ""}${active ? " isActive" : ""}${selected ? " isSelected" : ""}`}
      style={{
        "--image-height": `${node.canvas.height}px`,
        transform: `translate(${node.canvas.x}px, ${node.canvas.y}px)`,
        width: node.canvas.width,
        height: active ? node.canvas.height + nodeTitleHeight + activePromptHeight : node.canvas.height + nodeTitleHeight + passiveFooterHeight
      } as React.CSSProperties}
      onPointerDown={(event) => onPointerDown(event, node)}
      onClick={(event) => onClick(event, node)}
      onContextMenu={(event) => onContextMenu(event, node)}
    >
      {active && (
        <div className="nodeToolbar" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" aria-label={`Download ${isVideoNode ? "video" : "image"}`} onClick={() => void downloadPreview(previewUrl, node.manifest.title)}><Download size={16} /></button>
          {!isVideoNode ? <button type="button" aria-label="Crop image" onClick={() => { if (previewUrl) void onOpenCrop(mediaNode.manifest.id); }}><Crop size={16} /></button> : null}
          <button type="button" aria-label={`Expand ${isVideoNode ? "video" : "image"}`} onClick={() => previewUrl && onOpenPreview(mediaNode.manifest.id, mediaNode.manifest.activeStackIndex, mediaNode.manifest.title)}><Expand size={16} /></button>
        </div>
      )}
      <div className="nodeTitle">
        {generationFeedback?.busy ? (
          <span className="nodeBusyGears" aria-label="Generating">
            <Cog size={12} className="nodeBusyGearLarge" />
            <Cog size={9} className="nodeBusyGearSmall" />
          </span>
        ) : isVideoNode ? <Video size={15} /> : <ImageIcon size={15} />}
        {active ? (
          <input
            defaultValue={node.manifest.title}
            aria-label="Node title"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => onRenameNode(node.manifest.id, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        ) : <span>{node.manifest.title || (isVideoNode ? "Video" : "Image")}</span>}
      </div>
      <div className="nodeHandleLine nodeHandleLineInput" />
      <div className="nodeHandleLine nodeHandleLineOutput" />
      <div className="nodeHandle nodeHandleInput" title="Input" data-node-input-id={node.canvas.id} onPointerDown={(event) => onInputPointerDown(event, node)} />
      <div className="nodeHandle nodeHandleOutput" title="Output" data-node-output-id={node.canvas.id} onPointerDown={(event) => onOutputPointerDown(event, node)} />
      <div className="imagePreview" onContextMenu={(event) => onContentContextMenu(event, node, isVideoNode ? "video" : "image")}>
        {previewUrl ? isVideoNode ? <video src={previewUrl} controls preload="metadata" onPointerDown={(event) => event.stopPropagation()} /> : <img src={previewUrl} alt={node.manifest.title} draggable={false} /> : (
          <div className="emptyNodePreview">
            {isVideoNode ? <Video size={32} /> : <ImageIcon size={32} />}
          </div>
        )}
        {active && (
          <button
            className="uploadStackButton"
            type="button"
            aria-label={`Upload ${isVideoNode ? "video" : "image"} to stack`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onUploadStackImage(node.manifest.id);
            }}
          >
            <ImagePlus size={16} />
          </button>
        )}
        {active && (
          <>
            <button
              className="stackMenu"
              type="button"
              aria-label="Stack"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onToggleStack(node.manifest.id);
              }}
            >
              {stackCount || 0}
            </button>
            {openStack && (
              <div className="stackBoard" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                {mediaNode.manifest.stack.length ? mediaNode.manifest.stack.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    className={index === mediaNode.manifest.activeStackIndex ? "isActive" : ""}
                    onPointerDown={(event) => onDragStackImage(event, node.manifest.id, item.id)}
                    onContextMenu={(event) => onStackItemContextMenu(event, node.manifest.id, item.id)}
                    onClick={() => onSelectStackImage(node.manifest.id, index)}
                  >
                    {isVideoNode ? <video draggable={false} src={stackMediaUrl(mediaNode.manifest.type, mediaNode.manifest.id, item.id)} preload="metadata" /> : <img draggable={false} src={stackMediaUrl(mediaNode.manifest.type, mediaNode.manifest.id, item.id)} alt="" />}
                  </button>
                )) : <span className="stackBoardEmpty">Empty stack</span>}
              </div>
            )}
          </>
        )}
      </div>
      {active && (
        <footer className="promptPanel" onPointerDown={(event) => event.stopPropagation()}>
          <div className="inputChips">
            {orderedInputNodes.length ? orderedInputNodes.map((input) => {
              const inactive = inputChipInactive(input, imageInputs, maxImageInputs);
              return (
              <button
                type="button"
                className={`inputChip${input.type === "text" ? ` textColor-${input.color ?? "mint"}` : ""}${inactive ? " isInactive" : ""}`}
                style={input.type === "text" ? inputTextChipStyle(input) : undefined}
                key={input.id}
                draggable
                title={inactive ? "Model image input limit exceeded" : `Insert ${input.title} into prompt`}
                onDragStart={(event) => event.dataTransfer.setData("text/snarkroute-input-node", input.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  moveInputChip(event.dataTransfer.getData("text/snarkroute-input-node"), input.id);
                }}
                onClick={() => insertInputToken(input)}
              >
                <InputChipThumb input={input} />
              </button>
            ); }) : <span className="inputChip isEmpty">No inputs</span>}
          </div>
          <PromptComposer
            value={prompt}
            inputNodes={orderedInputNodes}
            maxImageInputs={maxImageInputs}
            insertRequest={promptInsertRequest}
            onInsertRequestHandled={() => setPromptInsertRequest(null)}
            onOpenInputPreview={(input) => input.type === "image" && onOpenPreview(input.id, input.activeStackIndex ?? 0, input.title)}
            onChange={setPrompt}
            onBlur={() => onSavePrompt(node.manifest.id, prompt)}
          />
          <div className="promptMeta">
            <div className="modelPicker">
              <button
                type="button"
                className="modelPickerButton"
                aria-label={`Choose ${isVideoNode ? "video" : "image"} model: ${selectedModel.title}`}
                title={selectedModel.title}
                onClick={() => onToggleModelSearch(node.manifest.id)}
              >
                <img src={selectedModelLogo.src} alt="" />
              </button>
              {modelSearchOpen && (
                <div className="modelMenu" onPointerDown={(event) => event.stopPropagation()}>
                  <input
                    value={modelQuery}
                    placeholder="Search model"
                    onChange={(event) => setModelQuery(event.currentTarget.value)}
                  />
                  <div className="modelMenuList" data-canvas-wheel-scroll>
                    {visibleModels.map(({ model, providers }) => (
                      <button key={model.id} type="button" onClick={() => onSelectModel(node.manifest.id, { modelId: model.id, executionProvider: "auto", fallbackAllowed: true })}>
                <img src={modelLogoForOption(model).src} alt="" />
                        <span>
                          <strong>{model.title}</strong>
                          <small>{model.id}{providers.length > 1 ? ` - ${providers.map(providerDisplayName).join(", ")}` : ""}</small>
                        </span>
                      </button>
                    ))}
                    {visibleModels.length === 0 ? (
                      <div className="modelMenuEmpty">
                        <span>Нет подключённых моделей для этого типа артефакта</span>
                        <button type="button" onClick={onOpenModels}>Открыть панель моделей</button>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
            <div className="routeSettings">
              <button
                type="button"
                className="routeSettingsButton"
                aria-label={`Execution route for ${selectedModel.title}`}
                aria-expanded={routeSettingsOpen}
                onClick={() => setRouteSettingsOpen((current) => !current)}
              >
                <Wrench size={13} />
              </button>
              {routeSettingsOpen && (
                <div className="routeSettingsMenu" onPointerDown={(event) => event.stopPropagation()}>
                  <strong>{selectedModel.title}</strong>
                  <small className="routeModelId">{selectedModel.id}</small>
                  <label>
                    Run via
                    <select
                      value={effectiveSelection.executionProvider}
                      onChange={(event) => onChangeRouteSettings(node.manifest.id, { ...effectiveSelection, executionProvider: event.currentTarget.value })}
                    >
                      <option value="auto">Auto</option>
                      {selectedRoutes.map((route) => <option key={route.providerId} value={route.providerId}>{executionRouteDisplayName(route.providerId)}</option>)}
                    </select>
                  </label>
                  <label className="fallbackSetting">
                    <input
                      type="checkbox"
                      checked={effectiveSelection.fallbackAllowed}
                      onChange={(event) => onChangeRouteSettings(node.manifest.id, { ...effectiveSelection, fallbackAllowed: event.currentTarget.checked })}
                    />
                    Fallback allowed
                  </label>
                  <small>{effectiveSelection.executionProvider === "auto" ? "The gateway chooses from available routes." : effectiveSelection.fallbackAllowed ? "Fallback is allowed when supported by the gateway." : "Run strictly through this provider."}</small>
                </div>
              )}
            </div>
            <div className="generationParameters">
              <button
                type="button"
                className="generationParametersButton"
                aria-label="Generation parameters"
                aria-expanded={parametersOpen}
                disabled={parameterDefinitions.length === 0}
                onClick={() => parameterDefinitions.length && setParametersOpen((current) => !current)}
              >
                {generationParameterSummary(parameterDefinitions, generationParameters)}
              </button>
              {parametersOpen && parameterDefinitions.length > 0 && (
                <div className="generationParametersMenu" onPointerDown={(event) => event.stopPropagation()}>
                  <strong>{selectedModel.title}</strong>
                  {parameterDefinitions.map((definition) => (
                    <label key={definition.id}>
                      {definition.label}
                      <GenerationParameterControl
                        definition={definition}
                        value={generationParameters[definition.id] ?? definition.default ?? ""}
                        onChange={(value) => setGenerationParameters((current) => ({ ...current, [definition.id]: value }))}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
            {generationFeedback ? <span className={generationFeedback.error ? "generationStatus isError" : "generationStatus"}>{generationFeedback.message}</span> : null}
            <button
              type="button"
              aria-label="Run"
              disabled={!selectedModel.id || generationFeedback?.busy}
              onClick={() => {
                setRouteSettingsOpen(false);
                setParametersOpen(false);
                onRunGeneration(node.manifest.id, effectiveSelection, selectedRoutes.map((route) => route.providerId), prompt, activeInputNodes.map((input) => input.id), maxImageInputs, selectedModel.imageReferenceSyntax, generationParameters);
              }}
            >
              {generationFeedback?.busy ? <BusyGears /> : <ArrowUp size={16} />}
            </button>
          </div>
        </footer>
      )}
      {!active && (
        <footer className="passiveFooter">
          <strong>{node.manifest.title}</strong>
          <div className="stackBadge">
            <Layers3 size={14} />
            <span>{activeIndex} / {stackCount}</span>
          </div>
        </footer>
      )}
    </article>
  );
}

function PromptComposer({
  value,
  inputNodes,
  maxImageInputs,
  insertRequest,
  onInsertRequestHandled,
  onOpenInputPreview,
  onChange,
  onBlur
}: {
  value: string;
  inputNodes: InputNodeChip[];
  maxImageInputs?: number;
  insertRequest: { token: string; sequence: number } | null;
  onInsertRequestHandled: () => void;
  onOpenInputPreview?: (input: InputNodeChip) => void;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const draggingChipRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || serializePromptContent(editor) === value) return;
    renderPromptContent(editor, value, inputNodes, maxImageInputs);
  }, [inputNodes, maxImageInputs, value]);

  useEffect(() => {
    if (!insertRequest) return;
    const editor = editorRef.current;
    const input = inputForPromptToken(insertRequest.token, inputNodes);
    if (!editor || !input) return;
    insertChipAtRange(editor, input, insertRequest.token, inputNodes, maxImageInputs, savedRangeRef.current);
    onChange(serializePromptContent(editor));
    onInsertRequestHandled();
    editor.focus();
    saveEditorRange(editor, savedRangeRef);
  }, [insertRequest?.sequence]);

  return (
    <div
      className="promptTextArea promptRichEditor"
      ref={editorRef}
      role="textbox"
      aria-label="Prompt"
      contentEditable
      suppressContentEditableWarning
      onInput={(event) => {
        onChange(serializePromptContent(event.currentTarget));
        saveEditorRange(event.currentTarget, savedRangeRef);
      }}
      onBlur={() => {
        saveEditorRange(editorRef.current, savedRangeRef);
        onBlur();
      }}
      onKeyUp={() => saveEditorRange(editorRef.current, savedRangeRef)}
      onMouseUp={() => saveEditorRange(editorRef.current, savedRangeRef)}
      onDragOver={(event) => event.preventDefault()}
      onDragStart={(event) => {
        const chip = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".promptInlineChip") : null;
        const token = chip?.dataset.promptToken;
        if (token) {
          draggingChipRef.current = chip;
          event.dataTransfer.setData("text/snarkroute-prompt-token", token);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const token = event.dataTransfer.getData("text/snarkroute-prompt-token")
          || tokenForInputId(event.dataTransfer.getData("text/snarkroute-input-node"), inputNodes);
        const input = inputForPromptToken(token, inputNodes);
        if (!input) return;
        const range = promptDropRange(event.clientX, event.clientY, editorRef.current);
        draggingChipRef.current?.remove();
        draggingChipRef.current = null;
        insertChipAtRange(event.currentTarget, input, token, inputNodes, maxImageInputs, range);
        onChange(serializePromptContent(event.currentTarget));
        saveEditorRange(event.currentTarget, savedRangeRef);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const chip = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".promptInlineChip") : null;
        const input = chip?.dataset.promptToken ? inputForPromptToken(chip.dataset.promptToken, inputNodes) : undefined;
        if (chip && input?.type === "text") {
          event.preventDefault();
          togglePromptTextChip(chip, input);
          saveEditorRange(editorRef.current, savedRangeRef);
          return;
        }
        if (input?.type === "image") onOpenInputPreview?.(input);
      }}
    />
  );
}

function BusyGears() {
  return (
    <span className="nodeBusyGears buttonBusyGears" aria-label="Generating">
      <Cog size={14} className="nodeBusyGearLarge" />
      <Cog size={10} className="nodeBusyGearSmall" />
    </span>
  );
}

function normalizedModelRouteSelection(value: string | ModelRouteSelection | undefined, fallback: ModelOption | undefined): ModelRouteSelection {
  if (value && typeof value === "object" && typeof value.modelId === "string") {
    return {
      modelId: value.modelId,
      executionProvider: value.executionProvider || "auto",
      fallbackAllowed: value.fallbackAllowed !== false
    };
  }
  if (typeof value === "string" && value) {
    const separator = value.indexOf(":");
    if (separator > 0) {
      return {
        modelId: value.slice(separator + 1),
        executionProvider: value.slice(0, separator),
        fallbackAllowed: true
      };
    }
    return { modelId: value, executionProvider: "auto", fallbackAllowed: true };
  }
  return { modelId: fallback?.id ?? "", executionProvider: "auto", fallbackAllowed: true };
}

function executionRouteDisplayName(providerId: string): string {
  const directProviders = new Set(["gemini", "openai", "anthropic", "google", "xai"]);
  const name = providerDisplayName(providerId);
  return directProviders.has(providerId.toLowerCase()) ? `${name} direct` : name;
}

function defaultGenerationParametersForNode(
  model: ModelOption,
  definitions: ModelParameterDefinition[],
  inputAspectRatio: string | undefined
): ImageGenerationParameters {
  const parameters = modelGenerationParameters(model);
  if (!inputAspectRatio) return parameters;
  for (const definition of definitions) {
    if (!isAspectRatioParameter(definition.id)) continue;
    parameters[definition.id] = supportedAspectRatio(inputAspectRatio, definition);
  }
  return parameters;
}

function isAspectRatioParameter(id: string): boolean {
  return id === "aspectRatio" || id === "aspect_ratio" || id.toLowerCase() === "aspectratio";
}

function supportedAspectRatio(aspectRatio: string, definition: ModelParameterDefinition): string {
  const options = (definition.options ?? []).map((option) => option.value);
  if (options.length === 0 || options.includes(aspectRatio)) return aspectRatio;
  const target = aspectRatioValue(aspectRatio);
  const best = options
    .map((option) => ({ option, distance: Math.abs(aspectRatioValue(option) - target) }))
    .sort((a, b) => a.distance - b.distance)[0];
  return best?.option ?? aspectRatio;
}

function aspectRatioFromInputs(inputs: InputNodeChip[]): string | undefined {
  const input = inputs.find((candidate) =>
    (candidate.type === "image" || candidate.type === "video")
    && positiveFinite(candidate.width)
    && positiveFinite(candidate.height)
  );
  if (!input || !input.width || !input.height) return undefined;
  const width = Math.round(input.width);
  const height = Math.round(input.height);
  const divisor = greatestCommonDivisor(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function aspectRatioValue(value: string): number {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return 16 / 9;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return positiveFinite(width) && positiveFinite(height) ? width / height : 16 / 9;
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function modelLogoForOption(model: Pick<ModelOption, "providerId" | "id" | "title" | "iconPath">) {
  return modelLogoForCatalogOption(model);
}

function GenerationParameterControl({
  definition,
  value,
  onChange
}: {
  definition: ModelParameterDefinition;
  value: GenerationParameterValue;
  onChange: (value: GenerationParameterValue) => void;
}) {
  if (definition.type === "select") {
    return (
      <select value={String(value)} onChange={(event) => onChange(event.currentTarget.value)}>
        {(definition.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label ?? option.value}</option>)}
      </select>
    );
  }
  if (definition.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={value === true || value === "true"}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    );
  }
  return (
    <input
      type={definition.type}
      value={String(value)}
      min={definition.min}
      max={definition.max}
      step={definition.step}
      onChange={(event) => onChange(definition.type === "number" ? Number(event.currentTarget.value) : event.currentTarget.value)}
    />
  );
}

function renderPromptContent(editor: HTMLElement, value: string, inputNodes: InputNodeChip[], maxImageInputs?: number) {
  const inputById = new Map(inputNodes.map((input) => [input.id, input]));
  const imageInputs = inputNodes.filter((input) => input.type === "image");
  const fragment = document.createDocumentFragment();
  const tokenPattern = /\[\[(text|image|video):([^\]]+)\]\]/g;
  let lastIndex = 0;
  for (const match of value.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) fragment.append(document.createTextNode(value.slice(lastIndex, index)));
    const input = inputById.get(match[2]);
    if (!input || input.type !== match[1]) {
      fragment.append(document.createTextNode(match[0]));
    } else {
      const imageIndex = imageInputs.findIndex((candidate) => candidate.id === input.id);
      const inactive = input.type === "image" && maxImageInputs !== undefined && imageIndex >= maxImageInputs;
      fragment.append(promptInlineChip(match[0], input, inactive));
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) fragment.append(document.createTextNode(value.slice(lastIndex)));
  editor.replaceChildren(fragment);
}

function promptInlineChip(token: string, input: InputNodeChip, inactive: boolean): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `promptInlineChip${input.type === "text" ? ` textColor-${input.color ?? "mint"}` : ""}${inactive ? " isInactive" : ""}`;
  chip.contentEditable = "false";
  chip.draggable = true;
  chip.dataset.promptToken = token;
  chip.title = input.title;
  if (input.type === "text") {
    const textColor = inputTextChipColor(input);
    chip.style.setProperty("--text-node-color", textColor);
    chip.style.borderColor = textColor;
    const thumbnail = document.createElement("span");
    thumbnail.className = `textChipThumb${input.previewUrl ? " hasPreview" : ""}`;
    thumbnail.style.borderColor = textColor;
    thumbnail.style.color = textColor;
    if (input.previewUrl) thumbnail.style.backgroundImage = `linear-gradient(rgba(246, 247, 242, 0.24), rgba(246, 247, 242, 0.24)), url(${apiBase}${input.previewUrl})`;
    thumbnail.textContent = "T";
    chip.append(thumbnail);
  } else if (input.previewUrl && input.type !== "video") {
    const image = document.createElement("img");
    image.src = `${apiBase}${input.previewUrl}`;
    image.alt = "";
    chip.append(image);
  } else {
    const thumbnail = document.createElement("span");
    thumbnail.className = input.type === "text" ? `textChipThumb textColor-${input.color ?? "mint"}` : "promptInlineImageFallback";
    thumbnail.textContent = input.type === "text" ? "T" : input.type === "video" ? "V" : "I";
    chip.append(thumbnail);
  }
  return chip;
}

function togglePromptTextChip(chip: HTMLElement, input: InputNodeChip) {
  const expanded = chip.classList.toggle("isExpanded");
  chip.replaceChildren();
  if (!expanded) {
    const thumbnail = document.createElement("span");
    thumbnail.className = `textChipThumb${input.previewUrl ? " hasPreview" : ""}`;
    const textColor = inputTextChipColor(input);
    thumbnail.style.borderColor = textColor;
    thumbnail.style.color = textColor;
    if (input.previewUrl) thumbnail.style.backgroundImage = `linear-gradient(rgba(246, 247, 242, 0.24), rgba(246, 247, 242, 0.24)), url(${apiBase}${input.previewUrl})`;
    thumbnail.textContent = "T";
    chip.append(thumbnail);
    return;
  }
  const text = document.createElement("span");
  text.className = "promptInlineTextChip";
  text.textContent = input.text?.trim() || input.title;
  chip.append(text);
}

function InputChipThumb({ input }: { input: InputNodeChip }) {
  if (input.type === "text") {
    return <span className={`textChipThumb${input.previewUrl ? " hasPreview" : ""}`} style={textChipThumbStyle(input)}>T</span>;
  }
  if (input.previewUrl) return input.type === "video" ? <Video size={15} /> : <img src={`${apiBase}${input.previewUrl}`} alt="" />;
  return input.type === "image" ? <ImageIcon size={15} /> : input.type === "video" ? <Video size={15} /> : <span className="promptInlineImageFallback">I</span>;
}

function inputChipInactive(input: InputNodeChip, imageInputs: InputNodeChip[], maxImageInputs: number | undefined): boolean {
  if (input.type !== "image" || maxImageInputs === undefined) return false;
  const imageIndex = imageInputs.findIndex((candidate) => candidate.id === input.id);
  return imageIndex >= maxImageInputs;
}

function inputTextChipColor(input: InputNodeChip): string {
  return textNodeWireColor(input.color as TextNodeManifest["color"]);
}

function inputTextChipStyle(input: InputNodeChip): React.CSSProperties {
  const color = inputTextChipColor(input);
  return { "--text-node-color": color, borderColor: color, color } as React.CSSProperties;
}

function textChipThumbStyle(input: InputNodeChip): React.CSSProperties {
  const color = inputTextChipColor(input);
  const previewStyle = input.previewUrl
    ? { backgroundImage: `linear-gradient(rgba(246, 247, 242, 0.24), rgba(246, 247, 242, 0.24)), url(${apiBase}${input.previewUrl})` }
    : {};
  return { ...previewStyle, borderColor: color, color };
}

function serializePromptContent(editor: HTMLElement): string {
  return ensureTextTokenSpacing([...editor.childNodes].map((node) => serializePromptNode(node)).join(""));
}

function serializePromptNode(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  if (node.dataset.promptToken) return node.dataset.promptToken;
  if (node.tagName === "BR") return "\n";
  const content = [...node.childNodes].map((child) => serializePromptNode(child)).join("");
  return node.tagName === "DIV" ? `${content}\n` : content;
}

function inputForPromptToken(token: string, inputs: InputNodeChip[]): InputNodeChip | undefined {
  const match = /^\[\[(text|image|video):([^\]]+)\]\]$/.exec(token);
  return match ? inputs.find((input) => input.type === match[1] && input.id === match[2]) : undefined;
}

function tokenForInputId(inputId: string, inputs: InputNodeChip[]): string {
  const input = inputs.find((candidate) => candidate.id === inputId);
  return input ? `[[${input.type === "text" ? "text" : input.type === "video" ? "video" : "image"}:${input.id}]]` : "";
}

function ensureTextTokenSpacing(value: string): string {
  return value.replace(/[ \t]*\[\[text:([^\]]+)\]\][ \t]*/g, " [[text:$1]] ");
}

function insertChipAtRange(
  editor: HTMLElement,
  input: InputNodeChip,
  token: string,
  inputs: InputNodeChip[],
  maxImageInputs: number | undefined,
  requestedRange: Range | null
) {
  const imageInputs = inputs.filter((candidate) => candidate.type === "image");
  const imageIndex = imageInputs.findIndex((candidate) => candidate.id === input.id);
  const inactive = input.type === "image" && maxImageInputs !== undefined && imageIndex >= maxImageInputs;
  const range = requestedRange && editor.contains(requestedRange.commonAncestorContainer) ? requestedRange : document.createRange();
  if (!requestedRange || !editor.contains(requestedRange.commonAncestorContainer)) {
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.deleteContents();
  const chip = promptInlineChip(token, input, inactive);
  if (input.type === "text") {
    const fragment = document.createDocumentFragment();
    const trailingSpace = document.createTextNode(" ");
    fragment.append(document.createTextNode(" "), chip, trailingSpace);
    range.insertNode(fragment);
    range.setStartAfter(trailingSpace);
  } else {
    range.insertNode(chip);
    range.setStartAfter(chip);
  }
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function saveEditorRange(editor: HTMLElement | null, rangeRef: React.MutableRefObject<Range | null>) {
  if (!editor) return;
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (range && editor.contains(range.commonAncestorContainer)) rangeRef.current = range.cloneRange();
}

function promptDropRange(clientX: number, clientY: number, editor: HTMLElement | null): Range | null {
  if (!editor) return null;
  const rangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(clientX, clientY);
  if (rangeFromPoint && editor.contains(rangeFromPoint.commonAncestorContainer)) return rangeFromPoint;
  const caretPosition = (document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint?.(clientX, clientY);
  if (!caretPosition || !editor.contains(caretPosition.offsetNode)) return null;
  const range = document.createRange();
  range.setStart(caretPosition.offsetNode, caretPosition.offset);
  range.collapse(true);
  return range;
}

function StackPreview({
  preview,
  node,
  onChangeIndex,
  onMakeMain
}: {
  preview: { nodeId: string; title: string; index: number };
  node: ImageNodeView | VideoNodeView | undefined;
  onChangeIndex: (index: number) => void;
  onMakeMain: (nodeId: string, index: number) => void;
}) {
  const stack = node?.manifest.stack ?? [];
  const safeIndex = stack.length ? Math.min(Math.max(preview.index, 0), stack.length - 1) : 0;
  const item = stack[safeIndex];
  const mediaUrl = item && node ? stackMediaUrl(node.manifest.type, preview.nodeId, item.id) : "";
  const isVideo = node?.manifest.type === "video";
  const canGoPrevious = safeIndex > 0;
  const canGoNext = safeIndex < stack.length - 1;
  const isMain = node?.manifest.activeStackIndex === safeIndex;

  return (
    <>
      <div className="previewImageWrap">
        {mediaUrl ? isVideo ? <video src={mediaUrl} controls preload="metadata" /> : <img src={mediaUrl} alt={preview.title} /> : <div className="previewEmpty">No media</div>}
        {canGoPrevious && (
          <button className="previewHoverZone previewHoverLeft" type="button" onClick={() => onChangeIndex(safeIndex - 1)}>
            <span><ChevronLeft size={22} strokeWidth={2.4} /></span>
          </button>
        )}
        {canGoNext && (
          <button className="previewHoverZone previewHoverRight" type="button" onClick={() => onChangeIndex(safeIndex + 1)}>
            <span><ChevronRight size={22} strokeWidth={2.4} /></span>
          </button>
        )}
      </div>
      <div className="previewControls">
        <span>{stack.length ? `${safeIndex + 1} / ${stack.length}` : "0 / 0"}</span>
        <button type="button" disabled={!item || isMain} onClick={() => onMakeMain(preview.nodeId, safeIndex)}>Make main</button>
      </div>
    </>
  );
}

function inputChipsForNode(nodeId: string, edges: CanvasEdge[], nodeById: Map<string, NodeView>): InputNodeChip[] {
  return edges
    .filter((edge) => edge.toNodeId === nodeId)
    .map((edge) => nodeById.get(edge.fromNodeId))
    .filter((node): node is NodeView => Boolean(node))
    .map((node) => {
      const textNode = node.manifest.type === "text" ? node as TextNodeView : null;
      const mediaNode = node.manifest.type === "image" || node.manifest.type === "video" ? node as ImageNodeView | VideoNodeView : null;
      return {
        id: node.canvas.id,
        title: node.manifest.title,
        type: node.manifest.type,
        previewUrl: node.previewUrl,
        text: textNode ? textNode.outputText || textNode.manifest.text : undefined,
        width: mediaNode?.activeStackItem?.width,
        height: mediaNode?.activeStackItem?.height,
        color: textNode ? textNode.manifest.color : undefined,
        activeStackIndex: mediaNode?.manifest.activeStackIndex
      };
    });
}

function nodeTypeWireColor(node: NodeView | undefined): string {
  if (!node) return "#8f9aaa";
  if (node.manifest.type === "text") return textNodeWireColor(node.manifest.color);
  if (node.manifest.type === "image") return "#9fc4ff";
  if (node.manifest.type === "video") return "#f3bf45";
  if (node.manifest.type === "library") return "#c7d2fe";
  return "#8f9aaa";
}

function textNodeWireColor(color: TextNodeManifest["color"]): string {
  if (color === "violet") return "#ff6bd6";
  if (color === "amber") return "#d8ff4f";
  if (color === "rose") return "#ff8a5b";
  return "#2dd4bf";
}

function stackMediaUrl(type: "image" | "video", nodeId: string, stackItemId: string): string {
  return `${apiBase}/api/libraries/current/${type}-nodes/${encodeURIComponent(nodeId)}/stack/${encodeURIComponent(stackItemId)}?v=${encodeURIComponent(stackItemId)}`;
}

function textNodeDisplayText(node: TextNodeView): string {
  if (node.stack.length === 0) return node.manifest.text;
  return node.outputText || node.manifest.text;
}

function contentPreviewUrl(node: NodeView | undefined): string {
  if (!node || node.manifest.type === "text" || node.manifest.type === "library") return "";
  return node.previewUrl ? `${apiBase}${node.previewUrl}?v=${encodeURIComponent(node.activeStackItem?.id ?? node.manifest.id)}` : "";
}

async function copyImageToClipboard(src: string) {
  if (!navigator.clipboard || typeof ClipboardItem === "undefined") throw new Error("Image clipboard is not available in this browser.");
  const response = await fetch(src);
  const sourceBlob = await response.blob();
  const blob = sourceBlob.type === "image/png" ? sourceBlob : await imageBlobAsPng(sourceBlob);
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
}

async function imageBlobAsPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare image for clipboard.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return await new Promise((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not convert image to PNG.")), "image/png");
  });
}

function representationLabel(type: NodeRepresentationType): string {
  if (type === "image") return "Image";
  if (type === "video") return "Video";
  return "Text";
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target.isContentEditable
    || Boolean(target.closest('[contenteditable="true"]'));
}

function busyFavicon(angle: number): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#111813"/><g transform="rotate(${angle} 13 13)" fill="#8fd7b5" stroke="#d8ffe9" stroke-width="1"><path d="M13 4.5 15 6l2.4-.5 1.4 2.1-.9 2.3 1.6 2v2.2l-2.3.8-.7 2.4-2.3.7-1.7-1.8-2.4.5-1.4-2.1.9-2.3-1.6-2V10l2.3-.8.7-2.4Z"/><circle cx="13" cy="12" r="3.1" fill="#111813"/></g><g transform="rotate(${-angle} 22 22)" fill="#f3bf45" stroke="#ffe785" stroke-width=".85"><path d="M22 15.3 23.5 17l2.1-.1.7 2-1.5 1.5.4 2.1-1.9.9-1.6-1.4-2.1.5-.9-1.9 1.3-1.7-.5-2.1 1.9-.9Z"/><circle cx="22" cy="19.3" r="2" fill="#111813"/></g></svg>`)}`;
}

async function downloadPreview(previewUrl: string, title: string) {
  if (!previewUrl) return;
  const response = await fetch(previewUrl);
  const blob = await response.blob();
  const video = blob.type.startsWith("video/");
  const extension = blob.type === "video/webm" ? ".webm" : blob.type === "video/quicktime" ? ".mov" : video ? ".mp4" : ".png";
  const filename = `${title || (video ? "video" : "image")}${extension}`;
  const picker = window.showSaveFilePicker;
  if (picker) {
    const handle = await picker({
      suggestedName: filename,
      types: [{ description: video ? "Video" : "Image", accept: { [blob.type || "image/png"]: video ? [extension] : [".png", ".jpg", ".jpeg", ".webp"] } }]
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(link.href);
  link.remove();
}

function downloadBlob(blob: Blob, filename: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(link.href);
  link.remove();
}

function safeDownloadName(value: string): string {
  return (value || "project").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, " ").trim() || "project";
}

function useStoredSetting<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key);
    if (stored === "hex" && allowed.includes("grid" as T)) return "grid" as T;
    return stored && allowed.includes(stored as T) ? stored as T : fallback;
  });

  function update(next: T) {
    localStorage.setItem(key, next);
    setValue(next);
  }

  return [value, update];
}

function useStoredJsonSetting<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key);
    if (!stored) return fallback;
    try {
      return JSON.parse(stored) as T;
    } catch {
      return fallback;
    }
  });

  function update(next: T) {
    localStorage.setItem(key, JSON.stringify(next));
    setValue(next);
  }

  return [value, update];
}

function mapLibraryNode(library: LibrarySnapshot, nodeId: string, x: number, y: number): LibrarySnapshot {
  return {
    ...library,
    canvas: library.canvas ? {
      ...library.canvas,
      nodes: library.canvas.nodes.map((node) => node.id === nodeId ? { ...node, x, y } : node)
    } : library.canvas,
    nodes: library.nodes.map((node) => node.canvas.id === nodeId ? { ...node, canvas: { ...node.canvas, x, y } } : node)
  };
}

function mapLibraryNodes(library: LibrarySnapshot, positions: { id: string; x: number; y: number }[]): LibrarySnapshot {
  const byId = new Map(positions.map((position) => [position.id, position]));
  return {
    ...library,
    canvas: library.canvas ? {
      ...library.canvas,
      nodes: library.canvas.nodes.map((node) => {
        const position = byId.get(node.id);
        return position ? { ...node, x: position.x, y: position.y } : node;
      })
    } : library.canvas,
    nodes: library.nodes.map((node) => {
      const position = byId.get(node.canvas.id);
      return position ? { ...node, canvas: { ...node.canvas, x: position.x, y: position.y } } : node;
    })
  };
}

function canvasStyle(background: BackgroundName, viewport: CanvasViewport): React.CSSProperties {
  const scale = viewport.scale ?? 1;
  const style: React.CSSProperties = {
    backgroundPosition: `${viewport.x}px ${viewport.y}px`
  };
  if (background === "dots") style.backgroundSize = `${22 * scale}px ${22 * scale}px`;
  if (background === "grid") style.backgroundSize = `${28 * scale}px ${28 * scale}px`;
  if (background === "gears") style.backgroundSize = `${922 * scale}px ${614 * scale}px`;
  return style;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nodeInputPoint(node: CanvasNode) {
  return { x: node.x, y: node.y + nodeTitleHeight + node.height / 2 };
}

function nodeOutputPoint(node: CanvasNode) {
  return { x: node.x + node.width, y: node.y + nodeTitleHeight + node.height / 2 };
}

function edgeMidpoint(edge: CanvasEdge, nodeById: Map<string, CanvasNode>): { x: number; y: number } | null {
  const from = nodeById.get(edge.fromNodeId);
  const to = nodeById.get(edge.toNodeId);
  if (!from || !to) return null;
  const start = nodeOutputPoint(from);
  const end = nodeInputPoint(to);
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

function edgePath(start: { x: number; y: number }, end: { x: number; y: number }) {
  const distance = Math.max(80, Math.abs(end.x - start.x) * 0.45);
  return `M ${start.x} ${start.y} C ${start.x + distance} ${start.y}, ${end.x - distance} ${end.y}, ${end.x} ${end.y}`;
}

function normalizedRect(x1: number, y1: number, x2: number, y2: number) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  };
}

function rectIntersects(rect: { x: number; y: number; width: number; height: number }, node: CanvasNode) {
  return node.x < rect.x + rect.width && node.x + node.width > rect.x && node.y < rect.y + rect.height && node.y + node.height > rect.y;
}

function selectionRectStyle(x1: number, y1: number, x2: number, y2: number): React.CSSProperties {
  const rect = normalizedRect(x1, y1, x2, y2);
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetchApi(path);
  if (!response.ok) throw new Error((await response.json()).error ?? response.statusText);
  return response.json() as Promise<T>;
}

async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const response = await fetchApi(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error((await response.json()).error ?? response.statusText);
  return response.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error((await response.json()).error ?? response.statusText);
  return response.json() as Promise<T>;
}

async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetchApi(path, { method: "DELETE" });
  if (!response.ok) throw new Error((await response.json()).error ?? response.statusText);
  return response.json() as Promise<T>;
}

const apiUnavailableMessage = `Local API is not reachable at ${apiBase}. Start SnarkRoute with start-snarkroute.bat or run corepack pnpm start:snarkroute.`;

async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${apiBase}${path}`, init);
  } catch (error) {
    if (error instanceof TypeError) throw new Error(apiUnavailableMessage);
    throw error;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read dropped image."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name);
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(file.name);
}

function isTextFile(file: File): boolean {
  return file.type.startsWith("text/") || /\.(md|txt)$/i.test(file.name);
}

function chooseLocalFolderAction(scan: LocalLibraryScanResult): "open" | "image" | "text" | "video" | null {
  const actions: Array<{ key: "open" | "image" | "text" | "video"; label: string }> = [
    { key: "open", label: "Open as Library" }
  ];
  if (scan.assets.some((asset) => asset.kind === "image" && /\.(png|jpe?g|webp)$/i.test(asset.relativePath))) actions.push({ key: "image", label: "Create Image Stack from folder" });
  if (scan.assets.some((asset) => asset.kind === "text" || Boolean(asset.embeddedPrompt))) actions.push({ key: "text", label: "Create Text Stack from folder" });
  if (scan.assets.some((asset) => asset.kind === "video")) actions.push({ key: "video", label: "Create Video Stack from folder" });

  const message = [
    `${scan.title} contains ${scan.assets.length} artifact(s). Choose what to create:`,
    ...actions.map((action, index) => `${index + 1}. ${action.label}`),
    `${actions.length + 1}. Cancel`
  ].join("\n");
  const choice = window.prompt(message, actions.length > 1 ? "2" : "1")?.trim();
  const index = Number(choice) - 1;
  return Number.isInteger(index) && index >= 0 && index < actions.length ? actions[index].key : null;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
