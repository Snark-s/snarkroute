import { useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent, type SetStateAction } from "react";
import JSZip from "jszip";
import { AlertTriangle, Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, ChevronDown, ChevronUp, Cloud, CopyPlus, Dices, ExternalLink, Eye, FolderOpen, Image, ListPlus, LoaderCircle, Music, PackageOpen, Pencil, Play, Settings2, Square, Trash2, Upload, Video, X } from "lucide-react";
import { apiBase } from "../../studioConfig";
import { apiFetch } from "../../shared/apiClient";
import { VideoUpscaleComposer, type VideoUpscaleDraft } from "./VideoUpscaleComposer";
import { addExactDuplicateWarnings, addImportAssetAsReference, analyzeImportSet, attachImportFileToReference, changeImportManualRoleSource, changeImportReferenceSource, compatibleImportTargets, importAssignmentConflict, importReferenceContext, importReferenceLabel, importReferenceUiGroup, importSourcePickerCandidates, mediaKindForImportFile, resolveImportReference, swapImportReferenceSources, unassignImportManualRole, unassignImportReference, useImportAssetAsVideoOne, videoOneImportCandidates, videoOneSourceCandidates, type H3ImportAnalysis, type H3ImportFile, type H3ImportMediaKind, type H3ImportedReference } from "./h3ImportSet";

type Operation = "text_to_video" | "first_last_frame" | "motion_transfer" | "style_transfer" | "reference_mix" | "replace_object" | "automatic_tracking" | "regenerate_2k" | "video_upscale";
type ItemStatus = "ready" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
type SessionStatus = "idle" | "connecting" | "rendering" | "cancelling" | "cleaning" | "completed" | "completed_with_errors" | "cancelled" | "failed" | "cleanup_failed";
type AssetSlot = "firstFrame" | "lastFrame" | "referenceImage" | "identityImage" | "referenceVideo" | "referenceAudio" | "sourceVideo" | "mask";
type AssetKind = "image" | "video" | "audio";
type TaskFamily = "FL2VA" | "Ref2VA";
type ModelVariant = "h3_base" | "10eros_max" | "10eros_max_turbo" | "h3_max" | "h3_max_turbo";
type AttentionMode = "auto" | "veda" | "dense";
type H3Model = { id: ModelVariant; display_name: string; purpose: "preview" | "final"; default_steps: number; minimum_steps: number; maximum_steps: number; weights_installed: boolean; hosted?: boolean; selectable?: boolean; experimental?: boolean; cost?: { rates?: Record<string, number>; referenceRates?: Record<string, number>; promotionEndsAt?: string; referenceInputsExtra?: boolean }; recommended_for_16gb?: boolean; downloading?: boolean; progress?: number; error?: string | null };
type VisualModifierId = "authentic_cinematic_texture";
type H3Modifier = { id: "faceswap_ref2va" | VisualModifierId; title?: string; category?: "identity" | "visual"; notes?: string; capability_status?: string; repository: string; revision: string; filename: string; weights_installed: boolean; downloading?: boolean; progress?: number; error?: string | null; trigger?: string | null; default_strength?: number; motion_strength?: number; compatibility?: string };
type CameraKeyframe = { time: number; azimuth: number; elevation: number; distance: number };
type CameraPath = { schemaVersion: "1.0"; keyframes: CameraKeyframe[]; interpolation: "linear" | "smooth"; loopClosure: "auto" | "off"; startHold: number; endHold: number; subjectBox?: { x: number; y: number; width: number; height: number } };

type QueueAsset = { slot: AssetSlot; kind: AssetKind; path: string; filename: string; mimeType: string };
export type ComposerAsset = QueueAsset & { composerId: string; missing?: boolean; sourceFilename?: string; importNodeId?: string };
type QueueItem = {
  id: string;
  title: string;
  operation: Operation;
  prompt: string;
  videoUpscale?: Record<string, unknown>;
  duration: number;
  aspectRatio: string;
  seed?: number;
  variants: number;
  renderMode: "preview" | "final";
  modelVariant: ModelVariant;
  inferenceSteps?: number;
  attentionMode?: AttentionMode;
  identityTransfer?: { enabled: true; strength: number };
  visualModifier?: { id: "authentic_cinematic_texture"; enabled: true; strength: number; includeTrigger: boolean };
  cameraPath?: CameraPath;
  cameraControlMode?: "auto" | "native" | "prompt";
  promptJson?: Record<string, unknown>;
  assets: QueueAsset[];
  status: ItemStatus;
  progress: number;
  startedAt?: string;
  stage?: string;
  resultPaths?: string[];
  resultMetadata?: { provider: "local" | "fal"; model: string; endpoint?: string; estimatedCostUsd?: number | null; latencyMs?: { total?: number }; provenance?: Record<string, unknown> };
  error?: string;
  selectedForRun?: boolean;
  archivedAt?: string;
};
type QueueSession = {
  id: string;
  mode: "saved_worker" | "vast" | "provider";
  status: SessionStatus;
  currentItemId?: string;
  managedInstanceId?: number;
  hourlyPriceUsd?: number;
  cleanupConfirmed: boolean | null;
  error?: string;
};
type VastStatus = {
  configured: boolean;
  apiKeyConfigured: boolean;
  templateHashConfigured: boolean;
  workerUrlTemplateConfigured: boolean;
  sshKeyConfigured: boolean;
  hfTokenConfigured: boolean;
  serviceTokenConfigured: boolean;
  licenseAccepted: boolean;
  connectionMode: "ssh_tunnel" | "external_https";
  maxHourlyUsd: number;
  excludedCountryCodes: string[];
  workerUrlTemplate: string;
  sshPrivateKeyPath: string;
  sourceRevision: string;
  image: string;
  reason?: string;
};
type QueueState = { version: 1; items: QueueItem[]; session: QueueSession; vast: VastStatus };
type ImportBundle = { analysis: H3ImportAnalysis; files: Map<string, File> };
type ContextPreset = "none" | "raw" | "motion" | "subject" | "style";

type ComposerDraft = {
  version: 1;
  taskFamily: TaskFamily;
  recipeOperation: Operation;
  title: string;
  prompt: string;
  contextInstruction: string;
  contextPreset: ContextPreset;
  promptJson: string;
  duration: number;
  aspectRatio: string;
  variants: number;
  seed: string;
  renderMode: "preview" | "final";
  modelVariant: ModelVariant;
  inferenceSteps: number;
  attentionMode: AttentionMode;
  identityEnabled: boolean;
  identityStrength: number;
  visualModifierEnabled: boolean;
  visualModifierId?: VisualModifierId;
  visualModifierStrength: number;
  visualModifierTrigger: boolean;
  cameraEnabled: boolean;
  cameraMode: "auto" | "native" | "prompt";
  cameraPath: CameraPath;
  assets: ComposerAsset[];
  importedWorkflow?: H3ImportAnalysis;
};

type QueueSubmissionInput = {
  taskFamily: TaskFamily;
  title: string;
  operation: Operation;
  prompt: string;
  finalRequest: string;
  promptJson: string;
  contextInstruction: string;
  contextPreset: ContextPreset;
  duration: number;
  aspectRatio: string;
  variants: number;
  seed: string;
  renderMode: "preview" | "final";
  modelVariant: ModelVariant;
  inferenceSteps: number;
  attentionMode?: AttentionMode;
  assets: ComposerAsset[];
  importedWorkflow?: H3ImportAnalysis;
  identityEnabled: boolean;
  identityStrength: number;
  visualModifierEnabled: boolean;
  visualModifierId?: VisualModifierId;
  visualModifierStrength: number;
  visualModifierTrigger: boolean;
  cameraEnabled: boolean;
  cameraMode: "auto" | "native" | "prompt";
  cameraPath?: CameraPath;
};

const COMPOSER_DRAFT_KEY = "snarkroute.h3.composer.v1";

const operations: Array<{ value: Operation; label: string; note: string; executable: boolean }> = [
  { value: "video_upscale", label: "Video Upscale", note: "Conservative temporal enlargement · Local GPU", executable: true },
  { value: "text_to_video", label: "Текст → видео и звук", note: "FL2VA без исходников", executable: true },
  { value: "first_last_frame", label: "Первый / последний кадр", note: "Один или два кадра", executable: true },
  { value: "motion_transfer", label: "Перенос движения", note: "Укажи движение из <Video 1>; образ из <Picture 1> — по желанию. Локально: первые 15 с видео, до 512 px; выход с нативным звуком H3.", executable: true },
  { value: "style_transfer", label: "Перенос стиля видео · не подтверждён", note: "Отключено: H3 Ref2VA переносит смысл/персонажа, но нейтральный A/B не подтвердил устойчивый стиль <Picture 1> на всём <Video 1>.", executable: false },
  { value: "reference_mix", label: "Персонаж, внешность и движение", note: "Используй <Picture 1> для identity/appearance и <Video 1> для движения. Полноценный художественный style transfer не подтверждён; аудиореференсы локально недоступны.", executable: true },
  { value: "replace_object", label: "Замена области / объекта", note: "Ждёт video_inpaint backend", executable: false },
  { value: "automatic_tracking", label: "Автотрекинг объекта", note: "Ждёт tracking adapter", executable: false },
  { value: "regenerate_2k", label: "Local Regenerate 2K · unavailable", note: "No compatible local H3 regeneration backend is known/installed. Hosted MiniMax Regeneration is a separate paid API; fal MP4 compatibility is unverified.", executable: false }
];

const quickRecipes: Array<{ operation: Operation; title: string; family: TaskFamily; preset: ContextPreset; context: string; badge?: string }> = [
  { operation: "motion_transfer", title: "Motion from Video", family: "Ref2VA", preset: "motion", context: "Use <Video 1> as the motion, timing, framing, and camera reference.", badge: "Ref2VA" },
  { operation: "reference_mix", title: "Character / Identity", family: "Ref2VA", preset: "subject", context: "Preserve the subject identity and appearance from <Picture 1> while following the scene prompt.", badge: "Ref2VA" },
  { operation: "style_transfer", title: "Style", family: "Ref2VA", preset: "style", context: "Use <Picture 1> as an appearance/style reference and <Video 1> only for motion and timing.", badge: "unverified" },
  { operation: "replace_object", title: "Replace Region", family: "Ref2VA", preset: "raw", context: "Use the supplied mask and picture reference for the explicitly selected region.", badge: "special pipeline" },
  { operation: "automatic_tracking", title: "Tracking", family: "Ref2VA", preset: "raw", context: "Track the explicitly selected subject across the source video.", badge: "special pipeline" },
];

const productionStages = [
  { title: "1. Turbo Preview", model: "H3 Max Turbo", note: "Fast idea, composition, and motion check." },
  { title: "2. Max Motion Check", model: "H3 Max", note: "Timing, sound, first/last frame, and native CameraPath adapter." },
  { title: "3. H3 Ref/Edit", model: "MiniMax H3 Base Ref2VA", note: "Subject, identity, appearance, and motion references." },
  { title: "4. Video Upscale", model: "VimeoScale 2× — Conservative Video", note: "Explicit local conservative upscale through Queue; optional delivery resize/pad. H3 Regenerate 2K remains a separate hosted re-render capability." },
] as const;

const assetSlots: Record<Operation, Array<{ slot: AssetSlot; kind: AssetKind; label: string }>> = {
  video_upscale: [{ slot: "sourceVideo", kind: "video", label: "Input video" }],
  text_to_video: [],
  first_last_frame: [
    { slot: "firstFrame", kind: "image", label: "Первый кадр" },
    { slot: "lastFrame", kind: "image", label: "Последний кадр" }
  ],
  motion_transfer: [
    { slot: "referenceVideo", kind: "video", label: "Видео движения" },
    { slot: "referenceImage", kind: "image", label: "Референс образа (необязательно)" }
  ],
  style_transfer: [
    { slot: "referenceVideo", kind: "video", label: "Исходное видео · движение и камера" },
    { slot: "referenceImage", kind: "image", label: "Референс визуального стиля" }
  ],
  reference_mix: [
    { slot: "referenceImage", kind: "image", label: "Изображение" },
    { slot: "identityImage", kind: "image", label: "Identity / Face reference" },
    { slot: "referenceVideo", kind: "video", label: "Видео" },
    { slot: "referenceAudio", kind: "audio", label: "Аудио" }
  ],
  replace_object: [
    { slot: "sourceVideo", kind: "video", label: "Исходное видео" },
    { slot: "mask", kind: "image", label: "Маска" },
    { slot: "referenceImage", kind: "image", label: "Новый объект" }
  ],
  automatic_tracking: [
    { slot: "sourceVideo", kind: "video", label: "Исходное видео" },
    { slot: "mask", kind: "image", label: "Выделение на кадре" }
  ],
  regenerate_2k: [{ slot: "sourceVideo", kind: "video", label: "Видео для 2K" }]
};

const EMPTY_VAST: VastStatus = {
  configured: false, apiKeyConfigured: false, templateHashConfigured: false, workerUrlTemplateConfigured: false,
  sshKeyConfigured: false, hfTokenConfigured: false, serviceTokenConfigured: false, licenseAccepted: false,
  connectionMode: "ssh_tunnel", maxHourlyUsd: 1.2, excludedCountryCodes: [], workerUrlTemplate: "", sshPrivateKeyPath: "", sourceRevision: "", image: ""
};

export function H3QueuePanel({ finalAvailable = false }: { finalAvailable?: boolean }) {
  const [upscaleDraft, setUpscaleDraft] = useState<VideoUpscaleDraft>();
  const draft = useMemo(loadComposerDraft, []);
  const [state, setState] = useState<QueueState | null>(null);
  const [taskFamily, setTaskFamily] = useState<TaskFamily>(draft.taskFamily);
  const [recipeOperation, setRecipeOperation] = useState<Operation>(draft.recipeOperation);
  const [title, setTitle] = useState(draft.title);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [contextInstruction, setContextInstruction] = useState(draft.contextInstruction);
  const [contextPreset, setContextPreset] = useState<ContextPreset>(draft.contextPreset);
  const [promptJson, setPromptJson] = useState(draft.promptJson);
  const [duration, setDuration] = useState(draft.duration);
  const [aspectRatio, setAspectRatio] = useState(draft.aspectRatio);
  const [variants, setVariants] = useState(draft.variants);
  const [seed, setSeed] = useState(draft.seed);
  const [renderMode, setRenderMode] = useState<"preview" | "final">(draft.renderMode);
  const [modelVariant, setModelVariant] = useState<ModelVariant>(draft.modelVariant);
  const [inferenceSteps, setInferenceSteps] = useState(draft.inferenceSteps);
  const [attentionMode, setAttentionMode] = useState<AttentionMode>(draft.attentionMode);
  const [identityEnabled, setIdentityEnabled] = useState(draft.identityEnabled);
  const [identityStrength, setIdentityStrength] = useState(draft.identityStrength);
  const [visualModifierEnabled, setVisualModifierEnabled] = useState(draft.visualModifierEnabled);
  const [visualModifierId, setVisualModifierId] = useState<VisualModifierId>(draft.visualModifierId ?? "authentic_cinematic_texture");
  const [visualModifierStrength, setVisualModifierStrength] = useState(draft.visualModifierStrength);
  const [visualModifierTrigger, setVisualModifierTrigger] = useState(draft.visualModifierTrigger);
  const [cameraEnabled, setCameraEnabled] = useState(draft.cameraEnabled);
  const [cameraMode, setCameraMode] = useState<"auto" | "native" | "prompt">(draft.cameraMode);
  const [cameraPath, setCameraPath] = useState<CameraPath>(draft.cameraPath);
  const [models, setModels] = useState<H3Model[]>([]);
  const [modifiers, setModifiers] = useState<H3Modifier[]>([]);
  const [assets, setAssets] = useState<ComposerAsset[]>(draft.assets);
  const [importedWorkflow, setImportedWorkflow] = useState<H3ImportAnalysis | undefined>(draft.importedWorkflow);
  const [importBundle, setImportBundle] = useState<ImportBundle | null>(null);
  const [showFinalRequest, setShowFinalRequest] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [enqueueError, setEnqueueError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragSlot, setDragSlot] = useState<AssetSlot | null>(null);
  const pasteTarget = useRef<{ slot: AssetSlot; kind: AssetKind } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const contextRef = useRef<HTMLTextAreaElement | null>(null);
  const activeTextField = useRef<"prompt" | "context">("prompt");
  const pictureInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const importSetInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [vastOpen, setVastOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [vastForm, setVastForm] = useState({ apiKey: "", hfToken: "", sshPrivateKeyPath: "", maxHourlyUsd: "1.2", acceptLicense: false });

  const sessionActive = Boolean(state && ["connecting", "rendering", "cancelling", "cleaning"].includes(state.session.status));
  const operation = operationForComposer(taskFamily, assets, recipeOperation);
  const operationInfo = useMemo(() => operations.find((item) => item.value === operation)!, [operation]);
  const finalRequest = useMemo(() => composeFinalRequest(taskFamily, prompt, contextPreset, contextInstruction), [taskFamily, prompt, contextPreset, contextInstruction]);
  const queueItems = state?.items.filter((item) => !item.archivedAt) ?? [];
  const archivedItems = state?.items.filter((item) => Boolean(item.archivedAt)) ?? [];
  const runnableCount = queueItems.filter((item) => item.selectedForRun !== false && ["ready", "failed", "blocked", "cancelled"].includes(item.status)).length;
  const selectedRunnable = queueItems.filter((item) => item.selectedForRun !== false && ["ready", "failed", "blocked", "cancelled"].includes(item.status));
  const hostedRunnableCount = selectedRunnable.filter((item) => item.operation !== "video_upscale" && isHostedModel(item.modelVariant)).length;
  const providerOnlySelection = hostedRunnableCount > 0 && hostedRunnableCount === selectedRunnable.length;
  const h3MaxRate = models.find((model) => model.id === "h3_max")?.cost?.rates?.["768P"] ?? 0.08;
  const h3TurboRate = models.find((model) => model.id === "h3_max_turbo")?.cost?.rates?.["768P"] ?? 0.04;
  const h3MaxReferenceRate = models.find((model) => model.id === "h3_max")?.cost?.referenceRates?.["768P"] ?? 0.08;
  const composerHostedRate = modelVariant === "h3_max_turbo" ? h3TurboRate : operation === "motion_transfer" || operation === "reference_mix" ? h3MaxReferenceRate : h3MaxRate;
  const selectedHostedEstimate = selectedRunnable.filter(item => item.operation !== "video_upscale").reduce((sum, item) => sum + item.duration * (item.modelVariant === "h3_max_turbo" ? h3TurboRate : item.operation === "motion_transfer" || item.operation === "reference_mix" ? h3MaxReferenceRate : h3MaxRate), 0);

  useEffect(() => { void refresh(); void refreshModels(); }, []);
  useEffect(() => {
    if (!models.some((model) => model.downloading) && !modifiers.some((modifier) => modifier.downloading)) return;
    const timer = window.setInterval(() => void refreshModels(false), 2_000);
    return () => window.clearInterval(timer);
  }, [models, modifiers]);
  useEffect(() => { if (!finalAvailable) setRenderMode("preview"); }, [finalAvailable]);
  useEffect(() => {
    const snapshot: ComposerDraft = {
      version: 1, taskFamily, recipeOperation, title, prompt, contextInstruction, contextPreset, promptJson,
      duration, aspectRatio, variants, seed, renderMode, modelVariant, inferenceSteps, attentionMode,
      identityEnabled, identityStrength, visualModifierEnabled, visualModifierId, visualModifierStrength, visualModifierTrigger, cameraEnabled, cameraMode, cameraPath, assets, importedWorkflow,
    };
    try { window.localStorage.setItem(COMPOSER_DRAFT_KEY, JSON.stringify(snapshot)); } catch { /* persistence is best-effort in restricted browser contexts */ }
  }, [taskFamily, recipeOperation, title, prompt, contextInstruction, contextPreset, promptJson, duration, aspectRatio, variants, seed, renderMode, modelVariant, inferenceSteps, attentionMode, identityEnabled, identityStrength, visualModifierEnabled, visualModifierId, visualModifierStrength, visualModifierTrigger, cameraEnabled, cameraMode, cameraPath, assets, importedWorkflow]);
  useEffect(() => {
    if (!sessionActive) return;
    const timer = window.setInterval(() => void refresh(false), 2_000);
    return () => window.clearInterval(timer);
  }, [sessionActive]);
  useEffect(() => {
    if (!sessionActive) return;
    let icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    const created = !icon;
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      document.head.append(icon);
    }
    const original = icon.getAttribute("href");
    let phase = 0;
    const animate = () => { icon!.href = h3ActivityFavicon(phase++ % 8); };
    animate();
    const timer = window.setInterval(animate, 180);
    return () => {
      window.clearInterval(timer);
      if (created) icon?.remove();
      else if (original) icon?.setAttribute("href", original);
      else icon?.removeAttribute("href");
    };
  }, [sessionActive]);
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = pasteTarget.current;
      if (!target || busy || !event.clipboardData || !clipboardFiles(event.clipboardData).length) return;
      event.preventDefault();
      event.stopPropagation();
      pasteAsset(event.clipboardData, target.slot, target.kind);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [busy, operation]);

  async function refresh(showError = true) {
    try {
      const response = await apiFetch(`${apiBase}/api/h3/queue`, { signal: AbortSignal.timeout(10_000) });
      const result = await response.json() as QueueState & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось прочитать очередь H3.");
      setState(result);
      setConnectionError("");
      setVastForm((current) => ({
        ...current,
        maxHourlyUsd: String(result.vast?.maxHourlyUsd ?? 1.2),
        sshPrivateKeyPath: current.sshPrivateKeyPath || result.vast?.sshPrivateKeyPath || "",
        acceptLicense: current.acceptLicense || result.vast?.licenseAccepted === true
      }));
    } catch (error) {
      setConnectionError("Нет связи с сервером H3. Показан последний полученный статус; ход генерации неизвестен.");
      if (showError) setMessage(errorText(error));
    }
  }

  async function refreshModels(showError = false) {
    try {
      const response = await apiFetch(`${apiBase}/api/h3/models`, { signal: AbortSignal.timeout(10_000) });
      const result = await response.json() as { models?: H3Model[]; modifiers?: H3Modifier[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось прочитать модели H3.");
      setModels(result.models ?? []);
      setModifiers(result.modifiers ?? []);
    } catch (error) {
      if (showError) setMessage(errorText(error));
    }
  }

  async function downloadModel() {
    setBusy(true);
    setMessage("Запускаю возобновляемую загрузку закреплённого checkpoint…");
    try {
      const response = await apiFetch(`${apiBase}/api/h3/models/${modelVariant}/download`, { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось запустить загрузку модели.");
      await refreshModels(false);
      setMessage("Загрузка идёт на H3 worker; прогресс обновляется автоматически.");
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function downloadIdentityModifier() {
    setBusy(true);
    setMessage("Загружаю закреплённый FaceSwap Ref2VA LoRA с проверкой размера и SHA-256…");
    try {
      const response = await apiFetch(`${apiBase}/api/h3/models/faceswap_ref2va/download`, { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось запустить загрузку FaceSwap LoRA.");
      await refreshModels(false);
      setMessage("Загрузка FaceSwap LoRA идёт на worker; повторная загрузка использует Hugging Face cache/resume.");
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  async function downloadVisualModifier() {
    setBusy(true);
    setMessage("Загружаю закреплённый Authentic Cinematic Texture SafeTensor с проверкой размера и SHA-256…");
    try {
      const response = await apiFetch(`${apiBase}/api/h3/models/${visualModifierId}/download`, { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось запустить загрузку visual LoRA.");
      await refreshModels(false);
      setMessage("Загрузка visual LoRA идёт на worker; файл будет активирован только для явно выбранной задачи H3 Base.");
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  async function submitItem() {
    setBusy(true);
    setMessage("");
    setEnqueueError("");
    try {
      const request = buildQueueSubmission({ taskFamily, title, operation, prompt, finalRequest, promptJson, contextInstruction, contextPreset, duration, aspectRatio, variants, seed, renderMode, modelVariant, inferenceSteps, attentionMode, assets, importedWorkflow, identityEnabled, identityStrength, visualModifierEnabled, visualModifierId, visualModifierStrength, visualModifierTrigger, cameraEnabled, cameraMode, cameraPath });
      const response = await apiFetch(`${apiBase}/api/h3/queue${editingId ? `/${editingId}` : ""}`, {
        method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? (editingId ? "Не удалось сохранить изменения." : "Не удалось добавить задачу."));
      const wasEditing = Boolean(editingId);
      resetComposer();
      setMessage(wasEditing ? "Изменения сохранены, задача готова к новому запуску." : operationInfo.executable ? "Задача сохранена локально." : "Задача сохранена, но её backend пока не подключён — при запуске она будет честно помечена как blocked.");
      await refresh(false);
    } catch (error) {
      const reason = errorText(error);
      const visible = reason.startsWith("Cannot add to queue:") ? reason : `Cannot add to queue: ${reason}`;
      console.error("[H3 queue] enqueue failed", error);
      setEnqueueError(visible);
      setMessage(visible);
    }
    finally { setBusy(false); }
  }

  function resetComposer() {
    setTitle(""); setPrompt(""); setContextInstruction(""); setContextPreset("none"); setPromptJson(""); setSeed(""); setAssets([]); setImportedWorkflow(undefined); setIdentityEnabled(false); setIdentityStrength(1); setVisualModifierEnabled(false); setVisualModifierStrength(0.7); setVisualModifierTrigger(false); setCameraEnabled(false); setCameraMode("auto"); setAttentionMode("auto"); setCameraPath(cameraPreset("static")); setEditingId(null);
    setEnqueueError("");
  }

  function insertPromptTag(tag: string) {
    const isContext = activeTextField.current === "context" && taskFamily === "Ref2VA";
    const textarea = isContext ? contextRef.current : promptRef.current;
    const value = isContext ? contextInstruction : prompt;
    const selectionStart = textarea?.selectionStart ?? value.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const insertion = insertAtSelection(value, tag, selectionStart, selectionEnd);
    if (isContext) setContextInstruction(insertion.value);
    else setPrompt(insertion.value);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(insertion.cursor, insertion.cursor);
    });
  }

  function loadItem(item: QueueItem, edit: boolean) {
    if (item.operation === "video_upscale") {
      setUpscaleDraft({ ...item, id: edit ? item.id : undefined });
      document.querySelector(".h3VideoUpscale")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    const savedComposer = item.promptJson?.snarkrouteH3Composer as Partial<ComposerDraft> | undefined;
    setTaskFamily(savedComposer?.taskFamily ?? taskFamilyForOperation(item.operation));
    setRecipeOperation(item.operation === "text_to_video" || item.operation === "first_last_frame" ? "reference_mix" : item.operation);
    setTitle(item.title);
    setPrompt(typeof savedComposer?.prompt === "string" ? savedComposer.prompt : item.prompt);
    setContextInstruction(typeof savedComposer?.contextInstruction === "string" ? savedComposer.contextInstruction : "");
    setContextPreset(isContextPreset(savedComposer?.contextPreset) ? savedComposer.contextPreset : "none");
    const rawJson = item.promptJson ? { ...item.promptJson } : undefined;
    if (rawJson) delete rawJson.snarkrouteH3Composer;
    setPromptJson(rawJson && Object.keys(rawJson).length ? JSON.stringify(rawJson, null, 2) : "");
    setDuration(item.duration);
    setAspectRatio(item.aspectRatio);
    setVariants(item.variants);
    setSeed(item.seed === undefined ? "" : String(item.seed));
    setRenderMode(finalAvailable ? item.renderMode : "preview");
    setModelVariant(item.modelVariant ?? "h3_base");
    setInferenceSteps(item.inferenceSteps ?? (item.modelVariant === "10eros_max" ? 8 : item.modelVariant === "10eros_max_turbo" ? 6 : 4));
    setAttentionMode(item.attentionMode ?? "auto");
    setIdentityEnabled(item.identityTransfer?.enabled === true);
    setIdentityStrength(item.identityTransfer?.strength ?? 1);
    setVisualModifierEnabled(item.visualModifier?.enabled === true);
    setVisualModifierId(item.visualModifier?.id ?? "authentic_cinematic_texture");
    setVisualModifierStrength(item.visualModifier?.strength ?? 0.7);
    setVisualModifierTrigger(item.visualModifier?.includeTrigger === true);
    setCameraEnabled(Boolean(item.cameraPath));
    setCameraMode(item.cameraControlMode ?? "auto");
    setCameraPath(item.cameraPath ?? cameraPreset("static"));
    setAssets(item.assets.map((asset, index) => ({ ...asset, composerId: `queue-${item.id}-${index}` })));
    setImportedWorkflow(savedComposer?.importedWorkflow);
    setEditingId(edit ? item.id : null);
    setMessage(edit ? `Редактируется «${item.title}». Исходники также загружены в форму.` : `Копия «${item.title}» загружена в форму. Оригинал остался в очереди.`);
  }

  async function uploadAsset(file: File, slot: AssetSlot, kind: AssetKind): Promise<ComposerAsset> {
    const dataBase64 = await fileBase64(file);
    const response = await apiFetch(`${apiBase}/api/assets/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, dataBase64, kind })
    });
    const result = await response.json() as { path?: string; metadata?: { mimeType?: string }; error?: string };
    if (!response.ok || !result.path || !result.metadata?.mimeType) throw new Error(result.error ?? "Не удалось сохранить исходник.");
    return { composerId: crypto.randomUUID(), slot, kind, path: result.path, filename: file.name, mimeType: result.metadata.mimeType };
  }

  async function importAsset(file: File, slot: AssetSlot, kind: AssetKind, append = isReferenceSlot(slot)) {
    setBusy(true);
    setMessage(`Сохраняю ${file.name} локально…`);
    try {
      const asset = await uploadAsset(file, slot, kind);
      setAssets((current) => append ? [...current, asset] : [...current.filter((item) => item.slot !== slot), asset]);
      setMessage(`${file.name} сохранён локально и привязан к задаче.`);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  function dropAsset(event: DragEvent<HTMLElement>, slot: AssetSlot, kind: AssetKind) {
    event.preventDefault();
    event.stopPropagation();
    setDragSlot(null);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (!fileMatchesKind(file, kind)) {
      setMessage(`Для слота «${assetSlots[operation].find((item) => item.slot === slot)?.label ?? slot}» нужен файл типа ${kind}.`);
      return;
    }
    void importAsset(file, slot, kind);
  }

  function pasteAsset(data: DataTransfer, slot: AssetSlot, kind: AssetKind) {
    const file = clipboardFiles(data).map((candidate) => ensureClipboardFilename(candidate, kind)).find((candidate) => fileMatchesKind(candidate, kind));
    if (!file) {
      setMessage(`Для слота «${assetSlots[operation].find((item) => item.slot === slot)?.label ?? slot}» в буфере нет файла типа ${kind}.`);
      return;
    }
    void importAsset(file, slot, kind);
  }

  async function importReferenceFiles(fileList: FileList | File[], kind: AssetKind) {
    const files = Array.from(fileList).filter((file) => fileMatchesKind(file, kind));
    if (!files.length) return;
    setBusy(true);
    setMessage(`Сохраняю ${files.length} ${kind} reference…`);
    try {
      const slot = referenceSlotForKind(kind);
      const imported: ComposerAsset[] = [];
      for (const file of files) imported.push(await uploadAsset(file, slot, kind));
      setAssets((current) => [...current, ...imported]);
      setMessage(`Добавлено references: ${imported.length}.`);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  async function prepareImportSet(inputFiles: FileList | File[]) {
    setImportBusy(true);
    setMessage("");
    try {
      const expanded = await expandImportFiles(Array.from(inputFiles));
      const files = new Map<string, File>();
      const descriptors: H3ImportFile[] = [];
      const jsonSources: Array<{ fileName: string; value: unknown }> = [];
      for (const entry of expanded) {
        files.set(entry.key, entry.file);
        descriptors.push({ key: entry.key, name: entry.file.name, relativePath: entry.relativePath, type: entry.file.type, size: entry.file.size });
        if (/\.json$/i.test(entry.file.name)) {
          try { jsonSources.push({ fileName: entry.relativePath || entry.file.name, value: JSON.parse(await entry.file.text()) }); }
          catch { /* invalid JSON remains a non-executable unused source */ }
        }
      }
      const matched = await matchImportReferencesBySha256(analyzeImportSet(descriptors, jsonSources), files);
      const analysis = await detectExactImportDuplicates(matched, files);
      setImportBundle({ analysis, files });
    } catch (error) { setMessage(errorText(error)); }
    finally { setImportBusy(false); }
  }

  async function applyImportSet() {
    if (!importBundle) return;
    setImportBusy(true);
    setMessage("Импортирую выбранные connected references в Base H3 state…");
    try {
      const seedResult = composerSeedFromImported(importBundle.analysis.generation.seed);
      const importedAnalysis = seedResult.warning && !importBundle.analysis.warnings.includes(seedResult.warning)
        ? { ...importBundle.analysis, warnings: [...importBundle.analysis.warnings, seedResult.warning] }
        : importBundle.analysis;
      const nextAssets = await materializeImportReferences(importedAnalysis, importBundle.files, uploadAsset);
      setTaskFamily("Ref2VA");
      setRecipeOperation("reference_mix");
      setAssets((current) => [...current.filter((asset) => !isReferenceSlot(asset.slot)), ...nextAssets]);
      setPrompt(importedAnalysis.prompt ?? prompt);
      setContextInstruction(importedAnalysis.contextInstruction ?? contextInstruction);
      setContextPreset(importedAnalysis.contextInstruction ? "raw" : contextPreset);
      if (importedAnalysis.generation.duration !== undefined) setDuration(importedAnalysis.generation.duration);
      if (importedAnalysis.generation.ratio) setAspectRatio(importedAnalysis.generation.ratio);
      if (importedAnalysis.generation.seed !== undefined) setSeed(seedResult.value);
      setImportedWorkflow(importedAnalysis);
      setImportBundle(null);
      setEnqueueError("");
      setMessage(seedResult.warning ? `Import Set applied. ${seedResult.warning}` : "Import Set applied. Review the editable Base H3 request, resolve Missing Source items, then add it to the queue.");
    } catch (error) { setMessage(errorText(error)); }
    finally { setImportBusy(false); }
  }

  async function mutate(url: string, method: string, body?: unknown) {
    setBusy(true);
    try {
      const response = await apiFetch(`${apiBase}${url}`, {
        method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? "Операция с очередью не выполнена.");
      }
      await refresh(false);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  async function openResult(path: string, mode: "open" | "folder") {
    try {
      const response = await apiFetch(`${apiBase}/api/h3/results/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, mode }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось открыть результат.");
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function cleanResults(empty: boolean) {
    if (empty && !window.confirm("Окончательно удалить все файлы из корзины H3? Это действие нельзя отменить.")) return;
    setBusy(true);
    try {
      const response = await apiFetch(`${apiBase}/api/h3/results/${empty ? "empty-trash" : "trash-orphans"}`, { method: "POST" });
      const result = await response.json() as { error?: string; movedCount?: number; deletedCount?: number };
      if (!response.ok) throw new Error(result.error ?? "Не удалось очистить результаты.");
      setMessage(empty ? `Корзина очищена: удалено папок — ${result.deletedCount}.` : `В корзину перенесено папок от удалённых задач — ${result.movedCount}.`);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  async function cancelGeneration() {
    if (!window.confirm("Остановить текущую генерацию? Следующие задания останутся в очереди.")) return;
    setBusy(true);
    try {
      const response = await apiFetch(`${apiBase}/api/h3/queue/session/cancel`, { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось остановить H3.");
      setMessage("Запрос на остановку передан worker’у.");
      await refresh(false);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function start(mode: "saved_worker" | "vast" | "provider") {
    if (mode === "vast") {
      const ceiling = state?.vast.maxHourlyUsd ?? 1.2;
      const confirmed = window.confirm(`SnarkRoute подберёт Vast-сервер не дороже $${ceiling.toFixed(2)}/ч, выполнит очередь последовательно и затем УНИЧТОЖИТ точный instance. Продолжить аренду?`);
      if (!confirmed) return;
    }
    setBusy(true);
    setMessage(mode === "vast" ? "Ищу сервер. Если безопасного предложения нет, аренда не начнётся." : mode === "provider" ? "Отправляю выбранные задания в hosted H3 Max / Turbo через fal…" : "Подключаю сохранённый worker…");
    try {
      const response = await apiFetch(`${apiBase}/api/h3/queue/session`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode })
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось запустить очередь.");
      setMessage("");
      await refresh(false);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  async function prepareVastTemplate() {
    setBusy(true);
    setMessage("Сохраняю секреты и создаю приватный H3 template в Vast…");
    try {
      const response = await apiFetch(`${apiBase}/api/h3/vast`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...vastForm,
          maxHourlyUsd: Number(vastForm.maxHourlyUsd),
          excludedCountryCodes: ["US", "GB", "KR", "AT", "BE", "BG", "HR", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]
        })
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить Vast-настройки.");
      const templateResponse = await apiFetch(`${apiBase}/api/h3/vast/template`, { method: "POST" });
      const templateResult = await templateResponse.json() as { template?: { hashId?: string }; error?: string };
      if (!templateResponse.ok || !templateResult.template?.hashId) throw new Error(templateResult.error ?? "Vast не вернул hash созданного шаблона.");
      setVastForm((current) => ({ ...current, apiKey: "", hfToken: "" }));
      setMessage(`Приватный H3 template создан и сохранён (${templateResult.template.hashId}). Автоматический запуск готов.`);
      await refresh(false);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  function applyRecipe(recipe: typeof quickRecipes[number]) {
    setTaskFamily(recipe.family);
    setRecipeOperation(recipe.operation);
    setContextPreset(recipe.preset);
    setContextInstruction(recipe.context);
    setMessage(`${recipe.title} prepared the Base H3 composer. Review and edit the native request before adding it to the queue.`);
    window.requestAnimationFrame(() => document.querySelector(".h3ComposerSection")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const referenceAssets = assets.filter((asset) => isReferenceSlot(asset.slot));

  return (<>
    <VideoUpscaleComposer draft={upscaleDraft} onClearDraft={() => setUpscaleDraft(undefined)} onQueued={() => refresh(false)} outputs={queueItems.flatMap(item => item.resultPaths ?? [])} />
    <section className="h3ComposerSection">
      <header className="h3QueueHeader">
        <div><span className="h3Eyebrow">BASE H3</span><h2>Request Composer</h2><p>Choose a native task family, add its native inputs, then send the reviewed request to the existing queue.</p></div>
        {editingId ? <div className="h3EditingBanner"><span><Pencil size={14} /> Editing queue item</span><button type="button" title="Cancel editing" onClick={resetComposer}><X size={14} /></button></div> : null}
      </header>

      <div className="h3TaskFamily" role="tablist" aria-label="H3 task family">
        {(["FL2VA", "Ref2VA"] as const).map((family) => <button type="button" role="tab" aria-selected={taskFamily === family} className={taskFamily === family ? "active" : ""} key={family} onClick={() => { setTaskFamily(family); if (family === "Ref2VA") setRecipeOperation("reference_mix"); }}>{family}<small>{family === "FL2VA" ? "text + optional first / last" : "prompt + multimodal references"}</small></button>)}
      </div>

      <div className="h3ComposerLayout">
        <div className="h3ComposerMain">
          <label><span>Request title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`${taskFamily} request`} /></label>
          <label><span>Prompt</span><textarea ref={promptRef} value={prompt} onFocus={() => { activeTextField.current = "prompt"; }} onChange={(event) => setPrompt(event.target.value)} placeholder="What happens in the scene…" rows={7} /></label>

          {taskFamily === "FL2VA" ? <section className="h3NativeInputs">
            <div className="h3Subheading"><div><strong>Conditioning Frames</strong><span>No frames = text only. Add first, last, or both without changing task family.</span></div></div>
            <div className="h3FrameGrid">{([{"slot":"firstFrame","label":"First Frame"},{"slot":"lastFrame","label":"Last Frame"}] as const).map((definition) => {
              const attached = assets.find((asset) => asset.slot === definition.slot);
              return <div className={`h3AssetButton ${attached ? "hasPreview" : ""} ${dragSlot === definition.slot ? "dropActive" : ""}`} key={definition.slot} onDragOver={(event) => event.preventDefault()} onDragEnter={() => setDragSlot(definition.slot)} onDragLeave={() => setDragSlot(null)} onDrop={(event) => dropAsset(event, definition.slot, "image")}>
                <label>{attached ? <AssetPreview asset={attached} /> : <span className="h3AssetUploadIcon"><Image size={18} /></span>}<span className="h3AssetCaption"><strong>{definition.label}</strong><small>{attached?.filename ?? `+ ${definition.label}`}</small></span><input type="file" accept="image/*" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importAsset(file, definition.slot, "image", false); event.target.value = ""; }} /></label>
                {attached ? <button type="button" title={`Remove ${definition.label}`} onClick={() => setAssets((current) => current.filter((asset) => asset.composerId !== attached.composerId))}><Trash2 size={14} /></button> : null}
              </div>;
            })}</div>
          </section> : <>
            <section className="h3NativeInputs">
              <div className="h3Subheading"><div><strong>References</strong><span>Tags keep stable per-kind order. No semantic role is inferred from filenames.</span></div></div>
              <div className="h3ReferenceToolbar">
                <button type="button" onClick={() => pictureInputRef.current?.click()}><Image size={15} /> + Picture</button>
                <button type="button" onClick={() => videoInputRef.current?.click()}><Video size={15} /> + Video</button>
                <button type="button" onClick={() => audioInputRef.current?.click()}><Music size={15} /> + Audio</button>
                <button className="h3Primary" type="button" disabled={importBusy} onClick={() => importSetInputRef.current?.click()}>{importBusy ? <LoaderCircle className="h3Spin" size={15} /> : <PackageOpen size={15} />} Import Set</button>
                <input ref={pictureInputRef} hidden multiple type="file" accept="image/*" onChange={(event) => { if (event.target.files) void importReferenceFiles(event.target.files, "image"); event.target.value = ""; }} />
                <input ref={videoInputRef} hidden multiple type="file" accept="video/*" onChange={(event) => { if (event.target.files) void importReferenceFiles(event.target.files, "video"); event.target.value = ""; }} />
                <input ref={audioInputRef} hidden multiple type="file" accept="audio/*" onChange={(event) => { if (event.target.files) void importReferenceFiles(event.target.files, "audio"); event.target.value = ""; }} />
                <input ref={importSetInputRef} hidden multiple type="file" accept=".json,.zip,image/*,video/*,audio/*" onChange={(event) => { if (event.target.files) void prepareImportSet(event.target.files); event.target.value = ""; }} />
              </div>
              <div className="h3ImportDrop" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); void filesFromDrop(event.dataTransfer).then((files) => prepareImportSet(files)); }}><Upload size={16} /> Drop multiple files, a folder, ZIP, or workflow JSON here</div>
              <div className="h3ReferenceList">{referenceAssets.length ? referenceAssets.map((asset, index) => {
                const tag = referenceTag(asset, referenceAssets);
                return <article className={`h3ReferenceCard ${asset.missing ? "missing" : ""}`} key={asset.composerId}>
                  {asset.missing ? <span className="h3MissingPreview"><AlertTriangle size={18} /></span> : <AssetPreview asset={asset} />}
                  <div><button className="h3PromptTag" type="button" onClick={() => insertPromptTag(`<${tag}>`)}>&lt;{tag}&gt;</button><strong>{asset.filename}</strong><span>{asset.missing ? "Missing Source" : `${asset.kind} · imported locally`}</span></div>
                  <div className="h3ReferenceActions"><button type="button" disabled={index === 0} title="Move up" onClick={() => setAssets((current) => moveComposerAsset(current, asset.composerId, -1))}><ArrowUp size={13} /></button><button type="button" disabled={index === referenceAssets.length - 1} title="Move down" onClick={() => setAssets((current) => moveComposerAsset(current, asset.composerId, 1))}><ArrowDown size={13} /></button><button type="button" title="Remove" onClick={() => setAssets((current) => current.filter((candidate) => candidate.composerId !== asset.composerId))}><Trash2 size={13} /></button></div>
                  {asset.missing ? <label className="h3ResolveMissing">Browse file<input type="file" accept={`${asset.kind}/*`} onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; void uploadAsset(file, asset.slot, asset.kind).then((replacement) => setAssets((current) => current.map((candidate) => candidate.composerId === asset.composerId ? { ...replacement, composerId: asset.composerId, sourceFilename: asset.sourceFilename, importNodeId: asset.importNodeId } : candidate))).catch((error) => setMessage(errorText(error))); }} /></label> : null}
                </article>;
              }) : <div className="h3ReferenceEmpty">Add pictures, video, or audio. Picture 1 / Video 1 / Audio 1 are assigned only by visible order.</div>}</div>
            </section>

            <section className="h3ContextBlock"><div className="h3Subheading"><div><strong>Context</strong><span>Prompt says what happens. Context says how references should be interpreted.</span></div></div>
              <label><span>Preset</span><select value={contextPreset} onChange={(event) => setContextPreset(event.target.value as ContextPreset)}><option value="none">None</option><option value="raw">Raw / explicit instruction</option><option value="motion">Motion from Video</option><option value="subject">Subject from Picture</option><option value="style">Appearance / Style</option></select></label>
              <label><span>Context Instruction</span><textarea ref={contextRef} value={contextInstruction} onFocus={() => { activeTextField.current = "context"; }} onChange={(event) => setContextInstruction(event.target.value)} placeholder="How should H3 interpret <Picture 1>, <Video 1>, and <Audio 1>?…" rows={6} /></label>
              <button type="button" onClick={() => setShowFinalRequest((value) => !value)}><Eye size={15} /> {showFinalRequest ? "Hide Final Request" : "Show Final Request"}</button>
              {showFinalRequest ? <pre className="h3FinalRequest">{finalRequest}</pre> : null}
            </section>
          </>}

          {importedWorkflow ? <details className="h3ImportedMetadata"><summary>Imported workflow metadata · {importedWorkflow.workflowName}</summary><div><span>Source model</span><strong>{importedWorkflow.model ?? "not specified"}</strong><span>Resolution</span><strong>{importedWorkflow.generation.resolution ?? "not specified"}</strong><span>Context IR</span><strong>{importedWorkflow.contextIr.detected ? importedWorkflow.contextIr.enabled ? "On" : "Off" : "not present"}</strong><span>2K stage</span><strong>{importedWorkflow.stages.regenerate2kDetected ? importedWorkflow.stages.regenerate2kEnabled ? "On" : "Off" : "not present"}</strong></div>{importedWorkflow.warnings.map((warning) => <p key={warning}><AlertTriangle size={13} /> {warning}</p>)}</details> : null}
          <details className="h3RawExpert"><summary>Raw / Expert metadata</summary><label><span>Additional JSON metadata (not a prompt)</span><textarea className="h3JsonPrompt" value={promptJson} onChange={(event) => setPromptJson(event.target.value)} placeholder={'{"project": "metadata"}'} rows={5} /></label></details>
        </div>

        <aside className="h3ComposerSettings">
          <section><div className="h3Subheading"><div><strong>Model / Profile</strong><span>Independent from task family.</span></div></div><label><span>Model</span><select value={modelVariant} onChange={(event) => { const value = event.target.value as ModelVariant; const model = models.find((item) => item.id === value); setModelVariant(value); setRenderMode(value === "10eros_max" || value === "h3_max" ? "final" : "preview"); setInferenceSteps(model?.default_steps ?? (value === "10eros_max" ? 8 : value === "10eros_max_turbo" ? 6 : 4)); if (isHostedModel(value)) { setVariants(1); setIdentityEnabled(false); setAttentionMode("auto"); } if (value !== "h3_base") setVisualModifierEnabled(false); if (value === "h3_max_turbo") setCameraEnabled(false); }}>{(models.length ? models : fallbackModels()).map((model) => <option value={model.id} key={model.id} disabled={model.selectable === false}>{model.display_name}{model.recommended_for_16gb ? " · 16 GB" : ""}{model.hosted ? model.weights_installed ? " · ready" : " · key required" : model.weights_installed ? " · ready" : " · not downloaded"}</option>)}</select></label><label><span>Profile</span><select value={renderMode} onChange={(event) => setRenderMode(event.target.value as "preview" | "final")}><option value="preview">Preview</option><option value="final" disabled={!finalAvailable && modelVariant !== "h3_max"}>{finalAvailable || modelVariant === "h3_max" ? "Final" : "Final · unavailable"}</option></select></label>{modelVariant === "h3_max" ? <p>Hosted · fal · 768P · ≈ ${(duration * composerHostedRate).toFixed(2)} USD output. Semantic reference tokens can add cost. First/last frame and image/video/audio references are verified; local FaceSwap is unavailable.</p> : modelVariant === "h3_max_turbo" ? <p>Hosted · fal · 768P · ≈ ${(duration * composerHostedRate).toFixed(2)} USD output. T2V and first/last-frame I2V are available; semantic references, FaceSwap, and CameraPath controls are unavailable.</p> : <p>Local · saved worker or managed Vast. H3 Base keeps its existing FL2VA/Ref2VA path.</p>}{(() => { const model = models.find((item) => item.id === modelVariant); if (!model || model.hosted || model.weights_installed || modelVariant === "h3_base") return null; return <button type="button" disabled={busy || model.downloading} onClick={() => void downloadModel()}>{model.downloading ? <LoaderCircle className="h3Spin" size={15} /> : <Cloud size={15} />} {model.downloading ? `Download ${Math.round((model.progress ?? 0) * 100)}%` : `Download ${model.display_name}`}</button>; })()}</section>
          <section><div className="h3Subheading"><div><strong>Generation Settings</strong><span>Only parameters used by the current queue/runtime.</span></div></div><div className="h3SettingsGrid"><label><span>Duration</span><input type="number" min={isHostedModel(modelVariant) ? 5 : 4} max={15} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></label><label><span>Ratio</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option><option>3:4</option><option>21:9</option><option>auto</option><option>adaptive</option></select></label><label><span>Output count</span><input type="number" min={1} max={isHostedModel(modelVariant) ? 1 : 10} value={variants} onChange={(event) => setVariants(Number(event.target.value))} /></label><label><span>Attention</span><select disabled={isHostedModel(modelVariant)} value={isHostedModel(modelVariant) ? "auto" : attentionMode} onChange={(event) => setAttentionMode(event.target.value as AttentionMode)}><option value="auto">Auto · Veda with fallback</option><option value="veda">Veda · strict</option><option value="dense">Dense · off</option></select></label></div><details className="h3AdvancedSettings"><summary>Advanced</summary>{!isHostedModel(modelVariant) ? <label><span>Steps</span><input type="number" min={models.find((model) => model.id === modelVariant)?.minimum_steps ?? 4} max={models.find((model) => model.id === modelVariant)?.maximum_steps ?? 8} value={inferenceSteps} onChange={(event) => setInferenceSteps(Number(event.target.value))} /></label> : null}<label><span>Seed · empty = auto</span><div className="h3SeedField"><input type="number" min={0} max={2147483647} value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="Auto" /><button type="button" title="New random seed" onClick={() => setSeed(String(randomSeed()))}><Dices size={15} /></button></div></label></details></section>
<section><div className="h3Subheading"><div><strong>Optional Modifiers</strong><span>Capability-aware controls, not task families.</span></div></div>{!isHostedModel(modelVariant) ? <><label><span>Identity Transfer / FaceSwap</span><select disabled={taskFamily !== "Ref2VA" || visualModifierEnabled} value={identityEnabled ? "on" : "off"} onChange={(event) => setIdentityEnabled(event.target.value === "on")}><option value="off">Off</option><option value="on">On · H3 Base Ref2VA</option></select></label>{identityEnabled ? <label><span>Identity strength</span><input type="number" min={0} max={2} step={0.05} value={identityStrength} onChange={(event) => setIdentityStrength(Number(event.target.value))} /></label> : null}{identityEnabled && !modifiers.find((item) => item.id === "faceswap_ref2va")?.weights_installed ? <button type="button" disabled={busy || modifiers.find((item) => item.id === "faceswap_ref2va")?.downloading} onClick={() => void downloadIdentityModifier()}><Cloud size={15} /> {modifiers.find((item) => item.id === "faceswap_ref2va")?.downloading ? `FaceSwap ${Math.round((modifiers.find((item) => item.id === "faceswap_ref2va")?.progress ?? 0) * 100)}%` : "Download FaceSwap Ref2VA LoRA"}</button> : null}<VisualModifierControls modifiers={modifiers} id={visualModifierId} enabled={visualModifierEnabled} strength={visualModifierStrength} includeTrigger={visualModifierTrigger} disabled={modelVariant !== "h3_base" || identityEnabled} busy={busy} onId={setVisualModifierId} onEnabled={setVisualModifierEnabled} onStrength={setVisualModifierStrength} onTrigger={setVisualModifierTrigger} onDownload={() => void downloadVisualModifier()} /></> : <p>Hosted profiles do not load local LoRA modifiers.</p>}
            {modelVariant !== "h3_max_turbo" ? <details className="h3CameraControl" open={cameraEnabled}><summary>Camera Control · CameraPath 1.0</summary><label><span>Enabled</span><select value={cameraEnabled ? "on" : "off"} onChange={(event) => setCameraEnabled(event.target.value === "on")}><option value="off">Off</option><option value="on">On</option></select></label><label><span>Mode</span><select disabled={!cameraEnabled} value={cameraMode} onChange={(event) => setCameraMode(event.target.value as typeof cameraMode)}><option value="auto">Auto</option><option value="native">Native · hosted H3 Max only</option><option value="prompt">Prompt fallback</option></select></label><label><span>Preset</span><select disabled={!cameraEnabled} defaultValue="static" onChange={(event) => setCameraPath(cameraPreset(event.target.value))}><option value="static">Static</option><option value="orbitLeft">Orbit left</option><option value="orbitRight">Orbit right</option><option value="orbit360">360 orbit</option><option value="rise">Rise</option><option value="fall">Fall</option><option value="dollyIn">Dolly in</option><option value="dollyOut">Dolly out</option></select></label><p>Local H3 uses the existing prompt fallback. Native orbit remains hosted H3 Max only.</p></details> : null}
          </section>
          <p className={`h3OperationNote ${operationInfo.executable ? "" : "blocked"}`}>{operationInfo.executable ? <Check size={14} /> : <AlertTriangle size={14} />}{operationNote(operationInfo.note, insertPromptTag)}</p>
          {enqueueError ? <p className="h3SubmitError" role="alert"><AlertTriangle size={14} /> {enqueueError}</p> : null}
          <button className="h3Primary h3AddQueue" type="button" disabled={busy} onClick={() => void submitItem()}>{editingId ? <Pencil size={16} /> : <ListPlus size={16} />} {editingId ? "Save Changes" : "Add to Queue"}</button>
        </aside>
      </div>
      {message && !connectionError ? <p className="h3QueueMessage">{message}</p> : null}
    </section>

    <section className="h3ToolsSection h3RecipesSection"><header><div><h2>Quick Recipes</h2><p>Shortcuts that prepare an editable Base H3 request. They never start generation.</p></div></header><div className="h3RecipeGrid">{quickRecipes.map((recipe) => <button type="button" key={recipe.title} onClick={() => applyRecipe(recipe)}><span>{recipe.badge}</span><strong>{recipe.title}</strong><small>{recipe.context}</small></button>)}</div></section>
    <section className="h3ToolsSection h3ProductionSection"><header><div><h2>Production Workflow</h2><p>Guided stages below the native composer; each stage still resolves to the same H3 request/queue pipeline.</p></div></header><div className="h3ToolGrid">{productionStages.map((stage) => <article className="h3ToolCard available" key={stage.title}><div className="h3ToolCardStatus"><Check size={15} /> guidance</div><h3>{stage.title}</h3><p>{stage.note}</p><footer><span>{stage.model}</span><code>h3</code></footer></article>)}</div></section>

    <section className="h3QueueSection">
      <header className="h3QueueHeader"><div><h2>Queue</h2><p>Pending and completed jobs. Rendering controls remain backed by the existing local queue.</p></div><span className="h3QueueCount">{queueItems.length} jobs · selected {runnableCount}</span></header>
      <div className="h3QueueTrashActions"><button type="button" disabled={busy || sessionActive} onClick={() => void cleanResults(false)}>Collect outputs from removed jobs</button><button type="button" disabled={busy || sessionActive} onClick={() => void cleanResults(true)}><Trash2 size={14} /> Empty trash</button></div>
      <div className="h3QueueList">{!queueItems.length ? <div className="h3QueueEmpty"><ListPlus size={30} /><strong>Queue is empty</strong><span>{archivedItems.length ? "Older jobs are in the archive below." : "Sources and jobs stay on this computer."}</span></div> : queueItems.map((item, index) => <QueueCard key={item.id} item={item} index={index} count={queueItems.length} busy={busy || sessionActive} onLoad={() => loadItem(item, false)} onEdit={() => loadItem(item, true)} onMutate={mutate} onOpenResult={openResult} onToggleSelected={(selected) => mutate(`/api/h3/queue/${item.id}/selection`, "POST", { selected })} onArchive={() => mutate(`/api/h3/queue/${item.id}/archive`, "POST")} />)}</div>

      {connectionError ? <p className="h3QueueMessage" role="alert">{connectionError}</p> : null}
      <div className={`h3SessionBar ${state?.session.status === "cleanup_failed" ? "danger" : ""}`}>
        <SessionSummary session={state?.session} />
        <div className="h3SessionActions">
          {state?.session.status === "cleanup_failed" ? <button className="h3Danger" type="button" disabled={busy} onClick={() => void mutate("/api/h3/queue/session/cleanup", "POST")}><AlertTriangle size={15} /> Повторить уничтожение #{state.session.managedInstanceId}</button> : null}
          {state?.session.currentItemId && ["rendering", "cancelling"].includes(state.session.status) ? <button className="h3Danger" type="button" disabled={busy || state.session.status === "cancelling"} onClick={() => void cancelGeneration()}><Square size={14} fill="currentColor" /> {state.session.status === "cancelling" ? "Останавливаю…" : "Остановить генерацию"}</button> : null}
          <button type="button" disabled={busy || sessionActive || runnableCount === 0} onClick={() => void start("saved_worker")}><Play size={15} /> {selectedRunnable.every(item => item.operation === "video_upscale") ? "Run Video Upscale · Local GPU" : "Рендер выбранных на H3"}</button>
          <button type="button" disabled={busy || sessionActive || !providerOnlySelection} onClick={() => void start("provider")}><Cloud size={15} /> Рендер H3 Hosted · ≈ ${selectedHostedEstimate.toFixed(2)}</button>
          <button className="h3ManagedRun" type="button" disabled={busy || sessionActive || runnableCount === 0 || selectedRunnable.some(item => item.operation === "video_upscale") || !state?.vast.configured} onClick={() => void start("vast")}><Cloud size={15} /> Арендовать → выбранные → уничтожить</button>
        </div>
      </div>

      {archivedItems.length ? <section className="h3QueueArchive">
        <button className="h3ArchiveToggle" type="button" onClick={() => setArchiveOpen((value) => !value)}>{archiveOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />} Архив · {archivedItems.length}</button>
        {archiveOpen ? <div className="h3ArchiveList">{archivedItems.map((item) => <article className="h3ArchiveItem" key={item.id}>
          <div><strong>{item.title}</strong><span>{operations.find((operation) => operation.value === item.operation)?.label ?? item.operation} · {statusLabel(item.status)}</span></div>
          <div><button type="button" disabled={busy || sessionActive} title="Вернуть в очередь" onClick={() => void mutate(`/api/h3/queue/${item.id}/restore`, "POST")}><ArchiveRestore size={14} /> Вернуть</button><button type="button" disabled={busy || sessionActive} title="Удалить задачу, результаты — в корзину" onClick={() => void mutate(`/api/h3/queue/${item.id}`, "DELETE")}><Trash2 size={14} /></button></div>
        </article>)}</div> : null}
      </section> : null}

      <button className={`h3AdvancedToggle ${vastOpen ? "open" : ""}`} type="button" onClick={() => setVastOpen((value) => !value)}><Settings2 size={15} /> Автоматическая аренда Vast <span>{state?.vast.configured ? "настроена" : "не настроена"}</span></button>
      {vastOpen ? <div className="h3VastConfig">
        <p>SnarkRoute сам создаст приватный Vast template, запустит worker и откроет локальный SSH-туннель. Терминал, Jupyter и внешний публичный H3-порт не понадобятся. Секреты сохраняются только локальным API и обратно не показываются.</p>
        <p><strong>Закреплено:</strong> {state?.vast.image || "образ загружается…"} · source {state?.vast.sourceRevision?.slice(0, 12) || "…"}</p>
        <div className="h3VastConfigGrid">
          <SecretInput label={`Vast API key${state?.vast.apiKeyConfigured ? " · сохранён" : ""}`} value={vastForm.apiKey} onChange={(value) => setVastForm((current) => ({ ...current, apiKey: value }))} />
          <SecretInput label={`HF token${state?.vast.hfTokenConfigured ? " · сохранён" : ""}`} value={vastForm.hfToken} onChange={(value) => setVastForm((current) => ({ ...current, hfToken: value }))} />
          <label><span>SSH private key{state?.vast.sshKeyConfigured ? " · найден" : ""}</span><input value={vastForm.sshPrivateKeyPath} onChange={(event) => setVastForm((current) => ({ ...current, sshPrivateKeyPath: event.target.value }))} placeholder="Обычно определяется из ~/.ssh/id_ed25519" /></label>
          <label><span>Предел $/час</span><input type="number" min="0.01" max="20" step="0.01" value={vastForm.maxHourlyUsd} onChange={(event) => setVastForm((current) => ({ ...current, maxHourlyUsd: event.target.value }))} /></label>
        </div>
        <label className="h3LicenseAccept"><input type="checkbox" checked={vastForm.acceptLicense} onChange={(event) => setVastForm((current) => ({ ...current, acceptLicense: event.target.checked }))} /><span>Я ознакомился и принимаю лицензию закреплённой модели MiniMax H3.</span></label>
        <button type="button" disabled={busy || !vastForm.acceptLicense} onClick={() => void prepareVastTemplate()}><Settings2 size={15} /> {state?.vast.templateHashConfigured ? "Пересоздать приватный H3 template" : "Подготовить автоматический запуск"}</button>
        {!state?.vast.sshKeyConfigured ? <p className="h3OperationNote blocked"><AlertTriangle size={14} /> Не найден локальный SSH-ключ, добавленный в аккаунт Vast. Укажи путь к private key.</p> : null}
      </div> : null}
    </section>
    {importBundle ? <ImportSetPreview bundle={importBundle} busy={importBusy} onChange={setImportBundle} onCancel={() => setImportBundle(null)} onApply={() => void applyImportSet()} /> : null}
  </>);
}

type ImportPickerState = { mode: "source"; targetId: string } | { mode: "target"; candidateId: string } | { mode: "video-one"; currentId?: string };
type ImportConflictState = { targetId: string; candidateId: string; assignedTargetId: string };

export function VisualModifierControls({ modifiers, id, enabled, strength, includeTrigger, disabled, busy, onId, onEnabled, onStrength, onTrigger, onDownload }: {
  modifiers: H3Modifier[]; id: VisualModifierId; enabled: boolean; strength: number; includeTrigger: boolean; disabled: boolean; busy: boolean;
  onId: (id: VisualModifierId) => void; onEnabled: (value: boolean) => void; onStrength: (value: number) => void; onTrigger: (value: boolean) => void; onDownload: () => void;
}) {
  const options = modifiers.filter((item) => item.category === "visual");
  const selected = options.find((item) => item.id === id);
  return <>
    <label><span>Visual Modifier</span><select disabled={disabled || !options.length} value={enabled ? id : "off"} onChange={(event) => {
      const value = event.target.value;
      onEnabled(value !== "off");
      if (value !== "off") {
        onId(value as VisualModifierId);
        const modifier = options.find((item) => item.id === value);
        onStrength(modifier?.default_strength ?? 1);
        onTrigger(false);
      }
    }}><option value="off">Off</option>{options.map((item) => <option key={item.id} value={item.id}>{item.title ?? item.id} · {item.capability_status ?? "experimental"}</option>)}</select></label>
    {enabled && selected ? <>
      <label><span>Modifier strength</span><input type="number" min={0} max={2} step={0.05} value={strength} onChange={(event) => onStrength(Number(event.target.value))} /></label>
      {selected.default_strength !== undefined ? <button type="button" onClick={() => onStrength(selected.default_strength!)}>Default · {selected.default_strength}</button> : null}
      {selected.motion_strength !== undefined ? <button type="button" onClick={() => onStrength(selected.motion_strength!)}>Motion · {selected.motion_strength}</button> : null}
      {selected.trigger ? <label><span>Include trigger: {selected.trigger}</span><select value={includeTrigger ? "on" : "off"} onChange={(event) => onTrigger(event.target.value === "on")}><option value="off">Off · default</option><option value="on">On · controlled A/B</option></select></label> : null}
      <p>{selected.notes}</p>
      {!selected.weights_installed ? <button type="button" disabled={busy || selected.downloading} onClick={onDownload}><Cloud size={15} />{selected.downloading ? `Download ${Math.round((selected.progress ?? 0) * 100)}%` : `Download ${selected.title ?? selected.id}`}</button> : null}
      {selected.error ? <p>{selected.error}</p> : null}
    </> : null}
  </>;
}

function ImportSetPreview({ bundle, busy, onChange, onCancel, onApply }: { bundle: ImportBundle; busy: boolean; onChange: Dispatch<SetStateAction<ImportBundle | null>>; onCancel: () => void; onApply: () => void }) {
  const { analysis } = bundle;
  const previewUrls = useImportPreviewUrls(bundle.files);
  const [picker, setPicker] = useState<ImportPickerState | null>(null);
  const [conflict, setConflict] = useState<ImportConflictState | null>(null);
  const videoCandidates = videoOneImportCandidates(analysis);
  const assigned = analysis.references.filter((reference) => importReferenceUiGroup(reference) === "slot");
  const orphaned = analysis.references.filter((reference) => importReferenceUiGroup(reference) === "orphan");
  const updateAnalysis = (next: (current: H3ImportAnalysis) => H3ImportAnalysis) => onChange((current) => current ? { ...current, analysis: next(current.analysis) } : null);
  const fileFor = (reference: H3ImportedReference) => reference.matchedFileKey ? bundle.files.get(reference.matchedFileKey) : undefined;
  const browseForTarget = (target: H3ImportedReference, file?: File) => {
    if (!file) return;
    const key = `manual:${target.id}:${file.name}:${file.size}:${file.lastModified}`;
    onChange((current) => {
      if (!current) return null;
      const files = new Map(current.files);
      files.set(key, file);
      return { files, analysis: attachImportFileToReference(current.analysis, target.id, { key, name: file.name, type: file.type, size: file.size }) };
    });
  };
  const chooseSource = (targetId: string, candidateId: string) => {
    const assignedTarget = importAssignmentConflict(analysis, targetId, candidateId);
    if (assignedTarget) {
      setConflict({ targetId, candidateId, assignedTargetId: assignedTarget.id });
      return;
    }
    updateAnalysis((current) => changeImportReferenceSource(current, targetId, candidateId));
    setPicker(null);
  };

  return <div className="h3ImportOverlay" role="dialog" aria-modal="true" aria-label="Import Set preview"><section className="h3ImportPreview">
    <header><div><span className="h3Eyebrow">IMPORT SET</span><h2>{analysis.workflowName}</h2><p>{analysis.sourceType.replaceAll("_", " ")}</p></div><button type="button" title="Cancel import" onClick={onCancel}><X size={16} /></button></header>
    <div className="h3ImportSummary"><span>Model</span><strong>{analysis.model ?? "Not specified"}</strong><span>Generation</span><strong>{[analysis.generation.resolution, analysis.generation.ratio, analysis.generation.duration !== undefined ? `${analysis.generation.duration} sec` : undefined, analysis.generation.seed !== undefined ? `seed ${analysis.generation.seed}` : undefined].filter(Boolean).join(" · ") || "Not specified"}</strong><span>Prompt</span><strong>{analysis.prompt ? "Found (preserved without rewriting)" : "Not found"}</strong><span>Context IR</span><strong>{analysis.contextIr.detected ? analysis.contextIr.enabled ? "On" : "Off" : "Not present"}</strong><span>2K Regenerate</span><strong>{analysis.stages.regenerate2kDetected ? analysis.stages.regenerate2kEnabled ? "On" : "Off" : "Not present"}</strong></div>
    {analysis.prompt || analysis.contextInstruction ? <details className="h3ImportedText"><summary>Imported Prompt / Context <span>Show full text</span></summary>{analysis.prompt ? <><strong>Prompt</strong><HighlightedImportText text={analysis.prompt} /></> : null}{analysis.contextInstruction ? <><strong>Context Instruction</strong><HighlightedImportText text={analysis.contextInstruction} /></> : null}</details> : null}
    {videoCandidates.length ? <div className="h3ImportSuggestion"><div><AlertTriangle size={15} /><span><strong>Prompt references &lt;Video 1&gt;</strong><small>The workflow graph has no connected video. Assignment is never automatic.</small></span></div><button type="button" onClick={() => setPicker({ mode: "video-one" })}>Choose Video 1 source…</button></div> : null}

    <div className="h3ImportReferences"><h3>Reference slots</h3><div className="h3ImportCardGrid">{assigned.map((reference) => {
      const isSlot = reference.connected;
      const label = isSlot ? importReferenceLabel(reference, analysis.references) : reference.manualRole ?? `New ${reference.kind} reference`;
      const contexts = importReferenceContext(analysis, label);
      const file = fileFor(reference);
      const currentSource = file?.name ?? reference.resolvedSourceName ?? (!reference.missing ? reference.sourceName : undefined);
      return <article key={reference.id} className={`h3ImportAssetCard ${reference.missing ? "missing" : "resolved"}`}>
        <div className="h3ImportCardHeader"><strong>{label}</strong><span>{reference.missing ? "MISSING SOURCE" : reference.resolvedSourceName || reference.manualRole ? "RESOLVED MANUALLY" : "RESOLVED"}</span></div>
        <ImportMediaPreview file={file} url={reference.matchedFileKey ? previewUrls.get(reference.matchedFileKey) : undefined} kind={reference.kind} name={currentSource ?? reference.sourceName} />
        <div className="h3ImportCardDetails">{contexts.length ? <div className="h3ImportContext"><b>Context</b>{contexts.map((snippet) => <blockquote key={snippet}>{snippet}</blockquote>)}</div> : <small className="h3ImportNoContext">No imported text mentions &lt;{label}&gt;.</small>}{isSlot ? <><small>Expected source</small><code>{reference.sourceName}</code></> : null}<small>Current source</small><strong>{currentSource ?? "Missing"}</strong></div>
        <div className="h3ImportSlotActions">{isSlot ? reference.missing ? <><button type="button" disabled={!importSourcePickerCandidates(analysis, reference.id).length} onClick={() => setPicker({ mode: "source", targetId: reference.id })}>Choose imported file</button><label>Browse file<input type="file" accept={`${reference.kind}/*`} onChange={(event) => { browseForTarget(reference, event.target.files?.[0]); event.target.value = ""; }} /></label></> : <><button type="button" disabled={!importSourcePickerCandidates(analysis, reference.id).length} onClick={() => setPicker({ mode: "source", targetId: reference.id })}>Change source</button><button type="button" onClick={() => updateAnalysis((current) => unassignImportReference(current, reference.id))}>Unassign</button></> : reference.manualRole ? <><button type="button" disabled={!videoOneSourceCandidates(analysis, reference.id).length} onClick={() => setPicker({ mode: "video-one", currentId: reference.id })}>Change source</button><button type="button" onClick={() => updateAnalysis((current) => unassignImportManualRole(current, reference.id))}>Unassign</button></> : <button type="button" onClick={() => onChange((current) => updateImportDisposition(current, reference.id, "unused"))}>Remove from references</button>}</div>
      </article>;
    })}</div></div>

    {orphaned.length ? <div className="h3ImportReferences"><h3>Unused imported assets</h3><div className="h3ImportCardGrid">{orphaned.map((reference) => {
      const file = fileFor(reference);
      const targets = compatibleImportTargets(analysis, reference.id);
      return <article key={reference.id} className={`h3ImportAssetCard orphan ${reference.disposition}`}>
        <div className="h3ImportCardHeader"><strong>{reference.sourceName}</strong><span>{reference.disposition === "ignored" ? "IGNORED" : "UNUSED"}</span></div>
        <ImportMediaPreview file={file} url={reference.matchedFileKey ? previewUrls.get(reference.matchedFileKey) : undefined} kind={reference.kind} name={reference.sourceName} />
        <div className="h3ImportCardDetails"><small>Graph</small><strong>Not connected</strong><small>Status</small><strong>{reference.disposition === "ignored" ? "Ignored" : "Unused"}</strong></div>
        <div className="h3ImportSlotActions">{reference.disposition === "unused" ? <><button type="button" disabled={!targets.length} onClick={() => setPicker({ mode: "target", candidateId: reference.id })}>Resolve as…</button><button type="button" onClick={() => updateAnalysis((current) => addImportAssetAsReference(current, reference.id))}>Add as new reference</button><button type="button" onClick={() => onChange((current) => updateImportDisposition(current, reference.id, "ignored"))}>Ignore</button></> : <button type="button" onClick={() => onChange((current) => updateImportDisposition(current, reference.id, "unused"))}>Restore as unused</button>}</div>
      </article>;
    })}</div></div> : null}

    {picker ? <section className="h3VisualPicker" aria-label="Import asset visual picker"><header><div><span className="h3Eyebrow">VISUAL PICKER</span><h3>{picker.mode === "source" ? `Choose source for ${importReferenceLabel(analysis.references.find((reference) => reference.id === picker.targetId)!, analysis.references)}` : picker.mode === "target" ? `Resolve ${analysis.references.find((reference) => reference.id === picker.candidateId)?.sourceName ?? "asset"} as` : "Choose source for Video 1"}</h3></div><button type="button" onClick={() => { setPicker(null); setConflict(null); }}><X size={15} /></button></header>
      {picker.mode === "source" ? <div className="h3VisualPickerGrid">{importSourcePickerCandidates(analysis, picker.targetId).map((candidate) => <button type="button" className="h3VisualCandidate" key={candidate.id} onClick={() => chooseSource(picker.targetId, candidate.id)}><ImportMediaPreview file={fileFor(candidate)} url={candidate.matchedFileKey ? previewUrls.get(candidate.matchedFileKey) : undefined} kind={candidate.kind} name={candidate.sourceName} /><strong>{candidate.sourceName}</strong>{candidate.resolvedByReferenceId ? <small>Assigned to {importReferenceLabel(analysis.references.find((reference) => reference.id === candidate.resolvedByReferenceId)!, analysis.references)}</small> : <small>Available</small>}</button>)}</div> : null}
      {picker.mode === "target" ? <div className="h3VisualTargetList">{compatibleImportTargets(analysis, picker.candidateId).map((target) => { const label = importReferenceLabel(target, analysis.references); return <button type="button" key={target.id} onClick={() => { updateAnalysis((current) => resolveImportReference(current, target.id, picker.candidateId)); setPicker(null); }}><strong>{label}</strong>{importReferenceContext(analysis, label).map((snippet) => <small key={snippet}>{snippet}</small>)}</button>; })}</div> : null}
      {picker.mode === "video-one" ? <div className="h3VisualPickerGrid">{(picker.currentId ? videoOneSourceCandidates(analysis, picker.currentId) : videoCandidates).map((candidate) => <button type="button" className="h3VisualCandidate" key={candidate.id} onClick={() => { updateAnalysis((current) => picker.currentId ? changeImportManualRoleSource(current, picker.currentId!, candidate.id) : useImportAssetAsVideoOne(current, candidate.id)); setPicker(null); }}><ImportMediaPreview file={fileFor(candidate)} url={candidate.matchedFileKey ? previewUrls.get(candidate.matchedFileKey) : undefined} kind="video" name={candidate.sourceName} /><strong>{candidate.sourceName}</strong></button>)}</div> : null}
      {conflict ? <div className="h3ImportConflict"><AlertTriangle size={16} /><div><strong>This file is currently assigned to {importReferenceLabel(analysis.references.find((reference) => reference.id === conflict.assignedTargetId)!, analysis.references)}.</strong><span>The same source will not be copied into two slots.</span></div><button type="button" onClick={() => { updateAnalysis((current) => swapImportReferenceSources(current, conflict.targetId, conflict.assignedTargetId)); setConflict(null); setPicker(null); }}>Swap {importReferenceLabel(analysis.references.find((reference) => reference.id === conflict.targetId)!, analysis.references)} ↔ {importReferenceLabel(analysis.references.find((reference) => reference.id === conflict.assignedTargetId)!, analysis.references)}</button><button type="button" onClick={() => setConflict(null)}>Cancel</button></div> : null}
    </section> : null}
    {analysis.warnings.length ? <div className="h3ImportWarnings"><h3>Warnings</h3>{analysis.warnings.map((warning) => <p key={warning}><AlertTriangle size={14} /> {warning}</p>)}</div> : null}
    <footer><button type="button" onClick={onCancel}>Cancel</button><button className="h3Primary" type="button" disabled={busy} onClick={onApply}>{busy ? <LoaderCircle className="h3Spin" size={15} /> : <PackageOpen size={15} />} Import into Base H3</button></footer>
  </section></div>;
}

function HighlightedImportText({ text }: { text: string }) {
  const parts = text.split(/(<(?:Picture|Video|Audio)\s+\d+>)/gi);
  return <pre>{parts.map((part, index) => /^<(?:Picture|Video|Audio)\s+\d+>$/i.test(part) ? <mark key={`${part}-${index}`}>{part}</mark> : part)}</pre>;
}

export function ImportMediaPreview({ file, url, kind, name }: { file?: File; url?: string; kind: H3ImportMediaKind; name: string }) {
  const [duration, setDuration] = useState<number | undefined>();
  useEffect(() => setDuration(undefined), [url]);
  if (!file || !url) return <div className={`h3ImportMediaPreview empty ${kind}`}>{kind === "image" ? <Image size={24} /> : kind === "video" ? <Video size={24} /> : <Music size={24} />}<small>{kind === "image" ? "No image source" : kind === "video" ? "No video source" : "No audio source"}</small></div>;
  if (kind === "image") return <div className="h3ImportMediaPreview image"><img src={url} alt={`Preview of ${name}`} /><small>{name}</small></div>;
  if (kind === "video") return <div className="h3ImportMediaPreview video"><video src={url} controls muted playsInline preload="metadata" onLoadedMetadata={(event) => { const media = event.currentTarget; if (Number.isFinite(media.duration)) setDuration(media.duration); if (media.duration > 0) media.currentTime = Math.min(0.05, media.duration / 2); }} /><small>{name}{duration !== undefined ? ` · ${formatMediaDuration(duration)}` : ""}</small></div>;
  return <div className="h3ImportMediaPreview audio"><Music size={22} /><small>{name}{duration !== undefined ? ` · ${formatMediaDuration(duration)}` : ""}</small><audio src={url} controls preload="metadata" onLoadedMetadata={(event) => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }} /></div>;
}

function useImportPreviewUrls(files: Map<string, File>): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
    const next = new Map<string, string>();
    for (const [key, file] of files) if (mediaKindForImportFile({ name: file.name, type: file.type })) next.set(key, URL.createObjectURL(file));
    setUrls(next);
    return () => revokeImportPreviewUrls(next.values());
  }, [files]);
  return urls;
}

export function revokeImportPreviewUrls(urls: Iterable<string>, revoke: (url: string) => void = (url) => URL.revokeObjectURL(url)): void {
  for (const url of urls) revoke(url);
}

export function formatMediaDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, "0")}`;
}

export function QueueCard({ item, index, count, busy, onLoad, onEdit, onMutate, onOpenResult, onToggleSelected, onArchive }: { item: QueueItem; index: number; count: number; busy: boolean; onLoad: () => void; onEdit: () => void; onMutate: (url: string, method: string, body?: unknown) => Promise<void>; onOpenResult: (path: string, mode: "open" | "folder") => Promise<void>; onToggleSelected: (selected: boolean) => Promise<void>; onArchive: () => Promise<void> }) {
  const label = operations.find((operation) => operation.value === item.operation)?.label ?? item.operation;
  const selected = item.selectedForRun !== false;
  return <article className={`h3QueueCard ${item.status} ${selected ? "" : "skipped"}`}>
    <div className="h3QueueCardTop"><div><label className="h3QueueSelection" title="Включить задание в следующий запуск"><input type="checkbox" checked={selected} disabled={busy || item.status === "running" || item.status === "succeeded"} onChange={(event) => void onToggleSelected(event.target.checked)} /><span>{selected ? "рендерить" : "пропустить"}</span></label><span>{index + 1}. {label}</span><strong>{item.title}</strong></div><div className="h3QueueCardButtons"><button title="Во ввод как копию" onClick={onLoad}><CopyPlus size={14} /></button><button disabled={busy || item.status === "running"} title="Редактировать" onClick={onEdit}><Pencil size={14} /></button><button disabled={busy || index === 0} title="Выше" onClick={() => void onMutate(`/api/h3/queue/${item.id}/move`, "POST", { direction: "up" })}><ArrowUp size={14} /></button><button disabled={busy || index === count - 1} title="Ниже" onClick={() => void onMutate(`/api/h3/queue/${item.id}/move`, "POST", { direction: "down" })}><ArrowDown size={14} /></button><button disabled={busy} title="В архив" onClick={() => void onArchive()}><Archive size={14} /></button><button disabled={busy} title="Удалить задачу, результаты — в корзину" onClick={() => void onMutate(`/api/h3/queue/${item.id}`, "DELETE")}><Trash2 size={14} /></button></div></div>
    <p>{item.prompt}</p>
    <div className="h3QueueMeta">{item.operation === "video_upscale" ? <><span>{String(item.videoUpscale?.model)}</span><span>Native {String(item.videoUpscale?.scale)}×</span><span>{item.videoUpscale?.delivery ? `Delivery ${(item.videoUpscale.delivery as number[]).join("×")}` : "Native output"}</span><span>{item.resultMetadata?.latencyMs?.total ? `${(item.resultMetadata.latencyMs.total/1000).toFixed(1)} с` : "Local GPU"}</span>{item.assets.map(asset => <span key={asset.path}>{asset.filename}</span>)}</> : <><span>{item.duration} с</span><span>{item.aspectRatio}</span><span>{item.variants} вар.</span><span>{item.modelVariant ?? "h3_base"}</span><span>{item.renderMode}</span>{!isHostedModel(item.modelVariant) ? <><span>{item.inferenceSteps ?? "авто"} steps</span><span>attn {item.attentionMode ?? "auto"}</span></> : null}<span>seed {item.seed ?? "—"}</span>{item.resultMetadata ? <><span>{item.resultMetadata.provider} · {item.resultMetadata.model}</span>{typeof item.resultMetadata.provenance?.attention_backend === "string" ? <span>used {String(item.resultMetadata.provenance.attention_backend)}</span> : null}{item.resultMetadata.estimatedCostUsd !== undefined && item.resultMetadata.estimatedCostUsd !== null ? <span>≈ ${item.resultMetadata.estimatedCostUsd.toFixed(2)}</span> : null}{item.resultMetadata.latencyMs?.total ? <span>{(item.resultMetadata.latencyMs.total / 1000).toFixed(1)} с end-to-end</span> : null}</> : null}{item.assets.map((asset, assetIndex) => <span key={`${asset.slot}-${asset.path}-${assetIndex}`}>{asset.filename}</span>)}</>}</div>
    <div className="h3QueueProgress"><span style={{ width: `${Math.round(item.progress * 100)}%` }} /></div>
    {item.operation === "video_upscale" && item.status === "running" && item.startedAt ? <p>{Math.round((Date.now()-Date.parse(item.startedAt))/1000)} с · {item.stage}</p> : null}
    {item.operation === "video_upscale" && item.resultMetadata?.provenance ? <details><summary>Result metadata · provenance / color / worker lifecycle</summary><pre className="h3FinalRequest">{JSON.stringify(item.resultMetadata.provenance,null,2)}</pre></details> : null}
    {item.resultPaths?.length ? <div className="h3QueueResults">{item.resultPaths.map((path, resultIndex) => {
      const src = `${apiBase}/api/assets/preview?kind=video&path=${encodeURIComponent(path)}`;
      return <div className="h3QueueResult" key={path}>
        <video src={src} controls playsInline preload="metadata" />
        <div className="h3QueueResultActions">
          <button type="button" onClick={() => void onOpenResult(path, "open")}><ExternalLink size={13} /> Открыть видео {resultIndex + 1}</button>
          <button type="button" onClick={() => void onOpenResult(path, "folder")}><FolderOpen size={13} /> Показать в папке</button>
        </div>
      </div>;
    })}</div> : null}
    <footer><strong>{statusLabel(item.status)}{item.stage ? ` · ${item.stage}` : ""}</strong>{item.error ? <span>{item.error}</span> : null}</footer>
  </article>;
}

function SessionSummary({ session }: { session?: QueueSession }) {
  if (!session || session.status === "idle") return <div><strong>Пакетный запуск</strong><span>Задачи выполняются строго по одной.</span></div>;
  return <div><strong>Сессия: {sessionLabel(session.status)}</strong><span>{session.managedInstanceId ? `Vast instance #${session.managedInstanceId}` : session.mode === "provider" ? "Hosted provider · fal" : session.mode === "saved_worker" ? "Сохранённый worker не удаляется" : "Instance ещё не создан"}{session.hourlyPriceUsd ? ` · $${session.hourlyPriceUsd.toFixed(3)}/ч` : ""}{session.cleanupConfirmed === true && session.mode === "vast" ? " · удаление подтверждено" : ""}</span>{session.error ? <span>{session.error}</span> : null}</div>;
}

function SecretInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label><span>{label}</span><input type="password" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Оставь пустым, чтобы не менять" /></label>; }
function AssetPreview({ asset }: { asset: QueueAsset }) {
  const src = `${apiBase}/api/assets/preview?kind=${asset.kind}&path=${encodeURIComponent(asset.path)}`;
  if (asset.kind === "image") return <img className="h3AssetPreview" src={src} alt="" />;
  if (asset.kind === "video") return <video className="h3AssetPreview" src={src} muted playsInline preload="metadata" />;
  return <audio className="h3AssetAudioPreview" src={src} controls preload="metadata" onClick={(event) => event.stopPropagation()} />;
}
export function insertAtSelection(value: string, tag: string, selectionStart: number, selectionEnd: number) {
  const start = Math.max(0, Math.min(value.length, selectionStart));
  const end = Math.max(start, Math.min(value.length, selectionEnd));
  return { value: `${value.slice(0, start)}${tag}${value.slice(end)}`, cursor: start + tag.length };
}

export function isPersistentQueueSource(path: string | undefined): boolean {
  const value = path?.trim() ?? "";
  return Boolean(value) && !/^(?:blob:|data:|https?:|file:)/i.test(value);
}

export function composerSeedFromImported(seed: number | undefined): { value: string; warning?: string } {
  if (seed === undefined) return { value: "" };
  if (Number.isInteger(seed) && seed >= 0 && seed <= 2_147_483_647) return { value: String(seed) };
  return { value: "", warning: `Imported seed ${seed} is outside the H3 runtime range 0–2147483647 and was kept only in workflow metadata.` };
}

export function queueSubmissionError(input: Pick<QueueSubmissionInput, "taskFamily" | "operation" | "modelVariant" | "variants" | "identityEnabled" | "visualModifierEnabled" | "cameraEnabled" | "finalRequest" | "assets" | "seed">): string | null {
  if (!input.finalRequest.trim()) return "Cannot add to queue: Prompt is empty.";
  if (isHostedModel(input.modelVariant) && input.variants !== 1) return "Cannot add to queue: hosted H3 profiles produce one output per job.";
  if (isHostedModel(input.modelVariant) && input.identityEnabled) return "Cannot add to queue: hosted H3 profiles cannot load the local FaceSwap LoRA.";
  if (input.visualModifierEnabled && input.modelVariant !== "h3_base") return "Cannot add to queue: Authentic Cinematic Texture requires H3 Base.";
  if (input.visualModifierEnabled && input.identityEnabled) return "Cannot add to queue: Authentic Cinematic Texture and FaceSwap cannot be combined until controlled-tested.";
  if (input.modelVariant === "h3_max_turbo" && !["text_to_video", "first_last_frame"].includes(input.operation)) return "Cannot add to queue: H3 Max Turbo supports only T2V and first/last-frame I2V; semantic references are unavailable.";
  if (input.modelVariant === "h3_max_turbo" && input.cameraEnabled) return "Cannot add to queue: CameraPath is unavailable for H3 Max Turbo.";
  const unresolved = input.assets.find((asset) => asset.missing);
  if (unresolved) return `Cannot add to queue: ${unresolved.filename} source is unresolved.`;
  const unavailable = input.assets.find((asset) => !isPersistentQueueSource(asset.path));
  if (unavailable) return `Cannot add to queue: Imported ${unavailable.filename} has not been uploaded to asset storage.`;
  if (input.taskFamily === "Ref2VA" && !input.assets.some((asset) => isReferenceSlot(asset.slot))) return "Cannot add to queue: Ref2VA requires at least one persistent image, video, or audio reference.";
  const references = input.assets.filter((asset) => isReferenceSlot(asset.slot));
  const counts = { image: references.filter((asset) => asset.kind === "image").length, video: references.filter((asset) => asset.kind === "video").length, audio: references.filter((asset) => asset.kind === "audio").length };
  if (references.length > 12 || counts.image > 9 || counts.video > 3 || counts.audio > 3) return "Cannot add to queue: Ref2VA supports up to 9 images, 3 videos, 3 audio clips, and 12 references total.";
  if (input.seed.trim()) {
    const seed = Number(input.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) return "Cannot add to queue: seed must be an integer between 0 and 2147483647.";
  }
  return null;
}

export function buildQueueSubmission(input: QueueSubmissionInput) {
  const validationError = queueSubmissionError(input);
  if (validationError) throw new Error(validationError);
  const parsedJson = input.promptJson.trim() ? JSON.parse(input.promptJson) as Record<string, unknown> : {};
  const composerMetadata = {
    schemaVersion: 1,
    taskFamily: input.taskFamily,
    prompt: input.prompt,
    contextInstruction: input.contextInstruction,
    contextPreset: input.contextPreset,
    ...(input.importedWorkflow ? { importedWorkflow: input.importedWorkflow } : {}),
  };
  return {
    title: input.title.trim() || `${input.taskFamily} request`,
    operation: input.operation,
    prompt: input.finalRequest,
    promptJson: { ...parsedJson, snarkrouteH3Composer: composerMetadata },
    duration: input.duration,
    aspectRatio: input.aspectRatio,
    variants: input.variants,
    renderMode: input.renderMode,
    modelVariant: input.modelVariant,
    inferenceSteps: input.inferenceSteps,
    attentionMode: input.attentionMode ?? "auto",
    assets: input.assets.map(({ composerId: _composerId, missing: _missing, sourceFilename: _sourceFilename, importNodeId: _importNodeId, ...asset }) => asset),
    ...(input.identityEnabled ? { identityTransfer: { enabled: true as const, strength: input.identityStrength } } : {}),
    visualModifier: input.visualModifierEnabled ? { id: input.visualModifierId ?? "authentic_cinematic_texture", enabled: true as const, strength: input.visualModifierStrength, includeTrigger: input.visualModifierTrigger } : null,
    ...(input.cameraEnabled && input.cameraPath ? { cameraPath: input.cameraPath, cameraControlMode: input.cameraMode } : {}),
    ...(input.seed.trim() ? { seed: Number(input.seed) } : {}),
  };
}

export async function materializeImportReferences(
  analysis: H3ImportAnalysis,
  files: Map<string, File>,
  upload: (file: File, slot: AssetSlot, kind: AssetKind) => Promise<ComposerAsset>,
): Promise<ComposerAsset[]> {
  const assets: ComposerAsset[] = [];
  for (const reference of analysis.references.filter((item) => item.disposition === "active")) {
    const file = reference.matchedFileKey ? files.get(reference.matchedFileKey) : undefined;
    if (!file) {
      assets.push({ composerId: reference.id, slot: referenceSlotForKind(reference.kind), kind: reference.kind, path: "", filename: reference.sourceName, mimeType: `${reference.kind}/missing`, missing: true, sourceFilename: reference.sourceName, importNodeId: reference.nodeId });
      continue;
    }
    const asset = await upload(file, referenceSlotForKind(reference.kind), reference.kind);
    assets.push({ ...asset, composerId: reference.id, sourceFilename: reference.sourceName, importNodeId: reference.nodeId });
  }
  return assets;
}

function defaultComposerDraft(): ComposerDraft {
  return {
    version: 1, taskFamily: "FL2VA", recipeOperation: "reference_mix", title: "", prompt: "", contextInstruction: "", contextPreset: "none", promptJson: "",
    duration: 5, aspectRatio: "16:9", variants: 1, seed: "", renderMode: "preview", modelVariant: "10eros_max_turbo", inferenceSteps: 6, attentionMode: "auto",
    identityEnabled: false, identityStrength: 1, visualModifierEnabled: false, visualModifierStrength: 0.7, visualModifierTrigger: false, cameraEnabled: false, cameraMode: "auto", cameraPath: cameraPreset("static"), assets: [],
  };
}

function loadComposerDraft(): ComposerDraft {
  const fallback = defaultComposerDraft();
  try {
    const raw = window.localStorage.getItem(COMPOSER_DRAFT_KEY);
    return raw ? normalizeComposerDraft(JSON.parse(raw)) : fallback;
  } catch { return fallback; }
}

export function normalizeComposerDraft(input: unknown): ComposerDraft {
  const fallback: ComposerDraft = {
    version: 1, taskFamily: "FL2VA", recipeOperation: "reference_mix", title: "", prompt: "", contextInstruction: "", contextPreset: "none", promptJson: "",
    duration: 5, aspectRatio: "16:9", variants: 1, seed: "", renderMode: "preview", modelVariant: "10eros_max_turbo", inferenceSteps: 6, attentionMode: "auto",
    identityEnabled: false, identityStrength: 1, visualModifierEnabled: false, visualModifierStrength: 0.7, visualModifierTrigger: false, cameraEnabled: false, cameraMode: "auto", cameraPath: cameraPreset("static"), assets: [],
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) return fallback;
  const value = input as Partial<ComposerDraft>;
  if (value.version !== 1) return fallback;
  return {
    ...fallback,
    ...value,
    taskFamily: value.taskFamily === "Ref2VA" ? "Ref2VA" : "FL2VA",
    recipeOperation: operations.some((operation) => operation.value === value.recipeOperation) ? value.recipeOperation! : "reference_mix",
    contextPreset: isContextPreset(value.contextPreset) ? value.contextPreset : "none",
    assets: Array.isArray(value.assets) ? value.assets.filter((asset): asset is ComposerAsset => Boolean(asset?.composerId && asset?.slot && asset?.kind)).map((asset) => isPersistentQueueSource(asset.path) ? asset : { ...asset, path: "", missing: true }) : [],
    attentionMode: value.attentionMode === "veda" || value.attentionMode === "dense" ? value.attentionMode : "auto",
    cameraPath: value.cameraPath?.schemaVersion === "1.0" ? value.cameraPath : cameraPreset("static"),
  };
}

export function composeFinalRequest(taskFamily: TaskFamily, prompt: string, preset: ContextPreset, contextInstruction: string): string {
  const cleanPrompt = prompt.trim();
  if (taskFamily === "FL2VA") return cleanPrompt;
  const presetText: Record<ContextPreset, string> = {
    none: "",
    raw: "",
    motion: "Use the referenced video for motion, timing, framing, and camera movement only.",
    subject: "Use the referenced pictures to preserve the explicitly named subjects and their appearance.",
    style: "Use the referenced picture for appearance/style while preserving motion and scene continuity from the referenced video.",
  };
  const context = contextInstruction.trim() || presetText[preset];
  return context ? `${context}\n\n${cleanPrompt}`.trim() : cleanPrompt;
}

export function taskFamilyForOperation(operation: Operation): TaskFamily {
  return operation === "text_to_video" || operation === "first_last_frame" ? "FL2VA" : "Ref2VA";
}

function isContextPreset(value: unknown): value is ContextPreset { return value === "none" || value === "raw" || value === "motion" || value === "subject" || value === "style"; }
function isReferenceSlot(slot: AssetSlot): boolean { return slot === "referenceImage" || slot === "identityImage" || slot === "referenceVideo" || slot === "referenceAudio"; }
function referenceSlotForKind(kind: AssetKind): AssetSlot { return kind === "image" ? "referenceImage" : kind === "video" ? "referenceVideo" : "referenceAudio"; }

export function operationForComposer(taskFamily: TaskFamily, assets: ComposerAsset[], recipeOperation: Operation): Operation {
  if (taskFamily === "Ref2VA") return recipeOperation;
  return assets.some((asset) => asset.slot === "firstFrame" || asset.slot === "lastFrame") ? "first_last_frame" : "text_to_video";
}

export function referenceTag(asset: ComposerAsset, references: ComposerAsset[]): string {
  const sameKind = references.filter((candidate) => candidate.kind === asset.kind);
  const index = Math.max(0, sameKind.findIndex((candidate) => candidate.composerId === asset.composerId)) + 1;
  return `${asset.kind === "image" ? "Picture" : asset.kind === "video" ? "Video" : "Audio"} ${index}`;
}

export function moveComposerAsset(assets: ComposerAsset[], id: string, direction: -1 | 1): ComposerAsset[] {
  const index = assets.findIndex((asset) => asset.composerId === id);
  if (index < 0) return assets;
  let swapIndex = index + direction;
  while (swapIndex >= 0 && swapIndex < assets.length && !isReferenceSlot(assets[swapIndex]!.slot)) swapIndex += direction;
  if (swapIndex < 0 || swapIndex >= assets.length) return assets;
  const next = [...assets];
  [next[index], next[swapIndex]] = [next[swapIndex]!, next[index]!];
  return next;
}

function updateImportDisposition(bundle: ImportBundle | null, referenceId: string, disposition: "active" | "unused" | "ignored"): ImportBundle | null {
  if (!bundle) return null;
  return { ...bundle, analysis: { ...bundle.analysis, references: bundle.analysis.references.map((reference) => reference.id === referenceId ? { ...reference, disposition, ...(disposition === "active" ? {} : { manualRole: undefined }) } : reference) } };
}

async function matchImportReferencesBySha256(analysis: H3ImportAnalysis, files: Map<string, File>): Promise<H3ImportAnalysis> {
  const hashCache = new Map<string, string>();
  const references = await Promise.all(analysis.references.map(async (reference) => {
    if (reference.matchedFileKey) return reference;
    const expectedHash = reference.sourceName.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "");
    if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) return reference;
    for (const [key, file] of files) {
      if (mediaKindForImportFile({ name: file.name, type: file.type }) !== reference.kind) continue;
      let hash = hashCache.get(key);
      if (!hash) {
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        hashCache.set(key, hash);
      }
      if (hash.toLowerCase() === expectedHash.toLowerCase()) return { ...reference, matchedFileKey: key, missing: false };
    }
    return reference;
  }));
  const boundWorkflowKeys = new Set(references.filter((reference) => reference.nodeId && reference.matchedFileKey).map((reference) => reference.matchedFileKey));
  const deduplicated = references.filter((reference) => reference.nodeId || !reference.matchedFileKey || !boundWorkflowKeys.has(reference.matchedFileKey));
  const resolvedNames = new Set(deduplicated.filter((reference) => reference.matchedFileKey).map((reference) => reference.sourceName));
  return { ...analysis, references: deduplicated, warnings: analysis.warnings.filter((warning) => !Array.from(resolvedNames).some((name) => warning.includes(name) && /missing/i.test(warning))) };
}

async function detectExactImportDuplicates(analysis: H3ImportAnalysis, files: Map<string, File>): Promise<H3ImportAnalysis> {
  const media = Array.from(files.entries()).filter(([, file]) => mediaKindForImportFile({ name: file.name, type: file.type }));
  const bySize = new Map<number, Array<[string, File]>>();
  for (const entry of media) bySize.set(entry[1].size, [...(bySize.get(entry[1].size) ?? []), entry]);
  const fingerprints = [];
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    for (const [key, file] of group) fingerprints.push({ key, name: file.name, size: file.size, sha256: await sha256ForFile(file) });
  }
  return addExactDuplicateWarnings(analysis, fingerprints);
}

async function sha256ForFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expandImportFiles(files: File[]): Promise<Array<{ key: string; file: File; relativePath?: string }>> {
  const expanded: Array<{ key: string; file: File; relativePath?: string }> = [];
  for (const file of files) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (!/\.zip$/i.test(file.name)) {
      expanded.push({ key: `file:${relativePath}:${file.size}:${file.lastModified}`, file, relativePath });
      continue;
    }
    const zip = await JSZip.loadAsync(file);
    for (const path of Object.keys(zip.files)) {
      const entry = zip.files[path]!;
      if (entry.dir) continue;
      const blob = await entry.async("blob");
      const name = path.split("/").pop() || path;
      const extracted = new File([blob], name, { type: mimeTypeForName(name), lastModified: file.lastModified });
      expanded.push({ key: `zip:${file.name}:${path}`, file: extracted, relativePath: path });
    }
  }
  return expanded;
}

async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(dataTransfer.items).map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => Boolean(entry));
  if (!entries.length) return Array.from(dataTransfer.files);
  const files = (await Promise.all(entries.map((entry) => readDroppedEntry(entry)))).flat();
  return files.length ? files : Array.from(dataTransfer.files);
}

async function readDroppedEntry(entry: FileSystemEntry, prefix = ""): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    const relativePath = `${prefix}${file.name}`;
    return [new File([file], file.name, { type: file.type, lastModified: file.lastModified }) as File & { webkitRelativePath?: string }].map((candidate) => {
      Object.defineProperty(candidate, "webkitRelativePath", { value: relativePath, configurable: true });
      return candidate;
    });
  }
  const directory = entry as FileSystemDirectoryEntry;
  const reader = directory.createReader();
  const children: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map((child) => readDroppedEntry(child, `${prefix}${entry.name}/`)))).flat();
}

function mimeTypeForName(name: string): string {
  const kind = mediaKindForImportFile({ name });
  const extension = name.split(".").pop()?.toLowerCase();
  if (kind === "image") return extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
  if (kind === "video") return extension === "webm" ? "video/webm" : "video/mp4";
  if (kind === "audio") return extension === "wav" ? "audio/wav" : extension === "flac" ? "audio/flac" : "audio/mpeg";
  if (extension === "json") return "application/json";
  return "application/octet-stream";
}

function fallbackModels(): H3Model[] {
  return [
    { id: "h3_base", display_name: "MiniMax H3 (legacy)", purpose: "preview", default_steps: 4, minimum_steps: 4, maximum_steps: 4, weights_installed: true },
    { id: "10eros_max", display_name: "H3 · 10Eros Max", purpose: "final", default_steps: 8, minimum_steps: 4, maximum_steps: 8, weights_installed: false },
    { id: "10eros_max_turbo", display_name: "H3 · 10Eros Max Turbo", purpose: "preview", default_steps: 6, minimum_steps: 4, maximum_steps: 8, weights_installed: false, recommended_for_16gb: true },
    { id: "h3_max", display_name: "H3 Max · Hosted (fal)", purpose: "final", default_steps: 0, minimum_steps: 0, maximum_steps: 0, weights_installed: false, hosted: true, selectable: false },
    { id: "h3_max_turbo", display_name: "H3 Max Turbo · Hosted · experimental", purpose: "preview", default_steps: 0, minimum_steps: 0, maximum_steps: 0, weights_installed: false, hosted: true, selectable: false, experimental: true },
  ];
}
function isHostedModel(value: ModelVariant): value is "h3_max" | "h3_max_turbo" { return value === "h3_max" || value === "h3_max_turbo"; }
function operationNote(note: string, onTagClick: (tag: string) => void) {
  return note.split(/(<(?:Video|Picture|Audio)\s+\d+>)/g).map((part, index) => {
    if (!/^<(?:Video|Picture|Audio)\s+\d+>$/.test(part)) return part;
    return <button className="h3PromptTag" type="button" key={`${part}-${index}`} title={`Вставить ${part} в промпт`} onClick={() => onTagClick(part)}>{part}</button>;
  });
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function statusLabel(status: ItemStatus): string { return ({ ready: "готово к запуску", running: "рендеринг", succeeded: "готово", failed: "ошибка", blocked: "Blocked · см. diagnostics", cancelled: "остановлено" })[status]; }
function sessionLabel(status: SessionStatus): string { return ({ idle: "ожидание", connecting: "подключение", rendering: "рендеринг", cancelling: "остановка", cleaning: "уничтожение сервера", completed: "завершено", completed_with_errors: "завершено с ошибками", cancelled: "остановлено", failed: "ошибка запуска", cleanup_failed: "УНИЧТОЖЕНИЕ НЕ ПОДТВЕРЖДЕНО" })[status]; }
function h3ActivityFavicon(phase: number): string {
  const angle = phase * Math.PI / 4;
  const x = 32 + Math.cos(angle) * 21;
  const y = 32 + Math.sin(angle) * 21;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0d1016"/><text x="8" y="43" font-family="Arial,sans-serif" font-size="30" font-weight="800" fill="#f0a84a">H3</text><circle cx="32" cy="32" r="25" fill="none" stroke="#394454" stroke-width="4"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="#70e1ad"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
function fileBase64(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result ?? "").split(",")[1] ?? ""); reader.onerror = () => reject(reader.error ?? new Error("File read failed.")); reader.readAsDataURL(file); }); }
function randomSeed(): number { const value = new Uint32Array(1); crypto.getRandomValues(value); return (value[0] ?? 0) % 2_147_483_648; }
function cameraPreset(name: string): CameraPath {
  const path = (start: CameraKeyframe, end?: CameraKeyframe, loopClosure: "auto" | "off" = "off"): CameraPath => ({ schemaVersion: "1.0", keyframes: end ? [start, end] : [start], interpolation: end ? "smooth" : "linear", loopClosure, startHold: 0, endHold: 0, subjectBox: { x: 0, y: 0, width: 1, height: 1 } });
  if (name === "orbitLeft") return path({ time: 0, azimuth: 25, elevation: 0, distance: 1 }, { time: 1, azimuth: -25, elevation: 0, distance: 1 });
  if (name === "orbitRight") return path({ time: 0, azimuth: -25, elevation: 0, distance: 1 }, { time: 1, azimuth: 25, elevation: 0, distance: 1 });
  if (name === "orbit360") return path({ time: 0, azimuth: 0, elevation: 0, distance: 1 }, { time: 1, azimuth: 360, elevation: 0, distance: 1 }, "auto");
  if (name === "rise") return path({ time: 0, azimuth: 0, elevation: -12, distance: 1 }, { time: 1, azimuth: 0, elevation: 20, distance: 1 });
  if (name === "fall") return path({ time: 0, azimuth: 0, elevation: 20, distance: 1 }, { time: 1, azimuth: 0, elevation: -12, distance: 1 });
  if (name === "dollyIn") return path({ time: 0, azimuth: 0, elevation: 0, distance: 1.3 }, { time: 1, azimuth: 0, elevation: 0, distance: 0.72 });
  if (name === "dollyOut") return path({ time: 0, azimuth: 0, elevation: 0, distance: 0.72 }, { time: 1, azimuth: 0, elevation: 0, distance: 1.3 });
  return path({ time: 0, azimuth: 0, elevation: 0, distance: 1 });
}
function clipboardFiles(data: DataTransfer): File[] {
  const files = [...Array.from(data.files)];
  for (const item of Array.from(data.items)) {
    const file = item.kind === "file" ? item.getAsFile() : null;
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}
function ensureClipboardFilename(file: File, kind: AssetKind): File {
  if (/\.[a-z0-9]{2,5}$/i.test(file.name)) return file;
  const extensionByMime: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/flac": "flac", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/aac": "aac"
  };
  const extension = extensionByMime[file.type] ?? (!file.type ? ({ image: "png", video: "mp4", audio: "wav" } as const)[kind] : "");
  if (!extension) return file;
  const mimeType = file.type || ({ image: "image/png", video: "video/mp4", audio: "audio/wav" } as const)[kind];
  return new File([file], `clipboard-${Date.now()}.${extension}`, { type: mimeType, lastModified: file.lastModified || Date.now() });
}
function fileMatchesKind(file: File, kind: AssetKind): boolean {
  if (file.type.startsWith(`${kind}/`)) return true;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (kind === "image") return ["png", "jpg", "jpeg", "webp"].includes(extension);
  if (kind === "video") return ["mp4", "mov", "m4v", "webm", "mkv"].includes(extension);
  return ["wav", "mp3", "flac", "ogg", "m4a", "aac"].includes(extension);
}
