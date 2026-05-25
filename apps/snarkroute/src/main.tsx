import "./styles.css";
import { ArrowUp, ChevronLeft, ChevronRight, Cog, Download, Expand, Folder, ImageIcon, ImagePlus, Layers3, Moon, PanelRight, Sun, Trash2, Wallpaper } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { modelLogoFor } from "./modelLogos";

type ThemeName = "day" | "night";
type BackgroundName = "plain" | "dots" | "grid" | "gears";

interface LibrarySnapshot {
  manifest: LibraryManifest;
  path: string;
  nestedLibraries: NestedLibrary[];
  canvas: CanvasDocument | null;
  nodes: NodeView[];
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
  stack: ImageStackItem[];
  activeStackIndex: number;
}

interface TextNodeManifest {
  id: string;
  type: "text";
  title: string;
  text: string;
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

type NodeView = ImageNodeView | TextNodeView;

interface TextNodeView {
  canvas: CanvasNode;
  manifest: TextNodeManifest;
  activeStackItem: null;
  previewUrl: null;
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
  previewUrl: string | null;
  color?: string;
}

interface StackItemMenu {
  x: number;
  y: number;
  nodeId: string;
  stackItemId: string;
}

interface SelectionMenu {
  x: number;
  y: number;
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

interface ModelOption {
  id: string;
  title: string;
  nodeTypes: string[];
  providerId?: string;
  source?: string;
  acceptsImageInput?: boolean;
  maxImageInputs?: number;
  imageReferenceSyntax?: string;
  generationParameters?: ModelParameterDefinition[];
  defaultParameters?: ImageGenerationParameters;
}

type GenerationParameterValue = string | number | boolean;
type ImageGenerationParameters = Record<string, GenerationParameterValue>;

interface ModelParameterDefinition {
  id: string;
  label: string;
  type: "select" | "number" | "text";
  default?: GenerationParameterValue;
  options?: Array<{ value: string; label?: string }>;
  min?: number;
  max?: number;
  step?: number;
}

interface GenerationFeedback {
  busy: boolean;
  message: string;
  error?: boolean;
}

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
const fallbackModels: ModelOption[] = [
  {
    id: "image.nano-banana",
    title: "Nano Banana",
    nodeTypes: ["image"],
    providerId: "gemini",
    source: "fallback",
    acceptsImageInput: true,
    generationParameters: fallbackGeminiParameters()
  }
];

function App() {
  const [theme, setTheme] = useStoredSetting<ThemeName>(themeStorageKey, "night", ["day", "night"]);
  const [background, setBackground] = useStoredSetting<BackgroundName>(backgroundStorageKey, "gears", backgroundOptions.map((option) => option.value));
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("Opening local library...");
  const [isDragging, setIsDragging] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [viewport, setViewport] = useStoredJsonSetting<CanvasViewport>("snarkroute.canvasViewport", { x: 0, y: 0, scale: 1 });
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [nodeCreateMenu, setNodeCreateMenu] = useState<NodeCreateMenu | null>(null);
  const [previewImage, setPreviewImage] = useState<{ nodeId: string; title: string; index: number } | null>(null);
  const [openStackNodeId, setOpenStackNodeId] = useState<string | null>(null);
  const [stackItemMenu, setStackItemMenu] = useState<StackItemMenu | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null);
  const [models, setModels] = useState<ModelOption[]>(fallbackModels);
  const [modelSearchNodeId, setModelSearchNodeId] = useState<string | null>(null);
  const [modelSelections, setModelSelections] = useStoredJsonSetting<Record<string, string>>("snarkroute.nodeModels", {});
  const [generationFeedback, setGenerationFeedback] = useState<Record<string, GenerationFeedback>>({});
  const generationRunning = Object.values(generationFeedback).some((feedback) => feedback.busy);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const interactionMovedRef = useRef(false);
  const undoStackRef = useRef<CanvasDocument[]>([]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void refreshLibrary();
  }, []);

  useEffect(() => {
    void refreshModels();
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
  const viewportScale = viewport.scale ?? 1;

  useEffect(() => {
    if (!dragState) return;

    function handlePointerMove(event: PointerEvent) {
      if (event.pointerId !== dragState.pointerId) return;
      if (dragState.kind === "stackItem") {
        const moved = Math.hypot(event.clientX - dragState.startClientX, event.clientY - dragState.startClientY) > 6;
        if (moved) interactionMovedRef.current = true;
        const point = screenToWorld(event.clientX, event.clientY);
        setDragState({ ...dragState, currentX: point.x, currentY: point.y });
        return;
      }
      if (dragState.kind === "selection") {
        interactionMovedRef.current = true;
        const point = screenToWorld(event.clientX, event.clientY);
        setDragState({
          ...dragState,
          currentClientX: event.clientX,
          currentClientY: event.clientY,
          currentX: point.x,
          currentY: point.y
        });
        return;
      }
      if (dragState.kind === "connection") {
        interactionMovedRef.current = true;
        const point = screenToWorld(event.clientX, event.clientY);
        setDragState({ ...dragState, currentX: point.x, currentY: point.y });
        return;
      }
      if (dragState.kind === "canvas") {
        interactionMovedRef.current = true;
        setViewport({
          x: dragState.startPanX + event.clientX - dragState.startClientX,
          y: dragState.startPanY + event.clientY - dragState.startClientY,
          scale: dragState.startScale
        });
        return;
      }

      interactionMovedRef.current = true;
      const dx = (event.clientX - dragState.startClientX) / viewportScale;
      const dy = (event.clientY - dragState.startClientY) / viewportScale;
      if (dragState.groupStartPositions?.length) {
        updateNodePositions(dragState.groupStartPositions.map((node) => ({
          id: node.id,
          x: Math.round(node.x + dx),
          y: Math.round(node.y + dy)
        })));
      } else {
        updateNodePosition(
          dragState.nodeId,
          Math.round(dragState.startX + dx),
          Math.round(dragState.startY + dy)
        );
      }
    }

    function handlePointerUp(event: PointerEvent) {
      if (event.pointerId !== dragState.pointerId) return;
      if (dragState.kind === "node") {
        const dx = (event.clientX - dragState.startClientX) / viewportScale;
        const dy = (event.clientY - dragState.startClientY) / viewportScale;
        if (dragState.groupStartPositions?.length) {
          void persistNodePositions(dragState.groupStartPositions.map((node) => ({
            id: node.id,
            x: Math.round(node.x + dx),
            y: Math.round(node.y + dy)
          })));
        } else {
          void persistNodePosition(
            dragState.nodeId,
            Math.round(dragState.startX + dx),
            Math.round(dragState.startY + dy)
          );
        }
      }
      if (dragState.kind === "connection") {
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const input = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-node-input-id]") : null;
        const output = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-node-output-id]") : null;
        const toNodeId = input?.dataset.nodeInputId;
        const fromNodeId = output?.dataset.nodeOutputId;
        if (dragState.direction === "fromOutput" && toNodeId && toNodeId !== dragState.fromNodeId) {
          void addCanvasEdge(dragState.fromNodeId, toNodeId);
        } else if (dragState.direction === "fromInput" && fromNodeId && fromNodeId !== dragState.toNodeId) {
          void addCanvasEdge(fromNodeId, dragState.toNodeId ?? dragState.fromNodeId);
        } else {
          const point = screenToWorld(event.clientX, event.clientY);
          if (dragState.direction === "fromOutput") {
            setNodeCreateMenu({
              x: event.clientX,
              y: event.clientY,
              worldX: point.x,
              worldY: point.y,
              fromNodeId: dragState.fromNodeId
            });
          }
        }
      }
      if (dragState.kind === "stackItem") {
        const point = screenToWorld(event.clientX, event.clientY);
        if (interactionMovedRef.current) {
          void duplicateStackItemNode(dragState.nodeId, dragState.stackItemId, point);
        }
      }
      if (dragState.kind === "selection") {
        const bounds = normalizedRect(dragState.startX, dragState.startY, dragState.currentX, dragState.currentY);
        const selected = nodes.filter((node) => rectIntersects(bounds, node.canvas)).map((node) => node.canvas.id);
        setSelectedNodeIds(selected);
        setSelectedNodeId(selected[selected.length - 1] ?? null);
      }
      setDragState(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
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
      if (target.closest(".stackItemMenu, .nodeCreateMenu, .selectionMenu, .stackBoard, .modelMenu")) return;
      setStackItemMenu(null);
      setSelectionMenu(null);
    }

    window.addEventListener("pointerdown", closeFloatingMenus);
    return () => window.removeEventListener("pointerdown", closeFloatingMenus);
  }, []);

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
      const snapshot = await apiGet<LibrarySnapshot>("/api/libraries/current");
      setLibrary(snapshot);
      setStatus(snapshot.canvas ? "Canvas ready" : "Library has no canvas");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open local library.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshModels() {
    const sources = [
      { endpoint: "/api/providers/openrouter/models", providerId: "openrouter" },
      { endpoint: "/api/providers/polza/models?type=image", providerId: "polza" }
    ];
    const loaded: ModelOption[] = [];
    for (const source of sources) {
      try {
        const response = await apiGet<unknown>(source.endpoint);
        loaded.push(...normalizeModelOptions(response, source.providerId));
      } catch {
        // Keep the canvas usable when a provider is not configured or its cache is absent.
      }
    }
    const availableModels = mergeModelOptions(loaded);
    setModels(availableModels.length ? availableModels : fallbackModels);
  }

  async function openNestedLibrary(path: string) {
    try {
      const snapshot = await apiPost<LibrarySnapshot>("/api/libraries/open", { path });
      setLibrary(snapshot);
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
    const file = [...event.dataTransfer.files].find((item) => /\.(png|jpe?g|webp)$/i.test(item.name));
    const canvas = canvasRef.current;
    if (!file || !canvas) {
      setStatus("Drop a PNG, JPG, JPEG, or WEBP image.");
      return;
    }

    const bounds = canvas.getBoundingClientRect();
    const dropX = (event.clientX - bounds.left + canvas.scrollLeft - viewport.x) / viewportScale;
    const dropY = (event.clientY - bounds.top + canvas.scrollTop - viewport.y) / viewportScale;
    await importImageFileAt(file, { x: dropX, y: dropY });
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
      setLibrary(snapshot);
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
    const selection = selectedNodeIds.includes(node.canvas.id) ? selectedNodeIds : [node.canvas.id];
    setSelectedNodeId(node.canvas.id);
    setSelectedNodeIds(selection);
    setSelectedEdgeId(null);
    setSelectionMenu({ x: event.clientX, y: event.clientY });
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

  async function createConnectedNode(type: "image" | "text") {
    if (!nodeCreateMenu) return;
    try {
      pushUndoSnapshot();
      const snapshot = await apiPost<LibrarySnapshot>("/api/libraries/current/nodes", {
        type,
        x: nodeCreateMenu.worldX,
        y: nodeCreateMenu.worldY,
        width: imageNodeWidth,
        height: type === "image" ? imageNodeHeight : 180,
        connectFromNodeId: nodeCreateMenu.fromNodeId
      });
      setLibrary(snapshot);
      setSelectedNodeId(snapshot.nodes[snapshot.nodes.length - 1]?.canvas.id ?? null);
      setNodeCreateMenu(null);
      setStatus(`${type === "image" ? "Image" : "Text"} node created`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create node.");
    }
  }

  async function saveTextNode(nodeId: string, text: string) {
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/text-nodes/${encodeURIComponent(nodeId)}`, { text });
      setLibrary(snapshot);
      setStatus("Text saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save text.");
    }
  }

  async function saveTextNodeColor(nodeId: string, color: string) {
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/text-nodes/${encodeURIComponent(nodeId)}`, { color });
      setLibrary(snapshot);
      setStatus("Text color saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save text color.");
    }
  }

  async function saveImagePrompt(nodeId: string, prompt: string) {
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/image-nodes/${encodeURIComponent(nodeId)}/prompt`, { prompt });
      setLibrary(snapshot);
      setStatus("Prompt saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save prompt.");
    }
  }

  async function renameNode(nodeId: string, title: string) {
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/nodes/${encodeURIComponent(nodeId)}/title`, { title });
      setLibrary(snapshot);
      setStatus("Node renamed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not rename node.");
    }
  }

  async function uploadImageToNodeStack(nodeId: string) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        setStatus(`Adding ${file.name} to stack...`);
        const dataBase64 = await fileToBase64(file);
        const snapshot = await apiPost<LibrarySnapshot>(`/api/libraries/current/image-nodes/${encodeURIComponent(nodeId)}/stack`, {
          filename: file.name,
          dataBase64
        });
        setLibrary(snapshot);
        setSelectedNodeId(nodeId);
        setStatus("Image added to stack");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not add image to stack.");
      }
    };
    input.click();
  }

  async function setActiveStackImage(nodeId: string, activeStackIndex: number) {
    try {
      const snapshot = await apiPut<LibrarySnapshot>(`/api/libraries/current/image-nodes/${encodeURIComponent(nodeId)}/stack/active`, { activeStackIndex });
      setLibrary(snapshot);
      setSelectedNodeId(nodeId);
      setStatus("Stack image selected");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not select stack image.");
    }
  }

  async function runImageGeneration(nodeId: string, modelId: string, prompt: string, providerId?: string, inputNodeIds?: string[], maxImageInputs?: number, imageReferenceSyntax?: string, parameters?: ImageGenerationParameters) {
    try {
      setStatus("Generating image...");
      setGenerationFeedback((current) => ({ ...current, [nodeId]: { busy: true, message: "Generating..." } }));
      const snapshot = await apiPost<LibrarySnapshot>(`/api/libraries/current/image-nodes/${encodeURIComponent(nodeId)}/generate`, {
        modelId,
        prompt,
        providerId,
        inputNodeIds,
        maxImageInputs,
        imageReferenceSyntax,
        parameters
      });
      setLibrary(snapshot);
      setSelectedNodeId(nodeId);
      setStatus("Generation added to stack");
      setGenerationFeedback((current) => ({ ...current, [nodeId]: { busy: false, message: "Added to stack" } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not run generation.";
      setStatus(message);
      setGenerationFeedback((current) => ({ ...current, [nodeId]: { busy: false, message, error: true } }));
    }
  }

  async function duplicateStackItemNode(nodeId: string, stackItemId: string, point: { x: number; y: number }) {
    try {
      pushUndoSnapshot();
      const snapshot = await apiPost<LibrarySnapshot>(
        `/api/libraries/current/image-nodes/${encodeURIComponent(nodeId)}/stack/${encodeURIComponent(stackItemId)}/duplicate-node`,
        { x: point.x, y: point.y, width: imageNodeWidth, height: imageNodeHeight }
      );
      setLibrary(snapshot);
      setOpenStackNodeId(null);
      setStatus("Stack image pulled into a new node");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create node from stack image.");
    }
  }

  async function deleteStackItem(nodeId: string, stackItemId: string) {
    try {
      const snapshot = await apiDelete<LibrarySnapshot>(`/api/libraries/current/image-nodes/${encodeURIComponent(nodeId)}/stack/${encodeURIComponent(stackItemId)}`);
      setLibrary(snapshot);
      setStackItemMenu(null);
      setStatus("Stack image deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete stack image.");
    }
  }

  async function saveStackItem(nodeId: string, stackItemId: string) {
    await downloadPreview(`${apiBase}/api/libraries/current/image-nodes/${encodeURIComponent(nodeId)}/stack/${encodeURIComponent(stackItemId)}`, "stack-image");
    setStackItemMenu(null);
  }

  async function deleteSelectedNode(nodeId: string) {
    try {
      pushUndoSnapshot();
      const snapshot = await apiDelete<LibrarySnapshot>(`/api/libraries/current/nodes/${encodeURIComponent(nodeId)}`);
      setLibrary(snapshot);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setStatus("Node deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete node.");
    }
  }

  async function deleteSelectedNodes(nodeIds: string[]) {
    try {
      pushUndoSnapshot();
      let snapshot: LibrarySnapshot | null = null;
      for (const nodeId of nodeIds) {
        snapshot = await apiDelete<LibrarySnapshot>(`/api/libraries/current/nodes/${encodeURIComponent(nodeId)}`);
      }
      if (snapshot) setLibrary(snapshot);
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
      setSelectionMenu(null);
      setStatus(nodeIds.length > 1 ? "Nodes deleted" : "Node deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete nodes.");
    }
  }

  async function deleteSelectedEdge(edgeId: string) {
    try {
      pushUndoSnapshot();
      const snapshot = await apiDelete<LibrarySnapshot>(`/api/libraries/current/edges/${encodeURIComponent(edgeId)}`);
      setLibrary(snapshot);
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

  function viewportCenterWorldPoint() {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const bounds = canvas.getBoundingClientRect();
    return screenToWorld(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
  }

  return (
    <main className={`livingCanvasShell${libraryOpen ? "" : " libraryCollapsed"}${inspectorOpen ? " inspectorOpen" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <img src="/snarkroute-icon.png" alt="" />
          <div>
            <h1>SnarkRoute</h1>
            <span>Living Canvas</span>
          </div>
        </div>
        <div className="toolbar" aria-label="Canvas controls">
          <button className="iconButton" type="button" onClick={() => setTheme(theme === "night" ? "day" : "night")} title={theme === "night" ? "Switch to day" : "Switch to night"}>
            {theme === "night" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <label className="sceneSelect" title="Canvas background">
            <Wallpaper size={17} />
            <select value={background} onChange={(event) => setBackground(event.target.value as BackgroundName)} aria-label="Canvas background">
              {backgroundOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <button className="iconButton" type="button" onClick={() => setInspectorOpen((value) => !value)} title="Toggle context">
            <PanelRight size={18} />
          </button>
        </div>
      </header>

      {libraryOpen && (
        <aside className="libraryRail">
          <div className="panelTitle">
            <Folder size={17} />
            <h2>Library</h2>
            <button className="panelCollapseButton" type="button" onClick={() => setLibraryOpen(false)} title="Collapse library">
              <PanelRight size={16} />
            </button>
          </div>
          <div className="libraryCard">
            <strong>{library?.manifest.title ?? "Local library"}</strong>
            <span>{library?.path ?? "Loading..."}</span>
          </div>
          <div className="nestedList">
            {library?.nestedLibraries.length ? library.nestedLibraries.map((entry) => (
              <button key={`${entry.id}-${entry.path}`} type="button" onClick={() => void openNestedLibrary(entry.path)}>
                <Folder size={15} />
                <span>{entry.title}</span>
                <small>{entry.hasCanvas ? "canvas" : entry.defaultView}</small>
              </button>
            )) : <p>No nested libraries yet.</p>}
          </div>
        </aside>
      )}
      {!libraryOpen && (
        <button className="libraryReopenButton" type="button" onClick={() => setLibraryOpen(true)} title="Open library">
          <PanelRight size={16} />
        </button>
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
            onSelectEdge={(edgeId) => {
              setSelectedEdgeId(edgeId);
              setSelectedNodeId(null);
            }}
          />
          {nodes.map((node) => (
            <ImageNode
              key={node.manifest.id}
              node={node}
              active={selectedNodeIds.length === 1 && selectedNodeId === node.canvas.id}
              selected={selectedNodeIds.includes(node.canvas.id)}
              inputNodes={inputChipsForNode(node.canvas.id, edges, nodeById)}
              onPointerDown={handleNodePointerDown}
              onClick={handleNodeClick}
              onContextMenu={handleNodeContextMenu}
              onInputPointerDown={handleInputPointerDown}
              onOutputPointerDown={handleOutputPointerDown}
              onOpenPreview={(nodeId, index, title) => setPreviewImage({ nodeId, index, title })}
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
                event.stopPropagation();
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
              models={models.filter((model) => model.nodeTypes.includes(node.manifest.type))}
              modelId={modelSelections[node.canvas.id] ?? modelSelectionId(models.find((model) => model.nodeTypes.includes(node.manifest.type)))}
              generationFeedback={generationFeedback[node.canvas.id]}
              modelSearchOpen={modelSearchNodeId === node.canvas.id}
              onToggleModelSearch={(nodeId) => setModelSearchNodeId((current) => current === nodeId ? null : nodeId)}
              onSelectModel={(nodeId, modelId) => {
                setModelSelections({ ...modelSelections, [nodeId]: modelId });
                setModelSearchNodeId(null);
              }}
              onRunGeneration={(nodeId, modelId, prompt, providerId, inputNodeIds, maxImageInputs, imageReferenceSyntax, parameters) => void runImageGeneration(nodeId, modelId, prompt, providerId, inputNodeIds, maxImageInputs, imageReferenceSyntax, parameters)}
              onSavePrompt={(nodeId, prompt) => void saveImagePrompt(nodeId, prompt)}
              onSaveText={saveTextNode}
              onSaveTextColor={saveTextNodeColor}
              onDeleteNode={(nodeId) => void deleteSelectedNode(nodeId)}
              onRenameNode={(nodeId, title) => void renameNode(nodeId, title)}
            />
          ))}
        </div>
        {nodeCreateMenu && (
          <div className="nodeCreateMenu" style={{ left: nodeCreateMenu.x, top: nodeCreateMenu.y }}>
            <button type="button" onClick={() => void createConnectedNode("image")}>Create image node</button>
            <button type="button" onClick={() => void createConnectedNode("text")}>Create text node</button>
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
              node={nodes.find((node) => node.canvas.id === previewImage.nodeId && node.manifest.type === "image") as ImageNodeView | undefined}
              onChangeIndex={(index) => setPreviewImage({ ...previewImage, index })}
              onMakeMain={(nodeId, index) => void setActiveStackImage(nodeId, index)}
            />
          </div>
        </div>
      )}
      {stackItemMenu && (
        <div className="stackItemMenu" style={{ left: stackItemMenu.x, top: stackItemMenu.y }}>
          <button type="button" onClick={() => void duplicateStackItemNode(stackItemMenu.nodeId, stackItemMenu.stackItemId, screenToWorld(stackItemMenu.x, stackItemMenu.y))}>Transform to node</button>
          <button type="button" onClick={() => void deleteStackItem(stackItemMenu.nodeId, stackItemMenu.stackItemId)}>Delete</button>
          <button type="button" onClick={() => void saveStackItem(stackItemMenu.nodeId, stackItemMenu.stackItemId)}>Save</button>
        </div>
      )}
      {selectionMenu && selectedNodeIds.length > 0 && (
        <div className="selectionMenu" style={{ left: selectionMenu.x, top: selectionMenu.y }}>
          <button type="button" onClick={() => void deleteSelectedNodes(selectedNodeIds)}>
            Delete {selectedNodeIds.length > 1 ? `${selectedNodeIds.length} nodes` : "node"}
          </button>
        </div>
      )}

      {inspectorOpen && (
        <aside className="inspector">
          <div className="panelTitle">
            <PanelRight size={17} />
            <h2>Context</h2>
          </div>
          <dl>
            <div><dt>Nodes</dt><dd>{nodes.length}</dd></div>
            <div><dt>View</dt><dd>{library?.manifest.defaultView ?? "canvas"}</dd></div>
            <div><dt>Canvas</dt><dd>{library?.manifest.canvas ?? "none"}</dd></div>
          </dl>
        </aside>
      )}
    </main>
  );
}

function CanvasEdges({
  nodes,
  edges,
  preview,
  selectedEdgeId,
  onSelectEdge
}: {
  nodes: NodeView[];
  edges: CanvasEdge[];
  preview: Extract<DragState, { kind: "connection" }> | null;
  selectedEdgeId: string | null;
  onSelectEdge: (edgeId: string) => void;
}) {
  const nodeById = new Map(nodes.map((node) => [node.canvas.id, node.canvas]));
  return (
    <svg className="canvasEdges">
      {edges.map((edge) => {
        const from = nodeById.get(edge.fromNodeId);
        const to = nodeById.get(edge.toNodeId);
        if (!from || !to) return null;
        const start = nodeOutputPoint(from);
        const end = nodeInputPoint(to);
        return <path key={edge.id} className={selectedEdgeId === edge.id ? "isSelected" : ""} d={edgePath(start, end)} onClick={(event) => { event.stopPropagation(); onSelectEdge(edge.id); }} />;
      })}
      {preview && <path className="edgePreview" d={edgePath({ x: preview.startX, y: preview.startY }, { x: preview.currentX, y: preview.currentY })} />}
    </svg>
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
  onInputPointerDown,
  onOutputPointerDown,
  onOpenPreview,
  onUploadStackImage,
  openStack,
  onToggleStack,
  onSelectStackImage,
  onDragStackImage,
  onStackItemContextMenu,
  models,
  modelId,
  generationFeedback,
  modelSearchOpen,
  onToggleModelSearch,
  onSelectModel,
  onRunGeneration,
  onSavePrompt,
  onSaveText,
  onSaveTextColor,
  onDeleteNode,
  onRenameNode
}: {
  node: NodeView;
  active: boolean;
  selected: boolean;
  inputNodes: InputNodeChip[];
  onPointerDown: (event: React.PointerEvent<HTMLElement>, node: NodeView) => void;
  onClick: (event: React.MouseEvent<HTMLElement>, node: NodeView) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>, node: NodeView) => void;
  onInputPointerDown: (event: React.PointerEvent<HTMLElement>, node: NodeView) => void;
  onOutputPointerDown: (event: React.PointerEvent<HTMLElement>, node: NodeView) => void;
  onOpenPreview: (nodeId: string, index: number, title: string) => void;
  onUploadStackImage: (nodeId: string) => void;
  openStack: boolean;
  onToggleStack: (nodeId: string) => void;
  onSelectStackImage: (nodeId: string, index: number) => void;
  onDragStackImage: (event: React.PointerEvent<HTMLElement>, nodeId: string, stackItemId: string) => void;
  onStackItemContextMenu: (event: React.MouseEvent<HTMLElement>, nodeId: string, stackItemId: string) => void;
  models: ModelOption[];
  modelId: string;
  generationFeedback?: GenerationFeedback;
  modelSearchOpen: boolean;
  onToggleModelSearch: (nodeId: string) => void;
  onSelectModel: (nodeId: string, modelId: string) => void;
  onRunGeneration: (nodeId: string, modelId: string, prompt: string, providerId?: string, inputNodeIds?: string[], maxImageInputs?: number, imageReferenceSyntax?: string, parameters?: ImageGenerationParameters) => void;
  onSavePrompt: (nodeId: string, prompt: string) => void;
  onSaveText: (nodeId: string, text: string) => void;
  onSaveTextColor: (nodeId: string, color: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onRenameNode: (nodeId: string, title: string) => void;
}) {
  const previewUrl = node.previewUrl ? `${apiBase}${node.previewUrl}?v=${encodeURIComponent(node.activeStackItem?.id ?? node.manifest.id)}` : "";
  const stackCount = node.manifest.type === "image" ? node.manifest.stack.length : 0;
  const activeIndex = node.manifest.type === "image" && stackCount ? node.manifest.activeStackIndex + 1 : 0;
  const isTextNode = node.manifest.type === "text";
  const [prompt, setPrompt] = useState(node.manifest.type === "image" ? node.manifest.currentPrompt ?? "" : "");
  const [modelQuery, setModelQuery] = useState("");
  const [orderedInputNodes, setOrderedInputNodes] = useState(inputNodes);
  const [parametersOpen, setParametersOpen] = useState(false);
  const [promptInsertRequest, setPromptInsertRequest] = useState<{ token: string; sequence: number } | null>(null);
  const promptInsertSequence = useRef(0);
  const needsImageInput = inputNodes.some((input) => input.type === "image") || (node.manifest.type === "image" && node.manifest.stack.length > 0);
  const compatibleModels = needsImageInput ? models.filter((model) => model.acceptsImageInput !== false) : models;
  const selectedModel: ModelOption = compatibleModels.find((model) => modelSelectionId(model) === modelId) ?? compatibleModels.find((model) => model.id === modelId) ?? compatibleModels[0] ?? { id: "", title: "Select model", nodeTypes: ["image"] };
  const visibleModels = compatibleModels.filter((model) => model.title.toLowerCase().includes(modelQuery.toLowerCase()) || model.id.toLowerCase().includes(modelQuery.toLowerCase()));
  const selectedModelLogo = modelLogoFor(selectedModel.providerId, selectedModel.id);
  const selectedModelKey = modelSelectionId(selectedModel);
  const [generationParameters, setGenerationParameters] = useState<ImageGenerationParameters>(() => modelGenerationParameters(selectedModel));
  const parameterDefinitions = selectedModel.generationParameters ?? [];
  const imageInputs = orderedInputNodes.filter((input) => input.type === "image");
  const maxImageInputs = selectedModel.maxImageInputs;
  useEffect(() => {
    setOrderedInputNodes((current) => {
      const byId = new Map(inputNodes.map((input) => [input.id, input]));
      return [...current.filter((input) => byId.has(input.id)).map((input) => byId.get(input.id)!), ...inputNodes.filter((input) => !current.some((existing) => existing.id === input.id))];
    });
  }, [inputNodes]);
  useEffect(() => {
    setGenerationParameters(modelGenerationParameters(selectedModel));
    setParametersOpen(false);
  }, [selectedModelKey]);

  function insertInputToken(input: InputNodeChip) {
    const imageIndex = imageInputs.findIndex((candidate) => candidate.id === input.id);
    if (input.type === "image" && maxImageInputs !== undefined && imageIndex >= maxImageInputs) return;
    const token = `[[${input.type === "text" ? "text" : "image"}:${input.id}]]`;
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
  if (isTextNode) {
    return (
      <article
        className={`textNode${active ? " isActive" : ""}${selected ? " isSelected" : ""}`}
        style={{
          "--image-height": `${node.canvas.height}px`,
          transform: `translate(${node.canvas.x}px, ${node.canvas.y}px)`,
          width: node.canvas.width,
          height: node.canvas.height
        } as React.CSSProperties}
        onClick={(event) => onClick(event, node)}
        onContextMenu={(event) => onContextMenu(event, node)}
      >
        <button
          type="button"
          className="textNodeDragBar"
          aria-label="Select or move text node"
          onPointerDown={(event) => onPointerDown(event, node)}
        />
        <div className="nodeHandleLine nodeHandleLineInput" />
        <div className="nodeHandleLine nodeHandleLineOutput" />
        <div className="nodeHandle nodeHandleInput" title="Input" data-node-input-id={node.canvas.id} onPointerDown={(event) => onInputPointerDown(event, node)} />
        <div className="nodeHandle nodeHandleOutput" title="Output" data-node-output-id={node.canvas.id} onPointerDown={(event) => onOutputPointerDown(event, node)} />
        {active && (
          <div className="textColorSwatches" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            {["mint", "violet", "amber", "rose"].map((color) => (
              <button
                key={color}
                type="button"
                className={`textSwatch textSwatch-${color}${node.manifest.color === color ? " isSelected" : ""}`}
                aria-label={`Set ${color} color`}
                onClick={() => onSaveTextColor(node.manifest.id, color)}
              />
            ))}
            <button
              type="button"
              className="textDeleteButton"
              aria-label="Delete text node"
              onClick={() => onDeleteNode(node.manifest.id)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
        {inputNodes.length > 0 && (
          <div className="textInputChips">
            {inputNodes.map((input) => (
              <span className="inputChip" key={input.id}>
                {input.previewUrl ? <img src={`${apiBase}${input.previewUrl}`} alt="" /> : input.type === "image" ? <ImageIcon size={15} /> : <span className={`textChipThumb textColor-${input.color ?? "mint"}`}>T</span>}
              </span>
            ))}
          </div>
        )}
        <textarea
          className={`textNodeBody textColor-${node.manifest.color ?? "mint"}`}
          defaultValue={node.manifest.text}
          placeholder="Text"
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onClick(event, node);
          }}
          onBlur={(event) => onSaveText(node.manifest.id, event.currentTarget.value)}
        />
      </article>
    );
  }
  return (
    <article
      className={`imageNode${active ? " isActive" : ""}${selected ? " isSelected" : ""}`}
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
          <button type="button" aria-label="Download image" onClick={() => void downloadPreview(previewUrl, node.manifest.title)}><Download size={16} /></button>
          <button type="button" aria-label="Expand image" onClick={() => previewUrl && onOpenPreview(node.manifest.id, node.manifest.activeStackIndex, node.manifest.title)}><Expand size={16} /></button>
        </div>
      )}
      <div className="nodeTitle">
        {generationFeedback?.busy ? (
          <span className="nodeBusyGears" aria-label="Generating">
            <Cog size={12} className="nodeBusyGearLarge" />
            <Cog size={9} className="nodeBusyGearSmall" />
          </span>
        ) : <ImageIcon size={15} />}
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
        ) : <span>{node.manifest.title || (isTextNode ? "Text" : "Image")}</span>}
      </div>
      <div className="nodeHandleLine nodeHandleLineInput" />
      <div className="nodeHandleLine nodeHandleLineOutput" />
      <div className="nodeHandle nodeHandleInput" title="Input" data-node-input-id={node.canvas.id} onPointerDown={(event) => onInputPointerDown(event, node)} />
      <div className="nodeHandle nodeHandleOutput" title="Output" data-node-output-id={node.canvas.id} onPointerDown={(event) => onOutputPointerDown(event, node)} />
      <div className="imagePreview">
        {previewUrl ? <img src={previewUrl} alt={node.manifest.title} draggable={false} /> : (
          <div className="emptyNodePreview">
            {isTextNode ? "Text" : <ImageIcon size={32} />}
          </div>
        )}
        {active && (
          <button
            className="uploadStackButton"
            type="button"
            aria-label="Upload image to stack"
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
                {node.manifest.stack.length ? node.manifest.stack.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    className={index === node.manifest.activeStackIndex ? "isActive" : ""}
                    onPointerDown={(event) => onDragStackImage(event, node.manifest.id, item.id)}
                    onContextMenu={(event) => onStackItemContextMenu(event, node.manifest.id, item.id)}
                    onClick={() => onSelectStackImage(node.manifest.id, index)}
                  >
                    <img src={stackImageUrl(node.manifest.id, item.id)} alt="" />
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
              const imageIndex = imageInputs.findIndex((candidate) => candidate.id === input.id);
              const inactive = input.type === "image" && maxImageInputs !== undefined && imageIndex >= maxImageInputs;
              return (
              <button
                type="button"
                className={`inputChip${inactive ? " isInactive" : ""}`}
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
                {input.previewUrl ? <img src={`${apiBase}${input.previewUrl}`} alt="" /> : input.type === "image" ? <ImageIcon size={15} /> : <span className={`textChipThumb textColor-${input.color ?? "mint"}`}>T</span>}
              </button>
            ); }) : <span className="inputChip isEmpty">No inputs</span>}
          </div>
          <PromptComposer
            value={prompt}
            inputNodes={orderedInputNodes}
            maxImageInputs={maxImageInputs}
            insertRequest={promptInsertRequest}
            onChange={setPrompt}
            onBlur={() => onSavePrompt(node.manifest.id, prompt)}
          />
          <div className="promptMeta">
            <div className="modelPicker">
              <button
                type="button"
                className="modelPickerButton"
                aria-label={`Choose image model: ${selectedModel.title}`}
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
                  <div className="modelMenuList">
                    {visibleModels.map((model) => (
                      <button key={modelSelectionId(model)} type="button" onClick={() => onSelectModel(node.manifest.id, modelSelectionId(model))}>
                        <img src={modelLogoFor(model.providerId, model.id).src} alt="" />
                        <span>
                          <strong>{model.title}</strong>
                          <small>{model.id}</small>
                        </span>
                      </button>
                    ))}
                    {visibleModels.length === 0 ? <span className="modelMenuEmpty">No image models found</span> : null}
                  </div>
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
            <button type="button" aria-label="Run" disabled={!selectedModel.id || generationFeedback?.busy} onClick={() => onRunGeneration(node.manifest.id, selectedModel.id, prompt, selectedModel.providerId, orderedInputNodes.map((input) => input.id), selectedModel.maxImageInputs, selectedModel.imageReferenceSyntax, generationParameters)}><ArrowUp size={16} /></button>
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
  onChange,
  onBlur
}: {
  value: string;
  inputNodes: InputNodeChip[];
  maxImageInputs?: number;
  insertRequest: { token: string; sequence: number } | null;
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
      onClick={(event) => event.stopPropagation()}
    />
  );
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
  const tokenPattern = /\[\[(text|image):([^\]]+)\]\]/g;
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
  chip.className = `promptInlineChip${inactive ? " isInactive" : ""}`;
  chip.contentEditable = "false";
  chip.draggable = true;
  chip.dataset.promptToken = token;
  chip.title = input.title;
  if (input.previewUrl) {
    const image = document.createElement("img");
    image.src = `${apiBase}${input.previewUrl}`;
    image.alt = "";
    chip.append(image);
  } else {
    const thumbnail = document.createElement("span");
    thumbnail.className = input.type === "text" ? `textChipThumb textColor-${input.color ?? "mint"}` : "promptInlineImageFallback";
    thumbnail.textContent = input.type === "text" ? "T" : "I";
    chip.append(thumbnail);
  }
  return chip;
}

function serializePromptContent(editor: HTMLElement): string {
  return [...editor.childNodes].map((node) => serializePromptNode(node)).join("");
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
  const match = /^\[\[(text|image):([^\]]+)\]\]$/.exec(token);
  return match ? inputs.find((input) => input.type === match[1] && input.id === match[2]) : undefined;
}

function tokenForInputId(inputId: string, inputs: InputNodeChip[]): string {
  const input = inputs.find((candidate) => candidate.id === inputId);
  return input ? `[[${input.type === "text" ? "text" : "image"}:${input.id}]]` : "";
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
  range.insertNode(chip);
  range.setStartAfter(chip);
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
  node: ImageNodeView | undefined;
  onChangeIndex: (index: number) => void;
  onMakeMain: (nodeId: string, index: number) => void;
}) {
  const stack = node?.manifest.stack ?? [];
  const safeIndex = stack.length ? Math.min(Math.max(preview.index, 0), stack.length - 1) : 0;
  const item = stack[safeIndex];
  const imageUrl = item ? stackImageUrl(preview.nodeId, item.id) : "";
  const canGoPrevious = safeIndex > 0;
  const canGoNext = safeIndex < stack.length - 1;
  const isMain = node?.manifest.activeStackIndex === safeIndex;

  return (
    <>
      <div className="previewImageWrap">
        {imageUrl ? <img src={imageUrl} alt={preview.title} /> : <div className="previewEmpty">No image</div>}
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
    .map((node) => ({
      id: node.canvas.id,
      title: node.manifest.title,
      type: node.manifest.type,
      previewUrl: node.previewUrl,
      color: node.manifest.type === "text" ? node.manifest.color : undefined
    }));
}

function stackImageUrl(nodeId: string, stackItemId: string): string {
  return `${apiBase}/api/libraries/current/image-nodes/${encodeURIComponent(nodeId)}/stack/${encodeURIComponent(stackItemId)}?v=${encodeURIComponent(stackItemId)}`;
}

function mergeModelOptions(options: ModelOption[]): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const option of options) {
    const key = modelSelectionId(option);
    if (!byId.has(key)) byId.set(key, option);
  }
  return [...byId.values()];
}

function modelSelectionId(model: ModelOption | undefined): string {
  if (!model) return "";
  return `${model.providerId ?? "unknown"}:${model.id}`;
}

function normalizeModelOptions(value: unknown, providerId?: string): ModelOption[] {
  const candidates = collectModelCandidates(value);
  const seen = new Set<string>();
  return candidates
    .map((entry): ModelOption | null => {
      const record = entry as Record<string, unknown>;
      const id = String(record.id ?? record.modelId ?? record.slug ?? record.name ?? "");
      const title = String(record.title ?? record.label ?? record.displayName ?? record.name ?? id);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        title,
        nodeTypes: inferModelNodeTypes(record),
        providerId: String(record.providerId ?? record.provider ?? providerId ?? providerFromModelId(id)),
        source: providerId,
        acceptsImageInput: modelAcceptsImageInput(record),
        maxImageInputs: modelMaxImageInputs(record),
        imageReferenceSyntax: modelImageReferenceSyntax(record),
        generationParameters: modelGenerationParameterDefinitions(record),
        defaultParameters: modelDefaultGenerationParameters(record)
      };
    })
    .filter((entry): entry is ModelOption => entry !== null && entry.nodeTypes.includes("image"));
}

function collectModelCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["models", "imageModels", "providerModels", "connectedModels", "availableModels", "items"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  const nested: unknown[] = [];
  for (const item of Object.values(record)) {
    nested.push(...collectModelCandidates(item));
  }
  return nested;
}

function inferModelNodeTypes(record: Record<string, unknown>): string[] {
  const architecture = record.architecture && typeof record.architecture === "object" ? record.architecture as Record<string, unknown> : {};
  const fields = [
    record.nodeTypes,
    record.nodeType,
    record.type,
    record.capabilities,
    record.modalities,
    record.inputModalities,
    record.outputModalities,
    architecture.input_modalities,
    architecture.output_modalities,
    architecture.modality,
    record.tasks,
    record.kind,
    record.category,
    record.family
  ];
  const text = fields.flatMap((field) => Array.isArray(field) ? field : [field]).filter(Boolean).map(String).join(" ").toLowerCase();
  if (/(image|img|vision|visual|text-to-image|image-generation|generation)/.test(text)) return ["image"];
  if (/(text|chat|language|embedding)/.test(text)) return ["text"];
  return [];
}

function modelAcceptsImageInput(record: Record<string, unknown>): boolean {
  const architecture = record.architecture && typeof record.architecture === "object" ? record.architecture as Record<string, unknown> : {};
  const provider = record.top_provider && typeof record.top_provider === "object" ? record.top_provider as Record<string, unknown> : {};
  const parameters = provider.parameters && typeof provider.parameters === "object" ? provider.parameters as Record<string, unknown> : {};
  const inputModalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities.map(String) : [];
  return inputModalities.some((modality) => modality.toLowerCase() === "image") || Object.hasOwn(parameters, "images");
}

function modelMaxImageInputs(record: Record<string, unknown>): number | undefined {
  const direct = Number(record.maxImageInputs ?? record.maxImages);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const ioContract = record.ioContract && typeof record.ioContract === "object" ? record.ioContract as Record<string, unknown> : {};
  const inputs = Array.isArray(ioContract.inputs) ? ioContract.inputs : [];
  const imageInput = inputs.find((input) => input && typeof input === "object" && (input as Record<string, unknown>).kind === "image") as Record<string, unknown> | undefined;
  const contracted = Number(imageInput?.maxItems);
  return Number.isInteger(contracted) && contracted > 0 ? contracted : undefined;
}

function modelImageReferenceSyntax(record: Record<string, unknown>): string | undefined {
  const value = record.imageReferenceSyntax ?? record.image_reference_syntax;
  return typeof value === "string" && value.includes("{index}") ? value : undefined;
}

function modelGenerationParameterDefinitions(record: Record<string, unknown>): ModelParameterDefinition[] | undefined {
  if (!Array.isArray(record.generationParameters)) return undefined;
  const definitions = record.generationParameters.flatMap((source) => {
    if (!source || typeof source !== "object") return [];
    const definition = source as Record<string, unknown>;
    const id = stringParameter(definition.id);
    const label = stringParameter(definition.label);
    const type: ModelParameterDefinition["type"] = definition.type === "number" || definition.type === "text" ? definition.type : "select";
    if (!id || !label) return [];
    const options = Array.isArray(definition.options)
      ? definition.options.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const option = entry as Record<string, unknown>;
          const value = stringParameter(option.value);
          return value ? [{ value, label: stringParameter(option.label) }] : [];
        })
      : undefined;
    return [{
      id,
      label,
      type,
      default: parameterValue(definition.default),
      options,
      min: numberParameter(definition.min),
      max: numberParameter(definition.max),
      step: numberParameter(definition.step)
    }];
  });
  return definitions.length ? definitions : [];
}

function modelDefaultGenerationParameters(record: Record<string, unknown>): ImageGenerationParameters | undefined {
  const source = record.defaultParameters ?? record.defaultParams;
  if (!source || typeof source !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(source as Record<string, unknown>).flatMap(([key, value]) => {
      const parameter = parameterValue(value);
      return parameter === undefined ? [] : [[key, parameter]];
    })
  );
}

function modelGenerationParameters(model: ModelOption): ImageGenerationParameters {
  const schemaDefaults = Object.fromEntries(
    (model.generationParameters ?? []).flatMap((definition) => definition.default === undefined ? [] : [[definition.id, definition.default]])
  );
  return { ...schemaDefaults, ...(model.defaultParameters ?? {}) };
}

function generationParameterSummary(definitions: ModelParameterDefinition[], values: ImageGenerationParameters): string {
  if (definitions.length === 0) return "No parameters";
  return definitions.slice(0, 2).map((definition) => String(values[definition.id] ?? definition.default ?? "")).filter(Boolean).join(" · ") || "Parameters";
}

function stringParameter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberParameter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parameterValue(value: unknown): GenerationParameterValue | undefined {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fallbackGeminiParameters(): ModelParameterDefinition[] {
  return [
    { id: "aspectRatio", label: "Aspect ratio", type: "select", default: "1:1", options: ["1:1", "3:2", "2:3", "16:9", "9:16"].map((value) => ({ value })) },
    { id: "imageSize", label: "Resolution", type: "select", default: "2K", options: ["1K", "2K", "4K"].map((value) => ({ value })) }
  ];
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target.isContentEditable
    || Boolean(target.closest('[contenteditable="true"]'));
}

function providerFromModelId(modelId: string): string {
  if (modelId.startsWith("image.")) return "gemini";
  if (modelId.startsWith("gemini-")) return "gemini";
  if (modelId.includes("/")) return modelId.split("/")[0] || "unknown";
  return "unknown";
}

function busyFavicon(angle: number): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#111813"/><g transform="rotate(${angle} 13 13)" fill="#8fd7b5" stroke="#d8ffe9" stroke-width="1"><path d="M13 4.5 15 6l2.4-.5 1.4 2.1-.9 2.3 1.6 2v2.2l-2.3.8-.7 2.4-2.3.7-1.7-1.8-2.4.5-1.4-2.1.9-2.3-1.6-2V10l2.3-.8.7-2.4Z"/><circle cx="13" cy="12" r="3.1" fill="#111813"/></g><g transform="rotate(${-angle} 22 22)" fill="#f3bf45" stroke="#ffe785" stroke-width=".85"><path d="M22 15.3 23.5 17l2.1-.1.7 2-1.5 1.5.4 2.1-1.9.9-1.6-1.4-2.1.5-.9-1.9 1.3-1.7-.5-2.1 1.9-.9Z"/><circle cx="22" cy="19.3" r="2" fill="#111813"/></g></svg>`)}`;
}

async function downloadPreview(previewUrl: string, title: string) {
  if (!previewUrl) return;
  const response = await fetch(previewUrl);
  const blob = await response.blob();
  const filename = `${title || "image"}.png`;
  const picker = window.showSaveFilePicker;
  if (picker) {
    const handle = await picker({
      suggestedName: filename,
      types: [{ description: "Image", accept: { [blob.type || "image/png"]: [".png", ".jpg", ".jpeg", ".webp"] } }]
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
  return { x: node.x, y: node.y + (node.type === "text" ? node.height / 2 : nodeTitleHeight + node.height / 2) };
}

function nodeOutputPoint(node: CanvasNode) {
  return { x: node.x + node.width, y: node.y + (node.type === "text" ? node.height / 2 : nodeTitleHeight + node.height / 2) };
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
