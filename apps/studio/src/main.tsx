import "@xyflow/react/dist/style.css";
import "./styles.css";
import defaultRouteDocument from "./default-route.orp.json";
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnConnectEnd,
  type OnConnectStart,
  type ReactFlowInstance
} from "@xyflow/react";
import {
  DEFAULT_AGENT_PRESETS,
  DEFAULT_MODEL_PROFILES,
  buildDialogueWorkbenchOutputs,
  createDialogueWorkbenchState,
  loadRouteFromText,
  normalizeDialogueWorkbenchState,
  normalizeRouteExportFilename,
  exportRouteToText,
  type AgentPreset,
  type DialogueContentPart,
  type DialogueMessage,
  type DialogueOutputStatus,
  type DialogueOutputType,
  type DialogueSelectedOutput,
  type DialogueWorkbenchState,
  type ModelProfile,
  type OpenRoute
} from "@snarkroute/protocol";
import { Aperture, ArrowDown, ArrowUp, BookOpen, Braces, Bug, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock3, Cpu, Download, Eraser, Eye, FileJson, FileText, Film, FolderOpen, Github, Globe, ImageIcon, KeyRound, Lock, MessageSquareText, PanelLeftClose, PanelRightClose, Pin, Play, Plus, Power, RefreshCw, Save, Search, Sparkles, Trash2, Type, Upload, Video, Wand2, X } from "lucide-react";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  NODE_PACKAGE_INSTALL_PATH,
  NODE_PACKAGE_PREVIEW_PATH,
  canImportNodePackageFilename,
  canUninstallNodePackage,
  nodePackageIsUsedInRoute,
  readNodePackageFilePayload,
  uninstallNodeConfirmationMessage
} from "./nodePackageImport";
import { geminiTokenStatusText, localApiUnavailableMessage, replicateTokenStatusText } from "./security-ui";
import { studioDocs, type StudioDocEntry } from "./docsRegistry";
import { MarkdownDocument } from "./MarkdownDocument";
import { fetchImageCatalogModels, fetchModelsForNode } from "./modelCatalogClient";
import { modelLogoFor } from "./modelLogos";
import { AdminDashboard, AdminLoginPage, LoginPage } from "./features/admin/AdminRoutes";
import { CreditHistoryPanel, CreditTransactionMiniList, EconomicsPanel } from "./features/billing/EconomicsPanel";
import { GenericManifestParams, NodeSliderParam } from "./features/node-params/ParamRows";
import { numericParam, restorePendingTextSelection, updateTextFieldPreservingCaret } from "./features/node-params/paramHelpers";
import { apiFetch } from "./shared/apiClient";
import { navigate } from "./shared/navigation";
import {
  canImportDroppedRouteFile,
  chooseCompoundPorts,
  compoundMappingTargets,
  layoutBatchPosition,
  mergeCompoundInputMappings,
  routeImportFilename,
  routeNodeParamsCollapsed,
  routeToEditableSubrouteFlow,
  routeToFlow,
  subrouteInterfaceFlow,
  subrouteInterfaceKind,
  uniqueCompoundMappings,
  uniqueCompoundMappingsByKey,
  uniqueFlowId,
  withRouteNodeParamsCollapsed,
  isSubrouteInterfaceId
} from "./features/route-io/routeFlow";
import {
  creditPriceExplanation,
  creditTransactionDetails,
  creditTransactionLine,
  formatCredits,
  formatDateTime,
  formatMicrousd,
  formatRunCostActual,
  formatRunCostEstimate,
  formatSignedCredits,
  normalizeCreditTransaction,
  sumNumbers,
  userFacingCostActuals,
  userFacingCostEstimates,
  userFacingErrorMessage
} from "./shared/costFormatting";
import {
  clamp,
  degreesToRadians,
  formatSliderValue,
  imageLabel,
  imageLocalPath,
  imageOutputIdForResult,
  imagePreviewSrc,
  isUnsetOrManifestDefaultResizeDimension,
  lastImageValue,
  liveFisheyeOutput,
  localImagePreviewSrc,
  panoramaSnapshotFilename,
  panoramaSourceSrc,
  radiansToDegrees,
  renderFisheyeFrame,
  renderPanoramaFrame,
  roundCameraCoordinate,
  useImageDimensions,
  versionedAssetPreviewSrc,
  videoPreviewSrc,
  wrapDegrees
} from "./shared/mediaPreview";
import {
  connectionRouteHelper,
  enrichImageGenerationModelOptions,
  enrichPolzaImageModelOptions,
  geminiLlmPricingLabel,
  imageGenerationModelOptions,
  imageModelCostLabel,
  imageModelOptionLabel,
  imageModelOptionLogo,
  imageModelOptionsFromNodeOptions,
  imageRoutePreview,
  imageAspectRatioOptions,
  imageSizeOptionsForModel,
  llmModelOptionLabel,
  modelOptionForNodeLabel,
  modelOptionForNodeLogo,
  modelSupportsText,
  openRouterCostLabel,
  openRouterModelSupportsVisionInput,
  polzaImageModelLogo,
  polzaModelHint,
  polzaProviderModelId,
  polzaModelsFromNodeOptions,
  polzaModelSupportsVisionInput,
  polzaVideoSupportsAudio,
  providerFromSlug,
  supportedOptionValue,
  videoModelHint,
  videoModelOptionKey,
  videoModelOptionsFromNodeOptions,
  modalityOutputModalities
} from "./features/model-catalog/modelOptionUtils";
import { ModelCapabilityBadges, ModelLogoMark, ModelSelectWithLogo } from "./features/model-catalog/ModelViews";
import {
  availableCanvasThemes,
  loadCanvasBackgroundTheme,
  saveCanvasBackgroundTheme,
  type CanvasBackgroundTheme
} from "./canvasBackground";
import {
  DEFAULT_APP_CAPABILITIES,
  DEFAULT_PROMPT_LIBRARY,
  DEFAULT_ROUTE_FILENAME,
  GEMINI_API_KEY_URL,
  GEMINI_IMAGE_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_LLM_MODEL_OPTIONS,
  LIBRARY_NODE_METADATA_STORAGE_KEY,
  NODE_DRAG_MIME,
  NODE_LIBRARY_LAYOUT_STORAGE_KEY,
  OPENAI_IMAGE_ASPECT_RATIOS,
  OPENAI_IMAGE_QUALITIES,
  POLZA_IMAGE_ASPECT_RATIOS,
  POLZA_IMAGE_FORMATS,
  POLZA_IMAGE_QUALITIES,
  POLZA_IMAGE_RESOLUTIONS,
  POLZA_VIDEO_DURATIONS,
  POLZA_VIDEO_RESOLUTIONS,
  ROUTE_FILE_ACCEPT,
  SAVED_PROJECT_STORAGE_KEY,
  STUDIO_FAVICON_HREF,
  SUBROUTE_INPUT_NODE_ID,
  SUBROUTE_OUTPUT_NODE_ID,
  apiBase,
  isProductionBuild,
  libraryNodeStatuses,
  promptStatusOptions
} from "./studioConfig";
import type {
  AdminOverview,
  AppCapabilities,
  AssetKind,
  CompoundInterface,
  CompoundPortMapping,
  ConnectionNodeEntry,
  ConnectionNodeMenuState,
  ContextMenuState,
  CostEstimate,
  CreditTransaction,
  CurrentUser,
  DialogueConnectedInput,
  DialogueDraftContentPart,
  ExampleCategory,
  FixNodeOutputOptions,
  ImageModelOption,
  ImageViewerState,
  LedgerSummary,
  LibraryItemMenuState,
  LibraryNodeMetadata,
  LibraryNodeStatus,
  LibrarySectionMenuState,
  LibrarySortMode,
  LibraryStatusFilter,
  ModelQuotePreview,
  ModelOptionForNodeV1,
  NodeCatalogItem,
  NodeLibraryLayout,
  NodeLibraryPreview,
  NodeManifest,
  NodeRunResult,
  OpenRouterModel,
  OpenRouterSettings,
  PendingConnectionStart,
  PendingTextSelection,
  PolzaModel,
  PortKind,
  PortSpec,
  PromptAssetDraft,
  PromptAssetMenuState,
  PromptLibraryData,
  PromptLibraryMenuState,
  PromptLibraryPrompt,
  PromptStatusFilter,
  ProviderLinks,
  RouteDoc,
  RunCostSummary,
  RunDisplayResult,
  RunStreamEvent,
  SavedCameraPose,
  SeedanceSettings,
  SplatRuntime,
  StableDiffusionModel,
  StudioExample,
  SubrouteFrame,
  SystemUpdateStatus,
  UnifiedModelInfo,
  VideoModelOption
} from "./studioTypes";

// Compatibility note: storage keys and protocol fields keep the old node/studio names
// so saved routes, installed node manifests, and local browser state continue to load.

const library = [
  { type: "input.text", label: "Text Input", params: { value: "A small route prompt" } },
  { type: "library.prompt", label: "Prompt Library", params: { category: "image-generation", promptId: "adapt-user-idea-for-image-generator", mode: "linked" } },
  { type: "dialogue.workbench", label: "Dialogue Workbench", params: { defaultModelProfileId: "text.default", agentPresetId: "plain-collaborator", state: createDialogueWorkbenchState({ nodeId: "dialogue_workbench", defaultModelProfileId: "text.default" }) } },
  { type: "text.promptCompose", label: "Prompt Compose", params: { manualText: "", separator: "\n\n", trimParts: true, skipEmpty: true, prefix: "", suffix: "" } },
  { type: "input.image", label: "Input Image", params: { path: "" } },
  { type: "input.video", label: "Input Video", params: { path: "" } },
  { type: "input.file", label: "Input File", params: { path: "" } },
  { type: "compound.input", label: "Compound Input", params: { portId: "input", kind: "data" } },
  { type: "compound.output", label: "Compound Output", params: { portId: "output", kind: "data" } },
  { type: "transform.template", label: "Template Transform", params: { template: "{{input.output.text}}" } },
  { type: "utility.null", label: "Null", params: {} },
  {
    type: "gemini.llm",
    label: "Gemini LLM",
    params: {
      systemPrompt: "",
      prompt: "",
      model: "gemini-2.5-flash"
    }
  },
  {
    type: "ai.text",
    label: "Text AI",
    params: {
      model: "text.default",
      providerMode: "auto",
      systemPrompt: "",
      prompt: "",
      temperature: 0.7,
      max_tokens: 1024
    }
  },
  {
    type: "ai.image.generate",
    label: "Image Generation",
    params: {
      model: "image.nano-banana",
      providerMode: "auto",
      prompt: "Create a polished image.",
      aspectRatio: "1:1",
      imageSize: "2K"
    }
  },
  {
    type: "gemini.nano-banana-2",
    label: "Nano Banana 2",
    params: {
      prompt: "Transform this into a polished, high-detail image.",
      aspectRatio: "1:1",
      imageSize: "2K"
    }
  },
  {
    type: "local.stableDiffusion.textToImage",
    label: "Local Stable Diffusion",
    params: {
      endpoint: "http://127.0.0.1:7860",
      model: "",
      prompt: "A tiny stained glass dragon icon, art nouveau, clean simple composition",
      negativePrompt: "",
      width: 512,
      height: 512,
      steps: 20,
      seed: -1,
      cfgScale: 7,
      samplerName: "",
      batchSize: 1,
      restoreFaces: false,
      enableHrFix: false,
      timeoutMs: 180000
    }
  },
  {
    type: "ai.image.sd15.qr_monster_hidden_control",
    label: "Double Image Illusion",
    params: {
      endpoint: "http://127.0.0.1:7860",
      prompt: "A cinematic poster image with the hidden control image subtly readable from a distance",
      negativePrompt: "",
      mode: "hidden_image",
      controlWeight: 1.2,
      steps: 30,
      seed: -1,
      cfgScale: 7,
      samplerName: "DPM++ 2M Karras",
      batchSize: 1,
      guidanceStart: 0,
      guidanceEnd: 1,
      controlMode: "Balanced",
      resizeMode: "Just Resize",
      pixelPerfect: true,
      preprocessGrayscale: true,
      preprocessInvert: false
    }
  },
  {
    type: "replicate.clarity-upscaler",
    label: "Clarity Upscaler",
    params: {
      prompt: "masterpiece, best quality, highres",
      negative_prompt: "(worst quality, low quality, normal quality:2)",
      scale_factor: 2,
      dynamic: 6,
      creativity: 0.25,
      resemblance: 1.5,
      tiling_width: 112,
      tiling_height: 144,
      scheduler: "DPM++ 3M SDE Karras",
      num_inference_steps: 18,
      seed: 1337,
      downscaling: false,
      downscaling_resolution: 768,
      lora_links: "",
      pollingIntervalMs: 1000,
      timeoutMs: 120000
    }
  },
  { type: "preview.image", label: "Image Preview", params: {} },
  { type: "preview.panorama360", label: "360 Panorama Viewer", params: { fov: 55 } },
  {
    type: "transform.chooseCameraPoint",
    label: "Выбрать точку камеры",
    params: {
      provider: "worldlabs-marble",
      model: "marble-1.0-draft",
      regenerateWorld: false,
      resolution: "1536x864",
      fov: 70,
      cameraPose: { position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0, roll: 0 }, fov: 70 },
      output: { mode: "perspective", width: 1536, height: 864 },
      marbleWorld: { provider: "worldlabs-marble", model: "marble-1.0-draft", generationStatus: "no world" }
    }
  },
  { type: "transform.panorama360ToFisheye", label: "360 Panorama to Fisheye", params: { fovDegrees: 200, yawDegrees: 0, pitchDegrees: -90 } },
  {
    type: "http.request",
    label: "HTTP Request",
    params: {
      url: "http://127.0.0.1:4317/api/health",
      method: "GET",
      headers: {},
      query: {},
      bodyMode: "none",
      body: "{}",
      responseMode: "json",
      timeoutMs: 30000
    }
  },
  { type: "output.text", label: "Text Output", params: {} },
  { type: "output.file", label: "Save Text File", params: { filename: "output.txt", from: "{{output_text.output.text}}" } },
  { type: "debug.log", label: "Debug Log", params: { message: "Debug value", value: "{{input_prompt.output.text}}" } },
  { type: "capability.image.create", label: "Create Image Capability", params: { prompt: "", provider: "" } },
  { type: "capability.image.edit", label: "Edit Image Capability", params: { prompt: "", provider: "" } },
  { type: "capability.image.upscale", label: "Upscale Image Capability", params: { prompt: "", provider: "" } },
  { type: "capability.video.animate", label: "Animate Video Capability", params: { prompt: "", provider: "" } },
  { type: "capability.character.create", label: "Create Character Capability", params: { prompt: "", provider: "" } },
  { type: "capability.location.create", label: "Create Location Capability", params: { prompt: "", provider: "" } }
];

const librarySections = [
  { id: "inputs-assets", title: "Inputs & Assets", types: ["input.text", "library.prompt", "input.image", "input.video", "input.file", "compound.input", "compound.output"] },
  { id: "text-prompting", title: "Text & Prompting", types: ["dialogue.workbench", "text.promptCompose", "transform.template", "ai.text", "gemini.llm"] },
  { id: "image-generation", title: "Image Generation", types: ["ai.image.generate", "gemini.nano-banana-2", "local.stableDiffusion.textToImage", "ai.image.sd15.qr_monster_hidden_control"] },
  { id: "image-tools", title: "Image Tools & Preview", types: ["replicate.clarity-upscaler", "preview.image", "preview.panorama360", "transform.chooseCameraPoint", "transform.panorama360ToFisheye"] },
  { id: "api-integration", title: "API & Integration", types: ["http.request"] },
  { id: "outputs", title: "Outputs", types: ["output.text", "output.file"] },
  { id: "debug", title: "Debug", types: ["debug.log", "utility.null"] },
  {
    id: "capabilities",
    title: "Capabilities",
    types: [
      "capability.image.create",
      "capability.image.edit",
      "capability.image.upscale",
      "capability.video.animate",
      "capability.character.create",
      "capability.location.create"
    ]
  }
];

const blankRoute: RouteDoc = {
  routeVersion: "0.1",
  route: { id: "blank-route", title: "Blank Route", author: { name: "SnarkRoute" } },
  economics: { enabled: false, mode: "disabled" },
  nodes: [],
  edges: [],
  provenance: { tool: "snarkroute-studio" }
};

const exampleRoute: RouteDoc = {
  routeVersion: "0.1",
  route: { id: "prompt-library-to-image", title: "Prompt Library to Image", author: { name: "SnarkRoute" }, tags: ["prompt-library", "gemini", "llm", "image"] },
  economics: {
    enabled: false,
    mode: "disabled",
    currency: "USD",
    providerCosts: [
      { provider: "gemini", model: "gemini-2.5-flash", nodeType: "gemini.llm", pricingHint: "external-provider-billing", estimatedCost: null, actualCost: null },
      { provider: "gemini", model: "gemini-3.1-flash-image-preview", nodeType: "gemini.nano-banana-2", pricingHint: "external-provider-billing", estimatedCost: null, actualCost: null }
    ],
    notes: "Economics metadata is preserved. No payment execution in v0.1."
  },
  nodes: [
    {
      id: "prompt_library",
      type: "library.prompt",
      title: "Prompt Library",
      params: {
        category: "image-generation",
        promptId: "adapt-user-idea-for-image-generator",
        mode: "linked"
      },
      ui: { x: 40, y: 40 }
    },
    {
      id: "input_prompt",
      type: "input.text",
      title: "Text Input",
      params: { value: "А мы сделаем свой нодовый редактор с преферансом и куртизанками" },
      ui: { x: 40, y: 540 }
    },
    {
      id: "gemini_llm",
      type: "gemini.llm",
      title: "Gemini LLM",
      params: {
        systemPrompt: "",
        prompt: "",
        model: "gemini-2.5-flash"
      },
      ui: { x: 560, y: 220 }
    },
    {
      id: "gemini_nano-banana-2",
      type: "gemini.nano-banana-2",
      title: "Nano Banana 2",
      params: {
        prompt: "Transform this into a polished, high-detail image.",
        aspectRatio: "16:9",
        imageSize: "1K"
      },
      ui: { x: 1040, y: 220 }
    }
  ],
  edges: [
    { from: "prompt_library", to: "gemini_llm", fromPort: "text", toPort: "systemPrompt" },
    { from: "input_prompt", to: "gemini_llm", fromPort: "text", toPort: "prompt" },
    { from: "gemini_llm", to: "gemini_nano-banana-2", fromPort: "text", toPort: "prompt" }
  ],
  provenance: { tool: "snarkroute-studio" }
};

const milestoneExamples: RouteDoc[] = [
  {
    routeVersion: "0.1",
    route: { id: "m31-replicate-upscale", title: "M3.1 Replicate Upscale", description: "Input Image -> Replicate Clarity Upscaler -> Image Preview.", author: { name: "SnarkRoute" }, tags: ["milestone-3.1", "replicate", "upscale"] },
    economics: { enabled: false, mode: "disabled", providerCosts: [{ provider: "replicate", model: "philz1337x/clarity-upscaler", nodeType: "replicate.clarity-upscaler", pricingHint: "external-provider-billing", estimatedCost: null, actualCost: null }] },
    nodes: [
      { id: "input_image", type: "input.image", title: "Input Image", params: { path: "examples/assets/clarity-input.png" }, ui: { x: 40, y: 160 } },
      { id: "upscale", type: "replicate.clarity-upscaler", title: "Clarity Upscaler", params: { prompt: "masterpiece, best quality, highres", negative_prompt: "(worst quality, low quality, normal quality:2)", scale_factor: 2, dynamic: 6, creativity: 0.25, resemblance: 1.5, tiling_width: 112, tiling_height: 144, scheduler: "DPM++ 3M SDE Karras", num_inference_steps: 18, seed: 1337, downscaling: false, downscaling_resolution: 768, lora_links: "", pollingIntervalMs: 1000, timeoutMs: 120000 }, ui: { x: 420, y: 120 } },
      { id: "preview", type: "preview.image", title: "Image Preview", params: { title: "Upscaled" }, ui: { x: 820, y: 140 } }
    ],
    edges: [{ from: "input_image", to: "upscale", fromPort: "image", toPort: "image" }, { from: "upscale", to: "preview", fromPort: "image", toPort: "image" }],
    provenance: { tool: "snarkroute-studio" }
  },
  {
    routeVersion: "0.1",
    route: { id: "m31-nano-banana-compose", title: "M3.1 Nano Banana Two Image Compose", description: "Two images plus a prompt into Gemini/Nano Banana image generation.", author: { name: "SnarkRoute" }, tags: ["milestone-3.1", "gemini", "image"] },
    economics: { enabled: false, mode: "disabled", providerCosts: [{ provider: "gemini", model: "gemini-3.1-flash-image-preview", nodeType: "gemini.nano-banana-2", pricingHint: "external-provider-billing", estimatedCost: null, actualCost: null }] },
    nodes: [
      { id: "image_a", type: "input.image", title: "Input Image 1", params: { path: "examples/assets/clarity-input.png" }, ui: { x: 40, y: 80 } },
      { id: "image_b", type: "input.image", title: "Input Image 2", params: { path: "examples/assets/clarity-input.png" }, ui: { x: 40, y: 360 } },
      { id: "prompt", type: "input.text", title: "Prompt", params: { value: "Compose these two images into one polished poster-style image." }, ui: { x: 40, y: 620 } },
      { id: "compose", type: "gemini.nano-banana-2", title: "Nano Banana 2", params: { prompt: "Compose these images.", aspectRatio: "1:1", imageSize: "1K" }, ui: { x: 520, y: 250 } },
      { id: "preview", type: "preview.image", title: "Image Preview", params: { title: "Composed image" }, ui: { x: 920, y: 280 } }
    ],
    edges: [{ from: "image_a", to: "compose", fromPort: "image", toPort: "images" }, { from: "image_b", to: "compose", fromPort: "image", toPort: "images" }, { from: "prompt", to: "compose", fromPort: "text", toPort: "prompt" }, { from: "compose", to: "preview", fromPort: "image", toPort: "image" }],
    provenance: { tool: "snarkroute-studio" }
  },
  {
    ...exampleRoute,
    route: { ...exampleRoute.route, id: "m31-api-prompt-to-image", title: "M3.1 Prompt to Image via API", description: "Text prompt through Gemini API image generation.", tags: ["milestone-3.1", "gemini", "api", "image"] }
  },
  {
    routeVersion: "0.1",
    route: { id: "m31-local-sd-text-to-image", title: "M3.1 Local Stable Diffusion Text To Image", description: "Prompt -> local Stable Diffusion WebUI-compatible txt2img -> preview.", author: { name: "SnarkRoute" }, tags: ["milestone-3.1", "local", "stable-diffusion"] },
    economics: { enabled: false, mode: "disabled" },
    nodes: [
      { id: "prompt", type: "input.text", title: "Prompt", params: { value: "A tiny stained glass dragon icon, art nouveau, clean simple composition" }, ui: { x: 40, y: 220 } },
      { id: "sd", type: "local.stableDiffusion.textToImage", title: "Local Stable Diffusion", params: { endpoint: "http://127.0.0.1:7860", model: "", prompt: "", negativePrompt: "", width: 512, height: 512, steps: 20, seed: -1, cfgScale: 7, samplerName: "", batchSize: 1, restoreFaces: false, enableHrFix: false, timeoutMs: 180000 }, ui: { x: 460, y: 120 } },
      { id: "preview", type: "preview.image", title: "Image Preview", params: { title: "Local SD output" }, ui: { x: 900, y: 170 } }
    ],
    edges: [{ from: "prompt", to: "sd", fromPort: "text", toPort: "prompt" }, { from: "sd", to: "preview", fromPort: "image", toPort: "image" }],
    provenance: { tool: "snarkroute-studio" }
  },
  {
    routeVersion: "0.1",
    route: { id: "m31-http-json-test", title: "M3.1 Generic HTTP JSON Test", description: "HTTP Request -> Debug Log -> Text Output.", author: { name: "SnarkRoute" }, tags: ["milestone-3.1", "http", "json"] },
    economics: { enabled: false, mode: "disabled" },
    nodes: [
      { id: "http", type: "http.request", title: "HTTP Request", params: { url: "http://127.0.0.1:4317/api/health", method: "GET", headers: {}, query: {}, bodyMode: "none", body: "{}", responseMode: "json", timeoutMs: 30000 }, ui: { x: 80, y: 160 } },
      { id: "debug", type: "debug.log", title: "Debug Log", params: { value: "{{http.output.responseText}}" }, ui: { x: 500, y: 180 } },
      { id: "output", type: "output.text", title: "JSON Preview", params: {}, ui: { x: 880, y: 190 } }
    ],
    edges: [{ from: "http", to: "debug", fromPort: "responseJson", toPort: "value" }, { from: "debug", to: "output", fromPort: "value", toPort: "from" }],
    provenance: { tool: "snarkroute-studio" }
  }
];

const studioExamples: StudioExample[] = [
  {
    route: milestoneExamples[0],
    title: "Replicate Upscale",
    description: "Upscale a starter image with Replicate Clarity Upscaler.",
    provider: "Replicate",
    category: "Basic Image",
    milestone: "M3.1"
  },
  {
    route: milestoneExamples[1],
    title: "Nano Banana: Two Image Compose",
    description: "Combine two images and a prompt with Gemini image generation.",
    provider: "Gemini",
    category: "AI Image",
    milestone: "M3.1"
  },
  {
    route: milestoneExamples[2],
    title: "Prompt to Image",
    description: "Generate an image from a text prompt through the Gemini API.",
    provider: "Gemini",
    category: "AI Image",
    milestone: "M3.1"
  },
  {
    route: milestoneExamples[3],
    title: "Local Stable Diffusion Text to Image",
    description: "Send a prompt to a local Stable Diffusion WebUI-compatible endpoint.",
    provider: "Local",
    category: "Local AI",
    milestone: "M3.1"
  },
  {
    route: milestoneExamples[4],
    title: "Generic HTTP JSON Test",
    description: "Call a JSON HTTP endpoint and inspect the response.",
    provider: "HTTP",
    category: "Developer",
    milestone: "M3.1"
  }
];

const exampleCategories: ExampleCategory[] = ["Basic Image", "AI Image", "Local AI", "Developer"];

function RouteNodeCard({ id, data }: NodeProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const updateNodeInternals = useUpdateNodeInternals();
  const label = String(data.label ?? "");
  const [title, type] = label.split("\n");
  const routeNode = data.routeNode as RouteDoc["nodes"][number] | undefined;
  const paramsCollapsed = Boolean(data.paramsCollapsed ?? routeNodeParamsCollapsed(routeNode));
  const params = routeNode?.params ?? {};
  const result = data.result as NodeRunResult | undefined;
  const onParamsChange = data.onParamsChange as ((nodeId: string, params: Record<string, unknown>) => void) | undefined;
  const onParamsCollapsedChange = data.onParamsCollapsedChange as ((nodeId: string, collapsed: boolean) => void) | undefined;
  const onBrowseAsset = data.onBrowseAsset as ((nodeId: string, kind: AssetKind) => void) | undefined;
  const supportsLocalFilesystem = data.supportsLocalFilesystem !== false;
  const replicateConfigured = Boolean(data.replicateConfigured);
  const geminiConfigured = Boolean(data.geminiConfigured);
  const openAiConfigured = Boolean(data.openAiConfigured);
  const seedanceConfigured = Boolean(data.seedanceConfigured);
  const seedanceStatusText = String(data.seedanceStatusText ?? "");
  const polzaConfigured = Boolean(data.polzaConfigured);
  const openRouterConfigured = Boolean(data.openRouterConfigured);
  const onConfigureReplicate = data.onConfigureReplicate as (() => void) | undefined;
  const onConfigureGemini = data.onConfigureGemini as (() => void) | undefined;
  const onConfigureOpenAi = data.onConfigureOpenAi as (() => void) | undefined;
  const onConfigureSeedance = data.onConfigureSeedance as (() => void) | undefined;
  const onConfigureWorldLabs = data.onConfigureWorldLabs as (() => void) | undefined;
  const onConfigurePolza = data.onConfigurePolza as (() => void) | undefined;
  const onConfigureOpenRouter = data.onConfigureOpenRouter as (() => void) | undefined;
  const onOpenImage = data.onOpenImage as ((image: ImageViewerState) => void) | undefined;
  const onDownloadImage = data.onDownloadImage as ((src: string, filename: string) => void) | undefined;
  const onImageResultContextMenu = data.onImageResultContextMenu as ((event: React.MouseEvent, nodeId: string, result: NodeRunResult) => void) | undefined;
  const onFixNodeOutput = data.onFixNodeOutput as ((nodeId: string, output: unknown, options?: FixNodeOutputOptions) => void) | undefined;
  const onRunNodeOnly = data.onRunNodeOnly as ((nodeId: string) => void) | undefined;
  const onRunNodeWithDependencies = data.onRunNodeWithDependencies as ((nodeId: string) => void) | undefined;
  const onOpenSubroute = data.onOpenSubroute as ((nodeId: string) => void) | undefined;
  const onOpenDialogueWorkbench = data.onOpenDialogueWorkbench as ((nodeId: string) => void) | undefined;
  const onUncollapse = data.onUncollapse as ((nodeId: string) => void) | undefined;
  const onNodeUiChange = data.onNodeUiChange as ((nodeId: string, patch: Record<string, unknown>) => void) | undefined;
  const onPublishNodeOutput = data.onPublishNodeOutput as ((nodeId: string, output: Record<string, unknown>) => void) | undefined;
  const promptLibrary = data.promptLibrary as PromptLibraryData | undefined;
  const onRefreshPromptLibrary = data.onRefreshPromptLibrary as (() => void) | undefined;
  const promptStatusFilter = (data.promptStatusFilter as PromptStatusFilter | undefined) ?? "all";
  const onPromptStatusFilterChange = data.onPromptStatusFilterChange as ((filter: PromptStatusFilter) => void) | undefined;
  const onPromptContextMenu = data.onPromptContextMenu as ((event: React.MouseEvent, prompt: PromptLibraryPrompt) => void) | undefined;
  const stableDiffusionModels = (data.stableDiffusionModels as StableDiffusionModel[] | undefined) ?? [];
  const openRouterModels = (data.openRouterModels as OpenRouterModel[] | undefined) ?? [];
  const catalogImageModels = (data.catalogImageModels as UnifiedModelInfo[] | null | undefined) ?? null;
  const modelOptionsForNodes = (data.modelOptionsForNodes as Record<string, ModelOptionForNodeV1[] | undefined> | undefined) ?? {};
  const modelProfiles = (data.modelProfiles as ModelProfile[] | undefined) ?? DEFAULT_MODEL_PROFILES;
  const polzaTextModels = (data.polzaTextModels as PolzaModel[] | undefined) ?? [];
  const polzaImageModels = (data.polzaImageModels as PolzaModel[] | undefined) ?? [];
  const polzaVideoModels = (data.polzaVideoModels as PolzaModel[] | undefined) ?? [];
  const quotePreview = data.quotePreview as ModelQuotePreview | undefined;
  const costEstimate = data.costEstimate as CostEstimate | undefined;
  const resizeInputImage = data.resizeInputImage;
  const chooseCameraInputImage = data.chooseCameraInputImage;
  const manifest = data.manifest as NodeManifest | undefined;
  const isMissingNode = Boolean(data.isMissingNode);
  const onRefreshStableDiffusionModels = data.onRefreshStableDiffusionModels as ((endpoint: string) => void) | undefined;
  const onRefreshPricing = data.onRefreshPricing as ((provider: string) => void) | undefined;
  const connectedInputPorts = new Set((data.connectedInputPorts as string[] | undefined) ?? []);
  const connectedInputCounts = (data.connectedInputCounts as Record<string, number> | undefined) ?? {};
  const creditBalance = data.creditBalance as { balance: number; currency: string } | null | undefined;
  const canRunNodeOnly = Boolean(data.canRunNodeOnly);
  const nodeNeedsCredits = Number(costEstimate?.estimatedCredits ?? 0);
  const nodeHasEnoughCredits = !creditBalance || creditBalance.balance >= nodeNeedsCredits;
  const ports = getNodePorts(type, manifest, routeNode);
  const outputPinned = pinnedOutputFromParams(params) !== undefined;
  const collapsedInputImagePath = type === "input.image" ? String(params.path ?? "").trim() : "";
  const collapsedResultImage = result ? lastImageValue(result.output) : null;
  const collapsedImageSrc = paramsCollapsed
    ? collapsedInputImagePath
      ? localImagePreviewSrc(collapsedInputImagePath)
      : imagePreviewSrc(collapsedResultImage)
    : null;
  const collapsedImageTitle = collapsedImageSrc
    ? collapsedInputImagePath
      ? filenameFromPath(collapsedInputImagePath)
      : imageLabel(collapsedResultImage)
    : "";
  const collapsedImageFilename = collapsedInputImagePath ? filenameFromPath(collapsedInputImagePath) : downloadFilename(collapsedResultImage);
  const portTopBase = paramsCollapsed ? 14 : 34;
  const collapsedPortSpacing = 20;
  const collapsedPortCount = Math.max(ports.inputs.length, ports.outputs.length);
  const collapsedMinHeight = paramsCollapsed ? Math.max(44, 30 + Math.max(0, collapsedPortCount - 1) * collapsedPortSpacing) : undefined;

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    let animationFrame = 0;
    const updateHandles = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => updateNodeInternals(id));
    };
    const observer = new ResizeObserver(updateHandles);
    observer.observe(card);
    updateHandles();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [id, updateNodeInternals, paramsCollapsed, ports.inputs.length, ports.outputs.length]);

  function portLabelTop(index: number): number {
    return paramsCollapsed ? portHandleTop(index, 1) : portTopBase + index * 28;
  }

  function portHandleTop(index: number, total: number): number {
    if (!paramsCollapsed) return portTopBase + 8 + index * 28;
    const count = Math.max(total, 1);
    const first = (collapsedMinHeight ?? 44) / 2 - ((count - 1) * collapsedPortSpacing) / 2;
    return first + index * collapsedPortSpacing;
  }

  function patchParams(patch: Record<string, unknown>) {
    onParamsChange?.(id, { ...params, ...patch });
  }

  const configureMissingSecret = configureHandlerForError(result?.error, {
    REPLICATE_API_TOKEN: onConfigureReplicate,
    GEMINI_API_KEY: onConfigureGemini,
    OPENAI_API_KEY: onConfigureOpenAi,
    POLZA_AI_API_KEY: onConfigurePolza,
    SEEDANCE_API_KEY: onConfigureSeedance,
    WORLDS_API_KEY: onConfigureWorldLabs
  });

  return (
    <div ref={cardRef} className={`routeNodeCard ${compactNodeClass(type)} ${paramsCollapsed ? "paramsCollapsed" : ""}`.trim()} style={collapsedMinHeight ? { minHeight: `${collapsedMinHeight}px` } : undefined}>
      <span className={`nodeStatus ${statusClass(result?.status)}`} />
      {isMissingNode ? <div className="nodeWarning">Missing block package. Install "{type}" or remove this block.</div> : null}
      {shouldShowNodeRunButton(type) ? (
        <div className="nodeRunActions">
          <button
            className="nodeRunButton nodrag nopan"
            type="button"
            title={canRunNodeOnly ? "Run this node only" : "Run this node only after all inputs have ready outputs"}
            disabled={!canRunNodeOnly}
            onClick={(event) => {
              event.stopPropagation();
              onRunNodeOnly?.(id);
            }}
          >
            <Play size={12} />
          </button>
          <button
            className="nodeRunButton dependency nodrag nopan"
            type="button"
            title="Run this node with upstream dependencies"
            onClick={(event) => {
              event.stopPropagation();
              onRunNodeWithDependencies?.(id);
            }}
          >
            <span className="nodeRunDoubleArrow">&gt;&gt;</span>
          </button>
        </div>
      ) : null}
      {ports.inputs.map((port, index) => (
        <React.Fragment key={port.id}>
          <span className="portLabel input" style={{ top: `${portLabelTop(index)}px` }}>
            {portLabel(port, connectedInputCounts[port.id] ?? 0)}
          </span>
          <Handle
            className={`typedHandle ${port.kind}`}
            id={port.id}
            type="target"
            position={Position.Left}
            style={{ top: `${portHandleTop(index, ports.inputs.length)}px` }}
            title={`${port.id}: ${port.kind}`}
          />
        </React.Fragment>
      ))}
      <div className="nodeHeader">
        <span className={`nodeIcon ${nodeIconClass(type)}`}>{nodeIcon(type)}</span>
        <div>
          <div className="nodeTitle">{title}</div>
          {!paramsCollapsed ? (
            <>
              <div className="nodeType" title={type}>{type}</div>
              <div className={`executorBadge ${executorKind(type, manifest)}`}>{executorLabel(type, manifest)}</div>
              {routeNode?.type === "compound.subroute" ? <div className="nodeMetaLine">{routeNode.subroute?.nodes.length ?? 0} internal block(s)</div> : null}
              {routeNode?.type === "dialogue.workbench" ? <DialogueNodeMeta routeNode={routeNode} modelProfiles={modelProfiles} /> : null}
            </>
          ) : null}
        </div>
        <button
          className="nodeCollapseButton nodrag nopan"
          type="button"
          title={paramsCollapsed ? "Show parameters" : "Hide parameters"}
          onClick={(event) => {
            event.stopPropagation();
            onParamsCollapsedChange?.(id, !paramsCollapsed);
          }}
        >
          {paramsCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
        {paramsCollapsed && routeNode?.type === "compound.subroute" && (routeNode.subroute?.nodes.length ?? 0) > 0 ? (
          <button
            className="collapsedCompoundOpenButton nodrag nopan"
            type="button"
            title="Open Internal Tool Route"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpenSubroute?.(id);
            }}
          >
            <FolderOpen size={13} />
          </button>
        ) : null}
      </div>
      {!paramsCollapsed && isReplicateNode(type) ? (
        <div className={`nodeTokenStatus ${replicateConfigured ? "configured" : "missing"}`}>
          <span>{replicateTokenStatusText(replicateConfigured)}</span>
          {!replicateConfigured ? (
            <>
              <strong>Requires Replicate API token</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureReplicate}>Configure Replicate</button>
              <small>Open Settings \u2192 Secrets \u2192 Replicate</small>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed && routeNode?.type === "compound.subroute" ? (
        <div className="compoundActions">
          <button
            className="nodeSmallButton nodrag nopan"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpenSubroute?.(id);
            }}
          >
            Open Internal Tool Route
          </button>
          <button
            className="nodeSmallButton nodrag nopan"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onUncollapse?.(id);
            }}
          >
            Uncollapse
          </button>
        </div>
      ) : null}
      {!paramsCollapsed && routeNode?.type === "dialogue.workbench" ? (
        <div className="compoundActions">
          <button
            className="nodeSmallButton nodrag nopan"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpenDialogueWorkbench?.(id);
            }}
          >
            Open Workbench
          </button>
        </div>
      ) : null}
      {!paramsCollapsed && isGeminiNode(type) ? (
        <div className={`nodeTokenStatus ${geminiConfigured ? "configured" : "missing"}`}>
          <span>{geminiTokenStatusText(geminiConfigured)}</span>
          {!geminiConfigured ? (
            <>
              <strong>Requires Gemini API key</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureGemini}>Configure Gemini</button>
              <small>Open Settings \u2192 Secrets \u2192 Gemini</small>
              <a className="nodeTokenLink nodrag nopan" href={GEMINI_API_KEY_URL} target="_blank" rel="noreferrer">Get Gemini API key</a>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed && requiresEnv(manifest, "OPENAI_API_KEY") ? (
        <div className={`nodeTokenStatus ${openAiConfigured ? "configured" : "missing"}`}>
          <span>OpenAI: {openAiConfigured ? "key configured" : "missing"}</span>
          {!openAiConfigured ? (
            <>
              <strong>Requires OpenAI API key</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureOpenAi}>Configure OpenAI</button>
              <small>Open Settings &gt; Advanced / Direct Secrets &gt; OpenAI</small>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed && requiresEnv(manifest, "SEEDANCE_API_KEY") ? (
        <div className={`nodeTokenStatus ${seedanceConfigured ? "configured" : "missing"}`}>
          <span>Seedance: {seedanceConfigured ? "configured" : (seedanceStatusText || "missing")}</span>
          {!seedanceConfigured ? (
            <>
              <strong>Requires Seedance backend and API key</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureSeedance}>Configure Seedance</button>
              <small>Open Settings &gt; Advanced / Direct Secrets &gt; Seedance</small>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed && isRemoteAiNode(type) ? (
        <div className={`nodeTokenStatus ${openRouterConfigured ? "configured" : "missing"}`}>
          <span>OpenRouter: {openRouterConfigured ? "key configured" : "missing"}</span>
          {!openRouterConfigured ? (
            <>
              <strong>Uses OpenRouter by default</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureOpenRouter}>Configure OpenRouter</button>
              <small>Direct mode remains available in Advanced for supported legacy providers.</small>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed && isPolzaNode(type) ? (
        <div className={`nodeTokenStatus ${polzaConfigured ? "configured" : "missing"}`}>
          <span>Polza.ai: {polzaConfigured ? "key configured" : "missing"}</span>
          {!polzaConfigured ? (
            <>
              <strong>Requires Polza.ai API key</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigurePolza}>Configure Polza.ai</button>
              <small>Open Settings &gt; AI Providers &gt; Polza.ai</small>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed ? (
        <NodeInlineParams
          type={type}
          manifest={manifest}
          params={params}
          connectedInputPorts={connectedInputPorts}
          promptLibrary={promptLibrary ?? { categories: [] }}
          onRefreshPromptLibrary={onRefreshPromptLibrary}
          promptStatusFilter={promptStatusFilter}
          onPromptStatusFilterChange={onPromptStatusFilterChange}
          onPromptContextMenu={onPromptContextMenu}
          stableDiffusionModels={stableDiffusionModels}
          openRouterModels={openRouterModels}
          catalogImageModels={catalogImageModels}
          modelOptionsForNodes={modelOptionsForNodes}
          modelProfiles={modelProfiles}
          polzaTextModels={polzaTextModels}
          polzaImageModels={polzaImageModels}
          polzaVideoModels={polzaVideoModels}
          quotePreview={quotePreview}
          costEstimate={costEstimate}
          resizeInputImage={resizeInputImage}
          chooseCameraInputImage={chooseCameraInputImage}
          onConfigureWorldLabs={onConfigureWorldLabs}
          onPublishNodeOutput={onPublishNodeOutput ? (output) => onPublishNodeOutput(id, output) : undefined}
          onRefreshPricing={onRefreshPricing}
          onRefreshStableDiffusionModels={onRefreshStableDiffusionModels}
          onChange={patchParams}
          onBrowse={(kind) => onBrowseAsset?.(id, kind)}
          canBrowseLocalFiles={supportsLocalFilesystem}
          onOpenImage={onOpenImage}
        />
      ) : null}
      {!paramsCollapsed && result && shouldShowInlineResult(type) ? <NodeInlineResult nodeId={id} type={type} result={result} outputPinned={outputPinned} onOpenImage={onOpenImage} onDownloadImage={onDownloadImage} onImageResultContextMenu={onImageResultContextMenu} onFixNodeOutput={onFixNodeOutput} onConfigureMissingSecret={configureMissingSecret} /> : null}
      {paramsCollapsed && collapsedImageSrc ? (
        <button
          className="collapsedImagePreviewButton nodrag nopan"
          type="button"
          title="View output image"
          onClick={(event) => {
            event.stopPropagation();
            onOpenImage?.({ src: collapsedImageSrc, title: collapsedImageTitle, filename: collapsedImageFilename });
          }}
        >
          <img className="collapsedImagePreview" src={collapsedImageSrc} alt="" />
        </button>
      ) : null}
      {ports.outputs.map((port, index) => (
        <React.Fragment key={port.id}>
          <span className="portLabel output" style={{ top: `${portLabelTop(index)}px` }}>
            {port.label ?? port.id}
          </span>
          <Handle
            className={`typedHandle ${port.kind}`}
            id={port.id}
            type="source"
            position={Position.Right}
            style={{ top: `${portHandleTop(index, ports.outputs.length)}px` }}
            title={`${port.id}: ${port.kind}`}
          />
        </React.Fragment>
      ))}
    </div>
  );
}

function DialogueNodeMeta({ routeNode, modelProfiles }: { routeNode: RouteDoc["nodes"][number]; modelProfiles: ModelProfile[] }) {
  const state = normalizeDialogueWorkbenchState(routeNode.params?.state, {
    nodeId: routeNode.id,
    defaultModelProfileId: String(routeNode.params?.defaultModelProfileId ?? "text.default")
  });
  const profile = modelProfiles.find((entry) => entry.id === (state.defaultModelProfileId ?? routeNode.params?.defaultModelProfileId));
  return (
    <>
      <div className="nodeMetaLine withLogo">
        {profile ? <ModelLogoMark logo={modelLogoFor(profile.providerId, profile.modelId, profile.id)} size="tiny" /> : null}
        <span>{profile?.displayName ?? state.defaultModelProfileId ?? "No model profile"} · {state.messages.length} message(s)</span>
      </div>
      <div className="nodeMetaLine">{state.selectedOutputs.length} selected output(s)</div>
    </>
  );
}

function DialogueWorkbenchEditor({
  routeNode,
  inputs,
  modelProfiles,
  agentPresets,
  onClose,
  onSave
}: {
  routeNode: RouteDoc["nodes"][number];
  inputs: DialogueConnectedInput[];
  modelProfiles: ModelProfile[];
  agentPresets: AgentPreset[];
  onClose: () => void;
  onSave: (state: DialogueWorkbenchState, patch?: Record<string, unknown>) => void;
}) {
  const initialState = normalizeDialogueWorkbenchState(routeNode.params?.state, {
    nodeId: routeNode.id,
    defaultModelProfileId: String(routeNode.params?.defaultModelProfileId ?? "text.default")
  });
  const [state, setState] = useState<DialogueWorkbenchState>(initialState);
  const [draftText, setDraftText] = useState("");
  const [draftRole, setDraftRole] = useState<DialogueMessage["role"]>("user");
  const [draftAttachments, setDraftAttachments] = useState<DialogueDraftContentPart[]>([]);
  const dialogueModelProfiles = useMemo(() => modelProfiles.filter(isDialogueModelProfile), [modelProfiles]);
  const initialModelProfileId = dialogueModelProfiles.some((profile) => profile.id === state.defaultModelProfileId)
    ? state.defaultModelProfileId ?? "text.default"
    : dialogueModelProfiles[0]?.id ?? "text.default";
  const [selectedModelProfileId, setSelectedModelProfileId] = useState(initialModelProfileId);
  const [modelSearch, setModelSearch] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [selectedInputId, setSelectedInputId] = useState("");
  const [modelSavedMessage, setModelSavedMessage] = useState("");
  const [outputDraft, setOutputDraft] = useState({ name: "final_prompt", type: "text" as DialogueOutputType, value: "" });
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantError, setAssistantError] = useState("");
  const selectedProfile = dialogueModelProfiles.find((profile) => profile.id === selectedModelProfileId) ?? dialogueModelProfiles[0];
  const visibleModelProfiles = useMemo(
    () => filterDialogueModelProfiles(dialogueModelProfiles, modelSearch).slice(0, 60),
    [dialogueModelProfiles, modelSearch]
  );
  const hasImageInputs = inputs.some((input) => input.type === "image");
  const modelVisionWarning = hasImageInputs && selectedProfile && !selectedProfile.capabilities.includes("vision");
  const previewOutputs = buildDialogueWorkbenchOutputs({
    nodeId: routeNode.id,
    nodeTitle: routeNode.title,
    state,
    inputs: Object.fromEntries(inputs.map((input) => [input.id, input.value])),
    modelProfiles
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function persist(next: DialogueWorkbenchState, patch: Record<string, unknown> = {}) {
    setState(next);
    onSave(next, { defaultModelProfileId: next.defaultModelProfileId, agentPresetId: next.agentPresetId, ...patch });
  }

  function chooseModelProfile(profileId: string) {
    setSelectedModelProfileId(profileId);
    setModelSavedMessage("");
  }

  function saveCurrentModelAsDefault() {
    persist({ ...state, defaultModelProfileId: selectedModelProfileId }, { persistProject: true });
    setModelSavedMessage("Saved as default");
  }

  function addMessage(role: DialogueMessage["role"] = draftRole, text = draftText) {
    const content = dialogueMessageContent(text, role === "user" ? draftAttachments : []);
    if (content.length === 0) return;
    const now = new Date().toISOString();
    const profile = modelProfiles.find((entry) => entry.id === selectedModelProfileId);
    const message: DialogueMessage = {
      id: `message_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`,
      role,
      content,
      createdAt: now,
      modelProfileId: role === "assistant" ? selectedModelProfileId : undefined,
      actualProviderId: role === "assistant" ? profile?.providerId : undefined,
      actualModelId: role === "assistant" ? profile?.modelId : undefined,
      params: role === "assistant" ? profile?.defaultParams : undefined,
      costEstimate: undefined
    };
    persist({ ...state, messages: [...state.messages, message] });
    setDraftText("");
    if (role === "user") setDraftAttachments([]);
  }

  function insertInput(input: DialogueConnectedInput, afterMessageId?: string) {
    const message: DialogueMessage = {
      id: `message_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`,
      role: "user",
      content: [stripDialoguePartUi(dialogueContentPartFromInput(input))],
      createdAt: new Date().toISOString()
    };
    const index = afterMessageId ? state.messages.findIndex((entry) => entry.id === afterMessageId) : -1;
    const messages = index >= 0
      ? [...state.messages.slice(0, index + 1), message, ...state.messages.slice(index + 1)]
      : [message, ...state.messages];
    persist({ ...state, messages });
  }

  function attachInputToDraft(input: DialogueConnectedInput) {
    setDraftAttachments((current) => [...current, dialogueContentPartFromInput(input)]);
    setSelectedInputId(input.id);
  }

  function removeDraftAttachment(index: number) {
    setDraftAttachments((current) => current.filter((_, entryIndex) => entryIndex !== index));
  }

  function insertSelectedInput(afterMessageId?: string) {
    const input = inputs.find((entry) => entry.id === selectedInputId) ?? inputs.find((entry) => entry.type === "image") ?? inputs[0];
    if (input) insertInput(input, afterMessageId);
  }

  async function askModel() {
    if ((!draftText.trim() && draftAttachments.length === 0) || assistantBusy) return;
    const profile = modelProfiles.find((entry) => entry.id === selectedModelProfileId);
    if (!profile) {
      setAssistantError("Choose a model profile first.");
      return;
    }
    if (profile.costClass === "dangerous" || profile.costClass === "expensive") {
      const confirmed = window.confirm(`This profile is marked ${profile.costClass}. Send one explicit request?`);
      if (!confirmed) return;
    }

    setAssistantBusy(true);
    setAssistantError("");
    const userText = draftText;
    const attachments = draftAttachments.length > 0 ? draftAttachments : autoAttachImagesForModel(inputs, profile);
    const userContent = dialogueMessageContent(userText, attachments);
    const userMessage = createDialogueTextMessage({
      role: "user",
      text: userText,
      modelProfileId: undefined,
      profile: undefined,
      content: userContent
    });
    const nextState = { ...state, messages: [...state.messages, userMessage] };
    persist(nextState);
    setDraftText("");
    setDraftAttachments([]);

    try {
      const images = profile.capabilities.includes("vision") ? imageRefsFromContent(userContent) : [];
      const response = await fetch(`${apiBase}/api/routes/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routeVersion: "0.1",
          route: { id: `dialogue-call-${routeNode.id}`, title: "Dialogue Workbench Model Call", author: { name: "BoojumRoute Lab" } },
          economics: { enabled: false, mode: "disabled" },
          nodes: [
            {
              id: "assistant",
              type: "ai.text",
              params: {
                model: modelIdForProfile(profile),
                providerMode: providerModeForProfile(profile),
                systemPrompt: agentPresets.find((preset) => preset.id === state.agentPresetId)?.systemPrompt ?? "",
                prompt: dialoguePromptForModel({ state: nextState, inputs, userText }),
                images
              }
            }
          ],
          edges: []
        })
      });
      const result = await response.json();
      if (!response.ok || result.status !== "succeeded") {
        throw new Error(result.error ?? firstRunError(result) ?? "Model call failed.");
      }
      const assistantOutput = result.nodeResults?.assistant?.output;
      const assistantText = outputText(assistantOutput) ?? previewValue(assistantOutput);
      const providerUsage = Array.isArray(result.economics?.providersUsed) ? result.economics.providersUsed[0] : null;
      const assistantMessage = createDialogueTextMessage({
        role: "assistant",
        text: assistantText,
        modelProfileId: profile.id,
        profile,
        providerUsage,
        params: { model: modelIdForProfile(profile), providerMode: providerModeForProfile(profile) }
      });
      persist({ ...nextState, messages: [...nextState.messages, assistantMessage] });
      setTimeout(() => scrollDialogueMessageIntoView(assistantMessage.id), 0);
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : String(error));
      persist(nextState);
    } finally {
      setAssistantBusy(false);
    }
  }

  function patchMessage(messageId: string, patch: Partial<DialogueMessage>) {
    persist({ ...state, messages: state.messages.map((message) => message.id === messageId ? { ...message, ...patch } : message) });
  }

  function addOutputFromMessage(message: DialogueMessage) {
    const text = message.content.map(partText).filter(Boolean).join("\n").trim();
    const output: DialogueSelectedOutput = {
      id: uniqueOutputId(state.selectedOutputs, "output"),
      name: "selected_output",
      type: "text",
      sourceMessageId: message.id,
      value: text,
      status: "selected"
    };
    persist({ ...state, messages: state.messages.map((entry) => entry.id === message.id ? { ...entry, selectedAsOutput: true } : entry), selectedOutputs: [...state.selectedOutputs, output] });
  }

  function addOutputFromSelection(message: DialogueMessage) {
    const selectedText = window.getSelection()?.toString().trim();
    if (!selectedText) {
      setAssistantError("Select a text fragment in the message first.");
      return;
    }
    const output: DialogueSelectedOutput = {
      id: uniqueOutputId(state.selectedOutputs, "selected_text"),
      name: "selected_text",
      type: "text",
      sourceMessageId: message.id,
      value: selectedText,
      status: "selected"
    };
    setAssistantError("");
    persist({ ...state, messages: state.messages.map((entry) => entry.id === message.id ? { ...entry, selectedAsOutput: true } : entry), selectedOutputs: [...state.selectedOutputs, output] });
  }

  function addManualOutput() {
    if (!outputDraft.name.trim()) return;
    const output: DialogueSelectedOutput = {
      id: uniqueOutputId(state.selectedOutputs, outputDraft.name),
      name: outputDraft.name.trim(),
      type: outputDraft.type,
      value: outputDraft.type === "json" ? parseJsonOrText(outputDraft.value) : outputDraft.value,
      status: "draft"
    };
    persist({ ...state, selectedOutputs: [...state.selectedOutputs, output] });
    setOutputDraft({ name: "final_prompt", type: "text", value: "" });
  }

  function patchOutput(outputId: string, patch: Partial<DialogueSelectedOutput>) {
    persist({ ...state, selectedOutputs: state.selectedOutputs.map((output) => output.id === outputId ? { ...output, ...patch } : output) });
  }

  function updateCapsuleSummary() {
    const capsule = previewOutputs.conversation_capsule;
    persist({ ...state, parentConversationCapsules: state.parentConversationCapsules, selectedOutputs: state.selectedOutputs });
    setOutputDraft((current) => ({ ...current, value: capsule.compactSummary }));
  }

  return (
    <div className="dialogueModalBackdrop" role="dialog" aria-modal="true" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="dialogueModal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialogueModalHeader">
          <div>
            <h2>{routeNode.title ?? "Dialogue Workbench"}</h2>
            <span>{routeNode.id} · {state.conversationId}</span>
          </div>
          <div className="dialogueHeaderActions">
            <button className="iconButton" title="Close" onClick={onClose}><X size={16} /></button>
          </div>
        </header>
        <div className="dialogueWorkbenchGrid">
          <aside className="dialogueInputsPane">
            <h3>Inputs</h3>
            {inputs.filter((input) => input.type !== "conversation_context").map((input) => (
              <div className={`dialogueInputItem ${selectedInputId === input.id ? "selected" : ""}`} key={`${input.sourceNodeId}-${input.sourcePort}-${input.id}`}>
                <strong>{input.type}: {input.id}</strong>
                <span>{input.sourceNodeId}.{input.sourcePort ?? "output"}</span>
                <DialogueInputPreview input={input} />
                <div className="dialogueInputActions">
                  <button className="nodeSmallButton" type="button" onClick={() => setSelectedInputId(input.id)}>Select</button>
                  <button className="nodeSmallButton" type="button" onClick={() => attachInputToDraft(input)}>Attach</button>
                  <button className="nodeSmallButton" type="button" onClick={() => insertInput(input)}>Insert at Top</button>
                </div>
              </div>
            ))}
            <h3>Conversation Context</h3>
            {inputs.filter((input) => input.type === "conversation_context").length === 0 ? <p className="muted">No capsules connected.</p> : null}
            {inputs.filter((input) => input.type === "conversation_context").map((input) => (
              <div className="dialogueInputItem context" key={`${input.sourceNodeId}-${input.sourcePort}-${input.id}`}>
                <strong>{input.id}</strong>
                <pre>{input.preview}</pre>
              </div>
            ))}
          </aside>
          <section className="dialogueMessagesPane">
            <div className="dialogueMessages">
              {state.messages.length === 0 ? <p className="muted">No messages yet. Add manual user, assistant, system, or tool notes.</p> : null}
              {inputs.length > 0 ? (
                <button className="dialogueInsertHere" type="button" onClick={() => insertSelectedInput()}>
                  Insert selected input here
                </button>
              ) : null}
              {state.messages.map((message) => (
                <article className={`dialogueMessage ${message.role}`} id={`dialogue-message-${message.id}`} key={message.id}>
                  <header>
                    <strong>{message.role}</strong>
                    <span>{message.createdAt}</span>
                    {message.modelProfileId ? <em>{modelLabel(message.modelProfileId, modelProfiles, message)}</em> : null}
                  </header>
                  <div className="dialogueMessageBody">{message.content.map((part, index) => <DialoguePartView key={index} part={part} compact={message.role === "user"} renderMarkdown={message.role === "assistant"} />)}</div>
                  <footer>
                    <button className="nodeSmallButton" onClick={() => patchMessage(message.id, { pinned: !message.pinned })}>{message.pinned ? <Pin size={13} /> : <Pin size={13} />} Pin</button>
                    <button className="nodeSmallButton" onClick={() => addOutputFromMessage(message)}><CheckSquare size={13} /> Output</button>
                    <button className="nodeSmallButton" onMouseDown={(event) => event.preventDefault()} onClick={() => addOutputFromSelection(message)}><CheckSquare size={13} /> Selection Output</button>
                    {inputs.length > 0 ? <button className="nodeSmallButton" onClick={() => insertSelectedInput(message.id)}>Insert Input After</button> : null}
                  </footer>
                </article>
              ))}
            </div>
            <div className="dialogueComposer">
              {draftAttachments.length > 0 ? (
                <div className="dialogueComposerAttachments">
                  {draftAttachments.map((part, index) => (
                    <div className="dialogueAttachmentThumb" key={`${part.type}-${index}`}>
                      <DialoguePartView part={part} compact />
                      <button className="iconButton" type="button" title="Remove attachment" onClick={() => removeDraftAttachment(index)}><X size={12} /></button>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} placeholder="Write a message" />
              <div className="dialogueComposerActions">
                <select value={draftRole} onChange={(event) => setDraftRole(event.target.value as DialogueMessage["role"])}>
                  <option value="user">user note</option>
                  <option value="assistant">assistant note</option>
                  <option value="system">system note</option>
                  <option value="tool">tool note</option>
                </select>
                <button onClick={() => addMessage()} disabled={!draftText.trim() && draftAttachments.length === 0}>Add Manual Note</button>
                <button className="primary" onClick={() => void askModel()} disabled={(!draftText.trim() && draftAttachments.length === 0) || assistantBusy}>
                  {assistantBusy ? "Sending..." : "Send to Model"}
                </button>
              </div>
              {assistantError ? <div className="dialogueError">{assistantError}</div> : null}
            </div>
          </section>
          <aside className="dialogueOutputsPane">
            <h3>Model</h3>
            <div className="dialogueModelPanel">
              <label>
                <span>Model</span>
                <button className="dialogueModelPickerToggle" type="button" onClick={() => setModelPickerOpen((value) => !value)}>
                  {selectedProfile ? <ModelLogoMark logo={modelLogoFor(selectedProfile.providerId, selectedProfile.modelId, selectedProfile.id)} /> : null}
                  <span>
                    <strong>{selectedProfile?.displayName ?? "No model selected"}</strong>
                    {selectedProfile ? <small>{selectedProfile.providerId}/{selectedProfile.modelId}</small> : null}
                  </span>
                  {selectedProfile ? <ModelCapabilityBadges profile={selectedProfile} /> : null}
                  {modelPickerOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              </label>
              <button className="nodeSmallButton" type="button" onClick={saveCurrentModelAsDefault}>Save as Default</button>
              {modelSavedMessage ? <small>{modelSavedMessage}</small> : null}
              {modelPickerOpen ? (
                <>
                  <label>
                    <span>Search models</span>
                    <input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="provider, model, capability" />
                  </label>
                  <div className="dialogueModelList">
                    {visibleModelProfiles.map((profile) => (
                      <button
                        className={`dialogueModelOption ${profile.id === selectedModelProfileId ? "selected" : ""}`}
                        key={profile.id}
                        type="button"
                        onClick={() => {
                          chooseModelProfile(profile.id);
                          setModelPickerOpen(false);
                        }}
                      >
                        <ModelLogoMark logo={modelLogoFor(profile.providerId, profile.modelId, profile.id)} />
                        <span>
                          <strong>{profile.displayName}</strong>
                          <small>{profile.providerId}/{profile.modelId}</small>
                        </span>
                        <ModelCapabilityBadges profile={profile} />
                      </button>
                    ))}
                    {visibleModelProfiles.length === 0 ? <p className="muted">No dialogue models match this search.</p> : null}
                  </div>
                </>
              ) : null}
              <label>
                <span>Agent preset</span>
                <select value={state.agentPresetId ?? ""} onChange={(event) => persist({ ...state, agentPresetId: event.target.value || undefined })}>
                  <option value="">none</option>
                  {agentPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.displayName}</option>)}
                </select>
              </label>
              {selectedProfile ? (
                <div className="modelProfileSummary">
                  <strong>{selectedProfile.costClass ?? "unknown"} · {selectedProfile.privacyClass ?? "unknown"}</strong>
                  <span>{selectedProfile.capabilities.join(", ") || "no declared capabilities"}</span>
                </div>
              ) : null}
              {modelVisionWarning ? <div className="dialogueWarning">Эта модель не поддерживает изображения. Она получит только текстовые части/refs.</div> : null}
            </div>
            <h3>Selected Outputs</h3>
            {state.selectedOutputs.map((output) => (
              <div className="dialogueOutputItem" key={output.id}>
                <input value={output.name} onChange={(event) => patchOutput(output.id, { name: event.target.value })} />
                <div className="dialogueOutputControls">
                  <select value={output.type} onChange={(event) => patchOutput(output.id, { type: event.target.value as DialogueOutputType })}>
                    {(["text", "image", "json", "file"] as DialogueOutputType[]).map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                  <select value={output.status} onChange={(event) => patchOutput(output.id, { status: event.target.value as DialogueOutputStatus })}>
                    {(["draft", "selected", "locked"] as DialogueOutputStatus[]).map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                </div>
                <textarea value={typeof output.value === "string" ? output.value : JSON.stringify(output.value ?? output.assetRef ?? "", null, 2)} onChange={(event) => patchOutput(output.id, { value: event.target.value })} />
                {output.status === "locked" ? <small><Lock size={12} /> Locked value is used by the graph.</small> : <small>{output.status} value is saved and visible as a port.</small>}
              </div>
            ))}
            <div className="dialogueManualOutput">
              <input value={outputDraft.name} onChange={(event) => setOutputDraft({ ...outputDraft, name: event.target.value })} placeholder="output name" />
              <select value={outputDraft.type} onChange={(event) => setOutputDraft({ ...outputDraft, type: event.target.value as DialogueOutputType })}>
                {(["text", "image", "json", "file"] as DialogueOutputType[]).map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              <textarea value={outputDraft.value} onChange={(event) => setOutputDraft({ ...outputDraft, value: event.target.value })} placeholder="output value" />
              <button onClick={addManualOutput}><Plus size={14} /> Add Output</button>
            </div>
            <h3>System Outputs</h3>
            <div className="dialogueSystemOutputs">
              <strong>conversation_text</strong>
              <pre>{previewOutputs.conversation_text}</pre>
              <strong>conversation_json</strong>
              <pre>{JSON.stringify(previewOutputs.conversation_json, null, 2)}</pre>
              <strong>conversation_capsule</strong>
              <pre>{JSON.stringify(previewOutputs.conversation_capsule, null, 2)}</pre>
              <button onClick={updateCapsuleSummary}>Generate/Update Capsule Summary</button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function DialoguePartView({ part, compact = false, renderMarkdown = false }: { part: DialogueContentPart; compact?: boolean; renderMarkdown?: boolean }) {
  if (part.type === "text") {
    const backgroundSrc = part.chipBackgroundAssetRef ? imagePreviewSrc(part.chipBackgroundAssetRef) : null;
    if (backgroundSrc && !renderMarkdown) return <TextChipView text={part.text} backgroundSrc={backgroundSrc} compact={compact} accentColor={dialoguePartAccentColor(part)} />;
    if (!renderMarkdown && dialoguePartIsChip(part)) return <TextChipView text={part.text} compact={compact} accentColor={dialoguePartAccentColor(part)} />;
    return renderMarkdown ? <MarkdownDocument content={part.text} /> : <p>{part.text}</p>;
  }
  if (part.type === "image") {
    const src = imagePreviewSrc(part.assetRef);
    return src ? <img className={`dialogueMessageImage ${compact ? "compact" : ""}`} src={src} alt={part.alt ?? "dialogue image"} /> : <p>image: {part.assetRef}</p>;
  }
  if (part.type === "file") return <p>file: {part.filename ?? part.assetRef}</p>;
  return <pre>{JSON.stringify(part.value, null, 2)}</pre>;
}

function DialogueInputPreview({ input }: { input: DialogueConnectedInput }) {
  const chipBackgroundSrc = input.type === "text" && input.chipBackgroundAssetRef ? imagePreviewSrc(input.chipBackgroundAssetRef) : null;
  if (chipBackgroundSrc) return <TextChipView text={input.preview} backgroundSrc={chipBackgroundSrc} accentColor={input.sourceAccentColor} />;
  if (input.type === "text") return <TextChipView text={input.preview} accentColor={input.sourceAccentColor} />;
  const src = input.type === "image" ? imagePreviewSrc(input.value) ?? imagePreviewSrc(input.preview) : null;
  if (src) return <img className="dialogueInputImage" src={src} alt={input.id} />;
  return <pre>{input.preview}</pre>;
}

function TextChipView({ text, backgroundSrc, compact = false, accentColor = "#7dd3c0" }: { text: string; backgroundSrc?: string | null; compact?: boolean; accentColor?: string }) {
  const [expanded, setExpanded] = useState(false);
  const backgroundImage = backgroundSrc && !expanded ? `linear-gradient(rgba(13, 17, 24, 0.9), rgba(13, 17, 24, 0.92)), url(${backgroundSrc})` : undefined;
  return (
    <button
      className={`dialogueTextChip ${compact ? "compact" : ""} ${expanded ? "expanded" : ""}`.trim()}
      style={{ "--dialogue-text-chip-accent": accentColor, backgroundImage } as React.CSSProperties}
      type="button"
      aria-expanded={expanded}
      aria-label={expanded ? "Collapse text chip" : "Expand text chip"}
      title={text}
      onClick={() => setExpanded((value) => !value)}
    >
      {expanded ? <pre>{text}</pre> : (
        <>
          <span aria-hidden="true">T</span>
          <pre>{text}</pre>
        </>
      )}
    </button>
  );
}

function dialoguePartAccentColor(part: DialogueContentPart): string | undefined {
  const value = (part as DialogueContentPart & { sourceAccentColor?: unknown }).sourceAccentColor;
  return typeof value === "string" ? value : undefined;
}

function dialoguePartIsChip(part: DialogueContentPart): boolean {
  return Boolean((part as DialogueContentPart & { sourceAccentColor?: unknown }).sourceAccentColor);
}

function dialogueContentPartFromInput(input: DialogueConnectedInput): DialogueDraftContentPart {
  if (input.type === "image") return { type: "image", assetRef: imageAssetRef(input.value) ?? input.preview, alt: input.id };
  if (input.type === "file") return { type: "file", assetRef: imageAssetRef(input.value) ?? input.preview, filename: input.id };
  if (input.type === "text") return { type: "text", text: input.preview, chipBackgroundAssetRef: input.chipBackgroundAssetRef, sourceAccentColor: input.sourceAccentColor };
  return { type: "json", value: input.value };
}

function dialogueMessageContent(text: string, attachments: DialogueDraftContentPart[] = []): DialogueContentPart[] {
  return [
    ...(text.trim() ? [{ type: "text" as const, text }] : []),
    ...attachments.map(stripDialoguePartUi)
  ];
}

function stripDialoguePartUi(part: DialogueDraftContentPart): DialogueContentPart {
  const { sourceAccentColor: _sourceAccentColor, ...portablePart } = part;
  return portablePart;
}

function autoAttachImagesForModel(inputs: DialogueConnectedInput[], profile: ModelProfile): DialogueContentPart[] {
  if (!profile.capabilities.includes("vision")) return [];
  const imageInput = inputs.find((input) => input.type === "image");
  return imageInput ? [dialogueContentPartFromInput(imageInput)] : [];
}

function imageRefsFromContent(content: DialogueContentPart[]): string[] {
  return content
    .filter((part): part is Extract<DialogueContentPart, { type: "image" }> => part.type === "image")
    .map((part) => part.assetRef)
    .filter((assetRef) => assetRef.trim().length > 0);
}

function scrollDialogueMessageIntoView(messageId: string) {
  const element = document.getElementById(`dialogue-message-${messageId}`);
  element?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function imageAssetRef(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return imageAssetRef(record.image ?? record.localPath ?? record.path ?? record.originalUrl ?? record.url ?? record.output);
  }
  return null;
}

function createDialogueTextMessage(options: {
  role: DialogueMessage["role"];
  text: string;
  content?: DialogueContentPart[];
  modelProfileId?: string;
  profile?: ModelProfile;
  providerUsage?: Record<string, unknown> | null;
  params?: Record<string, unknown>;
}): DialogueMessage {
  return {
    id: `message_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`,
    role: options.role,
    content: options.content ?? [{ type: "text", text: options.text }],
    createdAt: new Date().toISOString(),
    modelProfileId: options.modelProfileId,
    actualProviderId: stringFromRecord(options.providerUsage, "provider") ?? options.profile?.providerId,
    actualModelId: stringFromRecord(options.providerUsage, "model") ?? options.profile?.modelId,
    params: options.params,
    costEstimate: numberFromRecord(options.providerUsage, "estimatedCost") ?? undefined
  };
}

function dialoguePromptForModel(options: {
  state: DialogueWorkbenchState;
  inputs: Array<{ id: string; type: PortKind; sourceNodeId: string; sourcePort?: string; preview: string }>;
  userText: string;
}): string {
  const inputText = options.inputs
    .filter((input) => input.type !== "conversation_context")
    .map((input) => `[${input.type}:${input.id}] ${input.preview}`)
    .join("\n\n");
  const capsules = options.inputs
    .filter((input) => input.type === "conversation_context")
    .map((input) => `[context:${input.id}] ${input.preview}`)
    .join("\n\n");
  const recentMessages = options.state.messages.slice(-12).map((message) => `${message.role}: ${message.content.map(partText).join(" ")}`).join("\n");
  return [
    capsules ? `Conversation context:\n${capsules}` : "",
    inputText ? `Connected inputs:\n${inputText}` : "",
    recentMessages ? `Recent dialogue:\n${recentMessages}` : "",
    `User message:\n${options.userText}`
  ].filter(Boolean).join("\n\n");
}

function modelIdForProfile(profile: ModelProfile): string {
  if (profile.id.startsWith("openrouter:")) return profile.modelId;
  if (profile.providerId === "openrouter") return profile.modelId;
  return profile.id === "text.default" ? "text.default" : profile.modelId;
}

function providerModeForProfile(profile: ModelProfile): string {
  if (profile.providerId === "openrouter") return "openrouter";
  if (profile.providerId === "gemini") return "direct";
  return "auto";
}

function firstRunError(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const nodeResults = (result as Record<string, unknown>).nodeResults;
  if (!nodeResults || typeof nodeResults !== "object") return null;
  const failed = Object.values(nodeResults as Record<string, unknown>).find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).error);
  return failed && typeof failed === "object" ? String((failed as Record<string, unknown>).error ?? "") : null;
}

function stringFromRecord(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstStringFromRecord(record: Record<string, unknown> | null | undefined, preferredKeys: string[]): string | undefined {
  for (const key of preferredKeys) {
    const value = stringFromRecord(record, key);
    if (value) return value;
  }
  const value = Object.values(record ?? {}).find((entry) => typeof entry === "string" && entry.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

function numberFromRecord(record: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ChooseCameraPointParams({
  params,
  inputImage,
  onConfigureWorldLabs,
  onPublishNodeOutput,
  onChange,
  onOpenImage
}: {
  params: Record<string, unknown>;
  inputImage?: unknown;
  onConfigureWorldLabs?: () => void;
  onPublishNodeOutput?: (output: Record<string, unknown>) => void;
  onChange: (patch: Record<string, unknown>) => void;
  onOpenImage?: (image: ImageViewerState) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [splatViewerOpen, setSplatViewerOpen] = useState(false);
  const [splatViewerFloating, setSplatViewerFloating] = useState(false);
  const autoFetchRef = useRef("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [view, setView] = useState({
    yaw: numberParamValue(cameraPoseRecord(params).rotation?.yaw, 0),
    pitch: numberParamValue(cameraPoseRecord(params).rotation?.pitch, 0),
    fov: numberParamValue(params.fov, 70)
  });
  const [cameraPosition, setCameraPosition] = useState(() => {
    const position = cameraPoseRecord(params).position;
    return {
      x: numberParamValue(position?.x, 0),
      y: numberParamValue(position?.y, 0),
      z: numberParamValue(position?.z, 0)
    };
  });
  const sourceImage = params.image ?? params.sourceImage ?? params.sourceImageUrl ?? params.sourceImagePath ?? inputImage;
  const source = imagePreviewSrc(sourceImage);
  const sourcePath = imageLocalPath(sourceImage);
  const pinnedMarbleWorld = recordParam(params.pinnedMarbleWorld);
  const marbleWorld = Object.keys(pinnedMarbleWorld).length > 0 ? pinnedMarbleWorld : recordParam(params.marbleWorld);
  const marbleWorldPinned = Object.keys(pinnedMarbleWorld).length > 0;
  const marbleWorldId = stringFromRecord(marbleWorld, "worldId") ?? stringFromRecord(marbleWorld, "world_id");
  const marbleOperationId = stringFromRecord(marbleWorld, "operationId") ?? stringFromRecord(marbleWorld, "operation_id") ?? stringFromRecord(marbleWorld, "name");
  const generationStatus = String(marbleWorld.generationStatus ?? (marbleWorldId ? "ready" : "no world"));
  const worldMarbleUrl = stringFromRecord(marbleWorld, "worldMarbleUrl") ?? stringFromRecord(marbleWorld, "world_marble_url");
  const worldPanoUrl = worldPanoramaUrl(marbleWorld);
  const worldSplatUrl = worldSplatAssetUrl(marbleWorld);
  const effectiveWorldMarbleUrl = worldMarbleUrl ?? (marbleWorldId ? `https://marble.worldlabs.ai/world/${encodeURIComponent(marbleWorldId)}` : null);
  const viewerSource = worldPanoUrl ?? source;
  const worldLabsKeyMissing = /WORLDS_API_KEY|World Labs API key is not configured/i.test(error);
  const sourceImageHash = String(params.sourceImageHash ?? sourcePath ?? source ?? "");
  const cachedSourceHash = String(marbleWorld.sourceImageHash ?? "");
  const cachedWorldStale = Boolean(cachedSourceHash && sourceImageHash && cachedSourceHash !== sourceImageHash);
  const resolution = resolutionFromParam(params.resolution, params.output);

  useEffect(() => {
    if (!viewerOpen || !viewerSource) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      imageRef.current = image;
      draw();
    };
    image.onerror = () => setError("Could not load panorama preview.");
    image.src = viewerSource;
  }, [viewerOpen, viewerSource]);

  useEffect(() => {
    if (viewerOpen) draw();
  }, [viewerOpen, view.yaw, view.pitch, view.fov, resolution.width, resolution.height]);

  useEffect(() => {
    if (!worldSplatUrl) return;
    setSplatViewerOpen(true);
  }, [worldSplatUrl]);

  useEffect(() => {
    if (!marbleOperationId || generationStatus !== "generating") return;
    const poll = () => void pollOperation();
    const timeout = window.setTimeout(poll, 1200);
    const interval = window.setInterval(poll, 5000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [marbleOperationId, generationStatus]);

  useEffect(() => {
    if (!marbleWorldId || worldSplatUrl) return;
    if (generationStatus !== "ready" && generationStatus !== "world loaded") return;
    const key = `${marbleWorldId}:${generationStatus}`;
    if (autoFetchRef.current === key) return;
    autoFetchRef.current = key;
    const timeout = window.setTimeout(() => void fetchCurrentMarbleWorld(), 500);
    return () => window.clearTimeout(timeout);
  }, [marbleWorldId, generationStatus, worldSplatUrl]);

  function draw() {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    canvas.width = resolution.width;
    canvas.height = resolution.height;
    renderPanoramaFrame(canvas, image, {
      yaw: degreesToRadians(view.yaw),
      pitch: degreesToRadians(view.pitch),
      fov: view.fov
    });
  }

  function currentCameraPose() {
    return {
      position: cameraPosition,
      rotation: { yaw: view.yaw, pitch: view.pitch, roll: numberParamValue(recordParam(recordParam(params.cameraPose).rotation).roll, 0) },
      fov: view.fov
    };
  }

  function togglePinnedWorld() {
    if (marbleWorldPinned) {
      onChange({ pinnedMarbleWorld: undefined, pinnedMarbleWorldAt: undefined });
      setStatus("world unpinned");
      return;
    }
    if (!marbleWorldId && !marbleOperationId) {
      setError("Create or poll a Marble world before pinning it.");
      return;
    }
    onChange({ pinnedMarbleWorld: marbleWorld, pinnedMarbleWorldAt: new Date().toISOString() });
    setStatus("world pinned");
  }

  function moveCamera(key: string) {
    const normalized = key.toLowerCase();
    const rotationStep = 5;
    const moveStep = 0.25;
    if (normalized === "arrowleft") {
      setView((current) => ({ ...current, yaw: wrapDegrees(current.yaw - rotationStep) }));
      return true;
    }
    if (normalized === "arrowright") {
      setView((current) => ({ ...current, yaw: wrapDegrees(current.yaw + rotationStep) }));
      return true;
    }
    if (normalized === "arrowup") {
      setView((current) => ({ ...current, pitch: clamp(current.pitch + rotationStep, -89, 89) }));
      return true;
    }
    if (normalized === "arrowdown") {
      setView((current) => ({ ...current, pitch: clamp(current.pitch - rotationStep, -89, 89) }));
      return true;
    }
    if (!["w", "a", "s", "d", "q", "e"].includes(normalized)) return false;
    const yaw = degreesToRadians(view.yaw);
    const forward = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const delta =
      normalized === "w" ? { x: forward.x * moveStep, y: 0, z: forward.z * moveStep } :
      normalized === "s" ? { x: -forward.x * moveStep, y: 0, z: -forward.z * moveStep } :
      normalized === "d" ? { x: right.x * moveStep, y: 0, z: right.z * moveStep } :
      normalized === "a" ? { x: -right.x * moveStep, y: 0, z: -right.z * moveStep } :
      normalized === "e" ? { x: 0, y: moveStep, z: 0 } :
      { x: 0, y: -moveStep, z: 0 };
    setCameraPosition((current) => {
      const next = {
        x: roundCameraCoordinate(current.x + delta.x),
        y: roundCameraCoordinate(current.y + delta.y),
        z: roundCameraCoordinate(current.z + delta.z)
      };
      setStatus(`position ${next.x}, ${next.y}, ${next.z}`);
      return next;
    });
    return true;
  }

  async function generateWorld() {
    setError("");
    if (!source && !sourcePath) {
      setError("Connect or set a 360 equirectangular panorama image before generating a Marble world.");
      return;
    }
    setIsGenerating(true);
    setStatus("uploading panorama");
    onChange({ marbleWorld: { ...marbleWorld, provider: "worldlabs-marble", model: String(params.model ?? "marble-1.0-draft"), sourceImageHash, generationStatus: "generating" } });
    try {
      const response = await apiFetch(`${apiBase}/api/worldlabs/marble/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imagePath: sourcePath || undefined,
          imageUrl: !sourcePath && source && /^https?:\/\//i.test(source) ? source : undefined,
          isPano: true,
          model: String(params.model ?? "marble-1.0-draft"),
          sourceImageHash,
          displayName: "SnarkRoute Choose Camera Point"
        })
      });
      setStatus("waiting for World Labs");
      const body = await response.json();
      if (!response.ok) throw new Error(String(body.error ?? "Marble generation failed."));
      const operationId = String(body.operation_id ?? body.name ?? body.operationId ?? body.id ?? "");
      const world = worldRecordFromResponse(body);
      const worldId = String(world.world_id ?? world.worldId ?? body.metadata?.world_id ?? body.world_id ?? body.worldId ?? "");
      const worldUrl = String(world.world_marble_url ?? world.worldMarbleUrl ?? "");
      const nextWorld = { ...marbleWorld, ...world, provider: "worldlabs-marble", model: String(params.model ?? "marble-1.0-draft"), sourceImageHash, operation_id: operationId, operationId, world_id: worldId, worldId, worldMarbleUrl: worldUrl, createdAt: new Date().toISOString(), generationStatus: body.done === true || worldUrl ? "ready" : "generating", operation: body };
      onChange({ marbleWorld: nextWorld });
      setStatus(String(nextWorld.generationStatus));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setStatus("failed");
      onChange({ marbleWorld: { ...marbleWorld, generationStatus: "failed", error: message } });
    } finally {
      setIsGenerating(false);
    }
  }

  async function pollOperation() {
    const operationId = marbleOperationId ?? "";
    if (!operationId) return;
    setError("");
    try {
      const response = await apiFetch(`${apiBase}/api/worldlabs/marble/operations/${encodeURIComponent(operationId)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(String(body.error ?? "Could not poll Marble operation."));
      const done = body.done === true || body.status === "done" || body.status === "succeeded";
      const world = worldRecordFromResponse(body);
      const worldId = String(world.world_id ?? world.worldId ?? body.metadata?.world_id ?? body.world_id ?? marbleWorld.worldId ?? "");
      let completeWorld = world;
      if (done && worldId && !stringFromRecord(world, "world_marble_url") && !stringFromRecord(world, "worldMarbleUrl")) {
        completeWorld = await fetchMarbleWorld(worldId);
      }
      onChange({ marbleWorld: { ...marbleWorld, ...completeWorld, operation: body, world_id: worldId, worldId, worldMarbleUrl: String(completeWorld.world_marble_url ?? completeWorld.worldMarbleUrl ?? marbleWorld.worldMarbleUrl ?? ""), generationStatus: done ? "ready" : "generating" } });
      setStatus(done ? "ready" : "generating");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function fetchMarbleWorld(worldId: string): Promise<Record<string, unknown>> {
    const response = await apiFetch(`${apiBase}/api/worldlabs/marble/worlds/${encodeURIComponent(worldId)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(String(body.error ?? "Could not fetch Marble world."));
    return worldRecordFromResponse(body);
  }

  async function fetchCurrentMarbleWorld() {
    if (!marbleWorldId) return;
    setError("");
    setStatus("fetching Marble world");
    try {
      const completeWorld = await fetchMarbleWorld(marbleWorldId);
      const worldUrl = String(completeWorld.world_marble_url ?? completeWorld.worldMarbleUrl ?? "");
      onChange({ marbleWorld: { ...marbleWorld, ...completeWorld, worldId: marbleWorldId, worldMarbleUrl: worldUrl, generationStatus: worldUrl ? "ready" : generationStatus } });
      setStatus(worldUrl ? "ready" : "world loaded");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("failed");
    }
  }

  function saveCameraPose() {
    onChange({ cameraPose: currentCameraPose(), fov: view.fov, output: { mode: String(params.outputMode ?? "perspective"), width: resolution.width, height: resolution.height } });
    setStatus("camera saved");
  }

  async function renderFrame() {
    draw();
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dataUrl = "";
    try {
      dataUrl = canvas.toDataURL("image/png");
    } catch {
      setError("Could not export this panorama frame. Save the camera point or open the 360 panorama directly.");
      return;
    }
    const dataBase64 = dataUrl.split(",")[1] ?? "";
    const response = await fetch(`${apiBase}/api/assets/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "image", filename: "choose-camera-point.png", dataBase64 })
    });
    const body = await response.json();
    if (!response.ok) {
      setError(String(body.error ?? "Could not save rendered frame."));
      return;
    }
    const renderedImage = body.metadata ?? { path: body.path };
    onChange({ renderedImage, outputImage: renderedImage, cameraPose: currentCameraPose(), output: { mode: "perspective", width: resolution.width, height: resolution.height } });
    onOpenImage?.({ src: imagePreviewSrc(renderedImage) ?? dataUrl, title: "Choose Camera Point render", filename: "choose-camera-point.png" });
  }

  return (
    <div className="chooseCameraParams">
      {source ? <button className="nodeImagePreviewButton nodrag nopan" type="button" title="Input panorama preview" onClick={() => onOpenImage?.({ src: source, title: "Input panorama", filename: downloadFilename(sourceImage) })}><img className="nodeImagePreview" src={source} alt="" /></button> : null}
      {!source ? <div className="nodeWarning">На первом этапе поддерживаются только 360 equirectangular panoramas. Set params.image/sourceImagePath or connect a prepared image output.</div> : null}
      {cachedWorldStale ? <div className="nodeWarning">Исходное изображение изменилось. Черновой мир может больше не соответствовать входной панораме.</div> : null}
      {error ? worldLabsKeyMissing && onConfigureWorldLabs ? (
        <button className="nodeWarning nodeWarningButton nodrag nopan" type="button" onClick={onConfigureWorldLabs}>{error}</button>
      ) : <div className="nodeWarning">{error}</div> : null}
      <label className="nodeField">
        <span>Marble model</span>
        <select className="nodrag nopan nodeInput nodeSelect" value={String(params.model ?? "marble-1.0-draft")} onChange={(event) => onChange({ model: event.target.value })}>
          <option value="marble-1.0-draft">Draft</option>
          <option value="marble-1.1">Standard</option>
        </select>
      </label>
      <label className="nodeField">
        <span>resolution</span>
        <select className="nodrag nopan nodeInput nodeSelect" value={String(params.resolution ?? "1536x864")} onChange={(event) => onChange({ resolution: event.target.value })}>
          <option value="1024x576">1024x576</option>
          <option value="1536x864">1536x864</option>
          <option value="2048x1152">2048x1152</option>
        </select>
      </label>
      <div className="nodeMetaLine">status: {status || generationStatus}</div>
      {marbleWorldPinned ? <div className="nodeMetaLine">pinned world: {String(marbleWorldId ?? marbleOperationId ?? "cached")}</div> : null}
      <div className="nodeActionRow">
        <button className="nodeSmallButton nodrag nopan" type="button" disabled={isGenerating || !source} onClick={generateWorld}><Globe size={13} /> {isGenerating ? "Создаю мир..." : "Создать черновой мир"}</button>
        <button className={`nodeSmallButton nodrag nopan ${marbleWorldPinned ? "pinned" : ""}`} type="button" aria-pressed={marbleWorldPinned} disabled={!marbleWorldId && !marbleOperationId} onClick={togglePinnedWorld}><Pin size={13} /> {marbleWorldPinned ? "Мир закреплен" : "Запинить мир"}</button>
        {effectiveWorldMarbleUrl ? (
          <a className="nodeSmallButton nodrag nopan" href={effectiveWorldMarbleUrl} target="_blank" rel="noreferrer"><Eye size={13} /> Открыть 3D viewer</a>
        ) : (
          <button className="nodeSmallButton nodrag nopan" type="button" disabled={!viewerSource} onClick={() => setViewerOpen((value) => !value)}><Eye size={13} /> Открыть viewer</button>
        )}
        {worldPanoUrl ? <button className="nodeSmallButton nodrag nopan" type="button" onClick={() => setViewerOpen((value) => !value)}><Aperture size={13} /> 360 из мира</button> : null}
      </div>
      {splatViewerOpen && worldSplatUrl ? (
        <WorldSplatViewer
          splatUrl={worldSplatUrl}
          initialCameraPose={currentCameraPose()}
          floating={splatViewerFloating}
          onToggleFloating={() => setSplatViewerFloating((value) => !value)}
          onPublishOutputs={async ({ pose, viewDataUrl, panoramaDataUrl }) => {
            const [viewImage, panoramaImage] = await Promise.all([
              importImageDataUrl(viewDataUrl, "choose-camera-splat-view.png"),
              importImageDataUrl(panoramaDataUrl, "choose-camera-splat-panorama.png")
            ]);
            onChange({
              cameraPose: pose,
              fov: pose.fov,
              renderedImage: viewImage,
              outputImage: viewImage,
              renderedPanorama: panoramaImage,
              panoramaImage,
              output: { mode: String(params.outputMode ?? "perspective"), width: resolution.width, height: resolution.height, panoramaProjection: "equirectangular" }
            });
            onPublishNodeOutput?.({
              image: viewImage,
              view: viewImage,
              panorama: panoramaImage,
              panoramaMetadata: { projection: "equirectangular" },
              cameraPose: pose,
              output: { mode: String(params.outputMode ?? "perspective"), width: resolution.width, height: resolution.height, panoramaProjection: "equirectangular" },
              marbleWorld
            });
            setCameraPosition(pose.position);
            setView((current) => ({ ...current, yaw: pose.rotation.yaw, pitch: pose.rotation.pitch, fov: pose.fov }));
            setStatus("view + 360 published");
          }}
        />
      ) : null}
      {viewerOpen ? (
        <div className="chooseCameraViewer">
          <>
          <canvas
            ref={canvasRef}
            className="chooseCameraCanvas nodrag nopan"
            tabIndex={0}
            title="Drag to look around. WASD moves the saved camera point; arrows rotate."
            onPointerEnter={(event) => event.currentTarget.focus()}
            onPointerDown={(event) => {
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = { x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch };
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag) return;
              setView((current) => ({
                ...current,
                yaw: wrapDegrees(drag.yaw - (event.clientX - drag.x) * 0.35),
                pitch: clamp(drag.pitch + (event.clientY - drag.y) * 0.28, -89, 89)
              }));
            }}
            onPointerUp={(event) => {
              dragRef.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              dragRef.current = null;
            }}
            onWheel={(event) => {
              event.preventDefault();
              setView((current) => ({ ...current, fov: clamp(current.fov + Math.sign(event.deltaY) * 5, 35, 120) }));
            }}
            onKeyDown={(event) => {
              if (!moveCamera(event.key)) return;
              event.preventDefault();
            }}
          />
          <div className="nodeMetaLine">camera: x {cameraPosition.x}, y {cameraPosition.y}, z {cameraPosition.z}</div>
          <NodeSliderParam id="yaw" label="yaw" min={-180} max={180} step={1} value={view.yaw} onChange={(patch) => setView((current) => ({ ...current, yaw: numberParamValue(patch.yaw, current.yaw) }))} />
          <NodeSliderParam id="pitch" label="pitch" min={-90} max={90} step={1} value={view.pitch} onChange={(patch) => setView((current) => ({ ...current, pitch: numberParamValue(patch.pitch, current.pitch) }))} />
          <NodeSliderParam id="fov" label="fov" min={35} max={120} step={1} value={view.fov} onChange={(patch) => setView((current) => ({ ...current, fov: numberParamValue(patch.fov, current.fov) }))} />
          </>
          <div className="nodeActionRow">
            <button className="nodeSmallButton nodrag nopan" type="button" onClick={saveCameraPose}><Save size={13} /> Сохранить точку</button>
            <button className="nodeSmallButton nodrag nopan" type="button" onClick={renderFrame}><Aperture size={13} /> Отрендерить кадр</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

async function importImageDataUrl(dataUrl: string, filename: string): Promise<unknown> {
  const dataBase64 = dataUrl.split(",")[1] ?? "";
  const response = await apiFetch(`${apiBase}/api/assets/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "image", filename, dataBase64 })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(String(body.error ?? `Could not save ${filename}.`));
  return body.metadata ?? { path: body.path };
}

function WorldSplatViewer({
  splatUrl,
  initialCameraPose,
  floating,
  onToggleFloating,
  onPublishOutputs
}: {
  splatUrl: string;
  initialCameraPose: SavedCameraPose;
  floating: boolean;
  onToggleFloating: () => void;
  onPublishOutputs: (outputs: { pose: SavedCameraPose; viewDataUrl: string; panoramaDataUrl: string }) => Promise<void>;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const splatRuntimeRef = useRef<SplatRuntime | null>(null);
  const latestPoseRef = useRef<SavedCameraPose>(initialCameraPose);
  const [loadStatus, setLoadStatus] = useState("loading splat");
  const [isPublishing, setIsPublishing] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let renderer: import("three").WebGLRenderer | null = null;
    let scene: import("three").Scene | null = null;
    let splat: { dispose?: () => void } | null = null;
    let spark: import("three").Object3D | null = null;
    let resizeObserver: ResizeObserver | null = null;

    void (async () => {
      const [THREE, sparkModule] = await Promise.all([import("three"), import("@sparkjsdev/spark")]);
      if (disposed) return;

      const { SparkControls, SparkRenderer, SplatMesh } = sparkModule;
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x090d14);

      const camera = new THREE.PerspectiveCamera(initialCameraPose.fov || 70, 1, 0.01, 1000);
      const control = new THREE.Object3D();
      control.position.set(initialCameraPose.position.x, initialCameraPose.position.y, initialCameraPose.position.z);
      control.rotation.set(degreesToRadians(initialCameraPose.rotation.pitch), degreesToRadians(initialCameraPose.rotation.yaw), degreesToRadians(initialCameraPose.rotation.roll), "YXZ");
      control.add(camera);
      scene.add(control);

      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.className = "chooseCameraSplatCanvas nodrag nopan";
      renderer.domElement.tabIndex = 0;
      mount.appendChild(renderer.domElement);

      spark = new SparkRenderer({ renderer });
      scene.add(spark);

      splat = new SplatMesh({
        url: splatUrl,
        onLoad: () => {
          if (!disposed) setLoadStatus("splat ready");
        },
        onProgress: (event: ProgressEvent) => {
          if (disposed || !event.lengthComputable || event.total <= 0) return;
          setLoadStatus(`loading splat ${Math.round((event.loaded / event.total) * 100)}%`);
        }
      });
      (splat as unknown as import("three").Object3D).quaternion.set(1, 0, 0, 0);
      scene.add(splat as unknown as import("three").Object3D);

      const controls = new SparkControls({ canvas: renderer.domElement });
      controls.fpsMovement.moveSpeed = 1.25;

      const resize = () => {
        if (!renderer) return;
        const rect = mount.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(mount);
      resize();

      const euler = new THREE.Euler(0, 0, 0, "YXZ");
      renderer.setAnimationLoop(() => {
        if (!renderer || !scene) return;
        controls.update(control, camera);
        renderer.render(scene, camera);
        euler.setFromQuaternion(control.quaternion, "YXZ");
        latestPoseRef.current = {
          position: {
            x: roundCameraCoordinate(control.position.x),
            y: roundCameraCoordinate(control.position.y),
            z: roundCameraCoordinate(control.position.z)
          },
          rotation: {
            yaw: wrapDegrees(radiansToDegrees(euler.y)),
            pitch: clamp(radiansToDegrees(euler.x), -89, 89),
            roll: radiansToDegrees(euler.z)
          },
          fov: camera.fov
        };
      });

      splatRuntimeRef.current = { renderer, scene, camera, control };
      renderer.domElement.focus();
    })().catch((caught) => {
      if (!disposed) setLoadStatus(caught instanceof Error ? caught.message : String(caught));
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      renderer?.setAnimationLoop(null);
      if (scene && splat) scene.remove(splat as unknown as import("three").Object3D);
      if (scene && spark) scene.remove(spark);
      splatRuntimeRef.current = null;
      splat?.dispose?.();
      renderer?.dispose();
      renderer?.domElement.remove();
    };
  }, [splatUrl]);

  async function publishCurrentOutputs() {
    const runtime = splatRuntimeRef.current;
    if (isPublishing) return;
    if (!runtime) {
      setLoadStatus("splat viewer is not ready yet");
      return;
    }
    setIsPublishing(true);
    setLoadStatus("rendering view + 360");
    try {
      const viewDataUrl = captureCurrentSplatView(runtime);
      const panoramaDataUrl = await renderSplatPanorama(runtime, mountRef.current);
      await onPublishOutputs({ pose: latestPoseRef.current, viewDataUrl, panoramaDataUrl });
      setLoadStatus("view + 360 published");
    } catch (caught) {
      setLoadStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsPublishing(false);
    }
  }

  return (
    <div
      className={`chooseCameraSplatViewer ${floating ? "floating" : ""}`}
      onPointerEnter={() => splatRuntimeRef.current?.renderer.domElement.focus()}
      onClick={() => splatRuntimeRef.current?.renderer.domElement.focus()}
    >
      <div ref={mountRef} className="chooseCameraSplatMount" />
      <div className="nodeMetaLine">{loadStatus}</div>
      <div className="nodeActionRow">
        <button className="nodeSmallButton nodrag nopan" type="button" disabled={isPublishing} onClick={() => void publishCurrentOutputs()}><Save size={13} /> Отправить вид + 360 на выход</button>
        <button className="nodeSmallButton nodrag nopan" type="button" onClick={onToggleFloating}>{floating ? "В ноду" : "В окно"}</button>
      </div>
    </div>
  );
}

function captureCurrentSplatView(runtime: SplatRuntime): string {
  runtime.renderer.render(runtime.scene, runtime.camera);
  return runtime.renderer.domElement.toDataURL("image/png");
}

async function renderSplatPanorama(runtime: SplatRuntime, mount: HTMLElement | null): Promise<string> {
  const THREE = await import("three");
  const renderer = runtime.renderer;
  const previousSize = renderer.getSize(new THREE.Vector2());
  const previousPixelRatio = renderer.getPixelRatio();
  const faceSize = 512;
  const panoramaWidth = 1024;
  const panoramaHeight = 512;
  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = faceSize;
  faceCanvas.height = faceSize;
  const faceContext = faceCanvas.getContext("2d");
  const panoramaCanvas = document.createElement("canvas");
  panoramaCanvas.width = panoramaWidth;
  panoramaCanvas.height = panoramaHeight;
  const panoramaContext = panoramaCanvas.getContext("2d");
  if (!faceContext || !panoramaContext) throw new Error("Could not create 360 panorama canvas.");

  const origin = runtime.control.position.clone();
  const baseQuaternion = runtime.control.quaternion.clone();
  const faceDirections = {
    right: { direction: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
    left: { direction: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
    up: { direction: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
    down: { direction: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, -1) },
    front: { direction: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) },
    back: { direction: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) }
  };

  const faces: Record<string, ImageData> = {};
  const captureCamera = new THREE.PerspectiveCamera(90, 1, 0.01, 1000);
  renderer.setPixelRatio(1);
  renderer.setSize(faceSize, faceSize, false);
  captureCamera.position.copy(origin);

  for (const [name, face] of Object.entries(faceDirections)) {
    const direction = face.direction.clone().applyQuaternion(baseQuaternion);
    const up = face.up.clone().applyQuaternion(baseQuaternion);
    captureCamera.up.copy(up);
    captureCamera.lookAt(origin.clone().add(direction));
    captureCamera.updateProjectionMatrix();
    runtime.renderer.render(runtime.scene, captureCamera);
    faceContext.drawImage(renderer.domElement, 0, 0, faceSize, faceSize);
    faces[name] = faceContext.getImageData(0, 0, faceSize, faceSize);
  }

  const panorama = panoramaContext.createImageData(panoramaWidth, panoramaHeight);
  for (let y = 0; y < panoramaHeight; y += 1) {
    const pitch = Math.PI / 2 - ((y + 0.5) / panoramaHeight) * Math.PI;
    const cosPitch = Math.cos(pitch);
    for (let x = 0; x < panoramaWidth; x += 1) {
      const yaw = ((x + 0.5) / panoramaWidth) * Math.PI * 2 - Math.PI;
      const direction = {
        x: Math.sin(yaw) * cosPitch,
        y: Math.sin(pitch),
        z: -Math.cos(yaw) * cosPitch
      };
      const sample = sampleCubeFaces(faces, direction, faceSize);
      const offset = (y * panoramaWidth + x) * 4;
      panorama.data[offset] = sample[0];
      panorama.data[offset + 1] = sample[1];
      panorama.data[offset + 2] = sample[2];
      panorama.data[offset + 3] = 255;
    }
  }
  panoramaContext.putImageData(panorama, 0, 0);

  renderer.setPixelRatio(previousPixelRatio);
  const rect = mount?.getBoundingClientRect();
  renderer.setSize(rect ? Math.max(1, Math.floor(rect.width)) : previousSize.x, rect ? Math.max(1, Math.floor(rect.height)) : previousSize.y, false);
  renderer.render(runtime.scene, runtime.camera);

  return panoramaCanvas.toDataURL("image/png");
}

function sampleCubeFaces(faces: Record<string, ImageData>, direction: { x: number; y: number; z: number }, faceSize: number): [number, number, number] {
  const ax = Math.abs(direction.x);
  const ay = Math.abs(direction.y);
  const az = Math.abs(direction.z);
  let face = "front";
  let u = 0;
  let v = 0;
  if (ax >= ay && ax >= az) {
    if (direction.x > 0) {
      face = "right";
      u = direction.z / ax;
      v = -direction.y / ax;
    } else {
      face = "left";
      u = -direction.z / ax;
      v = -direction.y / ax;
    }
  } else if (ay >= ax && ay >= az) {
    if (direction.y > 0) {
      face = "up";
      u = direction.x / ay;
      v = -direction.z / ay;
    } else {
      face = "down";
      u = direction.x / ay;
      v = direction.z / ay;
    }
  } else if (direction.z > 0) {
    face = "back";
    u = -direction.x / az;
    v = -direction.y / az;
  } else {
    face = "front";
    u = direction.x / az;
    v = -direction.y / az;
  }
  const image = faces[face];
  return sampleImageDataBilinear(image, ((u + 1) / 2) * (faceSize - 1), ((v + 1) / 2) * (faceSize - 1));
}

function sampleImageDataBilinear(image: ImageData, x: number, y: number): [number, number, number] {
  const width = image.width;
  const height = image.height;
  const x0 = clamp(Math.floor(x), 0, width - 1);
  const y0 = clamp(Math.floor(y), 0, height - 1);
  const x1 = clamp(x0 + 1, 0, width - 1);
  const y1 = clamp(y0 + 1, 0, height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const c00 = imageDataRgb(image, x0, y0);
  const c10 = imageDataRgb(image, x1, y0);
  const c01 = imageDataRgb(image, x0, y1);
  const c11 = imageDataRgb(image, x1, y1);
  return [0, 1, 2].map((channel) => {
    const top = c00[channel] * (1 - tx) + c10[channel] * tx;
    const bottom = c01[channel] * (1 - tx) + c11[channel] * tx;
    return Math.round(top * (1 - ty) + bottom * ty);
  }) as [number, number, number];
}

function imageDataRgb(image: ImageData, x: number, y: number): [number, number, number] {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function NodeInlineParams({
  type,
  manifest,
  params,
  connectedInputPorts,
  promptLibrary,
  onRefreshPromptLibrary,
  promptStatusFilter,
  onPromptStatusFilterChange,
  onPromptContextMenu,
  stableDiffusionModels,
  openRouterModels,
  catalogImageModels,
  modelOptionsForNodes,
  polzaTextModels,
  polzaImageModels,
  polzaVideoModels,
  quotePreview,
  costEstimate,
  resizeInputImage,
  chooseCameraInputImage,
  onConfigureWorldLabs,
  onPublishNodeOutput,
  onRefreshPricing,
  modelProfiles,
  onRefreshStableDiffusionModels,
  onChange,
  onBrowse,
  canBrowseLocalFiles,
  onOpenImage
}: {
  type: string;
  manifest?: NodeManifest;
  params: Record<string, unknown>;
  connectedInputPorts: Set<string>;
  promptLibrary: PromptLibraryData;
  onRefreshPromptLibrary?: () => void;
  promptStatusFilter: PromptStatusFilter;
  onPromptStatusFilterChange?: (filter: PromptStatusFilter) => void;
  onPromptContextMenu?: (event: React.MouseEvent, prompt: PromptLibraryPrompt) => void;
  stableDiffusionModels: StableDiffusionModel[];
  openRouterModels: OpenRouterModel[];
  catalogImageModels: UnifiedModelInfo[] | null;
  modelOptionsForNodes: Record<string, ModelOptionForNodeV1[] | undefined>;
  polzaTextModels: PolzaModel[];
  polzaImageModels: PolzaModel[];
  polzaVideoModels: PolzaModel[];
  quotePreview?: ModelQuotePreview;
  costEstimate?: CostEstimate;
  resizeInputImage?: unknown;
  chooseCameraInputImage?: unknown;
  onConfigureWorldLabs?: () => void;
  onPublishNodeOutput?: (output: Record<string, unknown>) => void;
  onRefreshPricing?: (provider: string) => void;
  modelProfiles: ModelProfile[];
  onRefreshStableDiffusionModels?: (endpoint: string) => void;
  onChange: (patch: Record<string, unknown>) => void;
  onBrowse: (kind: AssetKind) => void;
  canBrowseLocalFiles: boolean;
  onOpenImage?: (image: ImageViewerState) => void;
}) {
  const pendingTextSelectionRef = useRef<PendingTextSelection | null>(null);
  const resizeInputDimensions = useImageDimensions(type === "transform.imageResize" ? resizeInputImage : undefined);
  const modelCreditBadge = <ModelCreditBadge costEstimate={costEstimate} />;

  useEffect(() => {
    if (type !== "polza.video.generate") return;
    const model = String(params.model ?? "");
    if (!isPolzaVideoUpscaleModelId(model)) return;
    const replacementModel = modelOptionsForNodes["polza.video.generate"]?.find((entry) =>
      entry.provider === "polza" && entry.executionProvider === "polza" && !entry.roles.includes("upscaler")
    )?.storedModelId;
    if (replacementModel) onChange({ model: replacementModel, executionProvider: "polza" });
  }, [type, params.model, modelOptionsForNodes, onChange]);

  useLayoutEffect(() => {
    restorePendingTextSelection(pendingTextSelectionRef);
  }, [params]);

  useEffect(() => {
    if (type !== "transform.imageResize" || !resizeInputDimensions.dimensions) return;
    const { width, height } = resizeInputDimensions.dimensions;
    const patch: Record<string, unknown> = {};
    if (isUnsetOrManifestDefaultResizeDimension(params.width) && Number(params.width) !== width) patch.width = width;
    if (isUnsetOrManifestDefaultResizeDimension(params.height) && Number(params.height) !== height) patch.height = height;
    if (Object.keys(patch).length > 0) onChange(patch);
  }, [type, resizeInputDimensions.dimensions?.width, resizeInputDimensions.dimensions?.height, params.width, params.height, onChange]);

  function updateTextParam(key: string, event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>, transform: (value: string) => unknown = (value) => value) {
    updateTextFieldPreservingCaret(event, pendingTextSelectionRef, (value) => onChange({ [key]: transform(value) }));
  }

  if (type === "input.text") {
    return (
      <label className="nodeField">
        <span>value</span>
        <textarea className="nodrag nopan nodeTextarea" value={String(params.value ?? "")} onChange={(event) => updateTextParam("value", event)} />
      </label>
    );
  }

  if (type === "transform.template") {
    return (
      <label className="nodeField">
        <span>template</span>
        <textarea className="nodrag nopan nodeTextarea" value={String(params.template ?? "")} onChange={(event) => updateTextParam("template", event)} />
      </label>
    );
  }

  if (type === "text.promptCompose") {
    const separator = String(params.separator ?? "\n\n");
    return (
      <>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className="nodrag nopan nodeTextarea" value={String(params.manualText ?? "")} onChange={(event) => updateTextParam("manualText", event)} />
        </label>
        <label className="nodeField">
          <span>separator</span>
          <textarea className="nodrag nopan nodeTextarea compact" value={separator} onChange={(event) => updateTextParam("separator", event)} />
        </label>
        <div className="nodeGridFields">
          <label className="nodeCheckField">
            <input
              className="nodrag nopan"
              type="checkbox"
              checked={params.trimParts !== false}
              onChange={(event) => onChange({ trimParts: event.target.checked })}
            />
            <span>trimParts</span>
          </label>
          <label className="nodeCheckField">
            <input
              className="nodrag nopan"
              type="checkbox"
              checked={params.skipEmpty !== false}
              onChange={(event) => onChange({ skipEmpty: event.target.checked })}
            />
            <span>skipEmpty</span>
          </label>
        </div>
        <label className="nodeField">
          <span>prefix</span>
          <textarea className="nodrag nopan nodeTextarea compact" value={String(params.prefix ?? "")} onChange={(event) => updateTextParam("prefix", event)} />
        </label>
        <label className="nodeField">
          <span>suffix</span>
          <textarea className="nodrag nopan nodeTextarea compact" value={String(params.suffix ?? "")} onChange={(event) => updateTextParam("suffix", event)} />
        </label>
        <label className="nodeField">
          <span>preview</span>
          <textarea className="nodrag nopan nodeTextarea outputTextArea" value={composePromptPreview(params)} readOnly />
          <small className="nodeConnectedHint">Connected inputs are composed when the node runs.</small>
        </label>
      </>
    );
  }

  if (type === "transform.panorama360ToFisheye") {
    return (
      <div className="fisheyeParams">
        <NodeSliderParam
          id="fovDegrees"
          label="angle"
          min={1}
          max={360}
          step={1}
          value={numberParamValue(params.fovDegrees, 200)}
          onChange={onChange}
        />
        <NodeSliderParam
          id="yawDegrees"
          label="yaw"
          min={-180}
          max={180}
          step={1}
          value={numberParamValue(params.yawDegrees, 0)}
          onChange={onChange}
        />
        <NodeSliderParam
          id="pitchDegrees"
          label="pitch"
          min={-90}
          max={90}
          step={1}
          value={numberParamValue(params.pitchDegrees, -90)}
          onChange={onChange}
        />
      </div>
    );
  }

  if (type === "transform.chooseCameraPoint") {
    return <ChooseCameraPointParams params={params} inputImage={chooseCameraInputImage} onConfigureWorldLabs={onConfigureWorldLabs} onPublishNodeOutput={onPublishNodeOutput} onChange={onChange} onOpenImage={onOpenImage} />;
  }

  if (type === "transform.imageResize" && manifest?.params?.length) {
    const dimensions = resizeInputDimensions.dimensions;
    const status = resizeInputDimensions.status;
    return (
      <>
        <div className="nodeMetaLine">
          Input image: {dimensions ? `${dimensions.width} x ${dimensions.height}px` : status === "loading" ? "loading size..." : status === "error" ? "size unavailable" : "not connected"}
        </div>
        <GenericManifestParams manifest={manifest} params={params} onChange={onChange} updateTextParam={updateTextParam} />
      </>
    );
  }

  if (type === "library.prompt") {
    const categories = filterPromptLibraryByStatus(promptLibrary, promptStatusFilter).categories;
    const selectedCategory = categories.find((category) => category.id === String(params.category ?? "")) ?? categories[0];
    const prompts = selectedCategory?.prompts ?? [];
    const selectedPromptId = String(params.promptId ?? "");
    const selectedPrompt = prompts.find((prompt) => prompt.id === selectedPromptId);
    const displayPrompt = selectedPrompt ?? prompts[0];
    const mode = String(params.mode ?? "linked") === "embedded" ? "embedded" : "linked";
    const previewText = mode === "embedded" ? String(params.embeddedText ?? "") : displayPrompt?.text ?? "";
    if (categories.length === 0) {
      return (
        <div className="assetParams">
          <div className="nodeWarning">{promptLibrary.categories.length === 0 ? "No prompts found. Add .prompt.png or .prompt.md files to data/prompt-library/ and refresh." : "No prompts match the selected status filter."}</div>
          <label className="nodeField">
            <span>status</span>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={promptStatusFilter}
              onChange={(event) => onPromptStatusFilterChange?.(event.target.value as PromptStatusFilter)}
            >
              {promptStatusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
          <button className="nodeSmallButton nodrag nopan" type="button" onClick={onRefreshPromptLibrary}>Refresh Prompt Library</button>
        </div>
      );
    }
    return (
      <>
        <button className="nodeSmallButton nodrag nopan" type="button" onClick={onRefreshPromptLibrary}>Refresh Prompt Library</button>
        <label className="nodeField">
          <span>status</span>
          <select
            className="nodrag nopan nodeInput nodeSelect"
            value={promptStatusFilter}
            onChange={(event) => onPromptStatusFilterChange?.(event.target.value as PromptStatusFilter)}
          >
            {promptStatusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <label className="nodeField">
          <span>category</span>
          <select
            className="nodrag nopan nodeInput nodeSelect"
            value={selectedCategory?.id ?? ""}
            onChange={(event) => {
              const category = categories.find((entry) => entry.id === event.target.value);
              onChange({ category: event.target.value, promptId: category?.prompts[0]?.id ?? "", mode });
            }}
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.title}</option>
            ))}
          </select>
        </label>
        <div className="nodePromptCards nowheel">
          {prompts.map((prompt) => (
            <PromptLibraryPromptCard
              key={prompt.id}
              prompt={prompt}
              selected={prompt.id === selectedPromptId && Boolean(selectedPrompt)}
              onSelect={() => onChange({ promptId: prompt.id, category: selectedCategory?.id ?? prompt.category ?? "", mode })}
              onContextMenu={(event) => onPromptContextMenu?.(event, prompt)}
            />
          ))}
        </div>
        {displayPrompt?.description ? <div className="nodeHint">{displayPrompt.description}</div> : null}
        {mode === "linked" && selectedPromptId && !selectedPrompt ? (
          <div className="nodeWarning">Linked prompt "{selectedCategory?.id ?? String(params.category ?? "")}/{selectedPromptId}" is not visible in this library view. Pick a prompt card to relink this node.</div>
        ) : null}
        <label className="nodeField">
          <span>mode</span>
          <select className="nodrag nopan nodeInput nodeSelect" value={mode} onChange={(event) => onChange({ mode: event.target.value })}>
            <option value="linked">linked</option>
            <option value="embedded">embedded</option>
          </select>
        </label>
        <button
          className="nodeSmallButton nodrag nopan"
          type="button"
          disabled={!displayPrompt}
          onClick={() => onChange({ mode: "embedded", embeddedTitle: displayPrompt?.title ?? "", embeddedText: displayPrompt?.text ?? "" })}
        >
          Embed selected prompt
        </button>
        <label className="nodeField">
          <span>preview</span>
          <textarea
            className="nodrag nopan nodeTextarea outputTextArea"
            value={previewText}
            readOnly={mode === "linked"}
            onChange={(event) => updateTextParam("embeddedText", event)}
          />
        </label>
      </>
    );
  }

  if (type === "input.file" || type === "input.image" || type === "input.video") {
    const kind = type.split(".")[1] as AssetKind;
    const path = String(params.path ?? "");
    const imageSrc = type === "input.image" && path ? `${apiBase}/api/assets/preview?path=${encodeURIComponent(path)}` : "";
    return (
      <div className="assetParams">
        <label className="nodeField">
          <span>file</span>
          <input
            className="nodrag nopan nodeInput"
            value={path ? filenameFromPath(path) : ""}
            placeholder="No file selected"
            title={path}
            readOnly
          />
        </label>
        {canBrowseLocalFiles ? <button className="nodeSmallButton nodrag nopan" onClick={() => onBrowse(kind)}>Browse...</button> : null}
        {!path ? <div className="nodeWarning">Path required</div> : null}
        {imageSrc ? (
          <button
            className="nodeImagePreviewButton nodrag nopan"
            type="button"
            title="View image"
            onClick={() => onOpenImage?.({ src: imageSrc, title: filenameFromPath(path), filename: filenameFromPath(path) })}
          >
            <img className="nodeImagePreview" src={imageSrc} alt="" />
          </button>
        ) : null}
      </div>
    );
  }

  if (type === "replicate.model") {
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={modelLogoFor("replicate", String(params.model ?? ""))}>
            <input className="nodrag nopan nodeInput" value={String(params.model ?? "")} onChange={(event) => updateTextParam("model", event)} />
          </ModelSelectWithLogo>
        </label>
        <label className="nodeField">
          <span>input</span>
          <textarea
            className="nodrag nopan nodeTextarea"
            value={JSON.stringify(params.input ?? {}, null, 2)}
            onChange={(event) => {
              updateTextFieldPreservingCaret(event, pendingTextSelectionRef, (value) => {
                try {
                  onChange({ input: JSON.parse(value) });
                } catch {
                  onChange({ input: value });
                }
              });
            }}
          />
        </label>
      </>
    );
  }

  if (type === "replicate.clarity-upscaler") {
    const promptConnected = connectedInputPorts.has("prompt");
    return (
      <>
        <label className="nodeField">
          <span>prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.prompt ?? "")}
            disabled={promptConnected}
            onChange={(event) => updateTextParam("prompt", event)}
          />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span>negative</span>
          <textarea className="nodrag nopan nodeTextarea compact" value={String(params.negative_prompt ?? "")} onChange={(event) => updateTextParam("negative_prompt", event)} />
        </label>
        <div className="nodeGridFields">
          {(["scale_factor", "dynamic", "creativity", "resemblance", "num_inference_steps", "seed"] as const).map((key) => (
            <label className="nodeField" key={key}>
              <span>{key}</span>
              <input
                className="nodrag nopan nodeInput"
                inputMode="decimal"
                value={String(params[key] ?? "").replace(".", ",")}
                onChange={(event) => updateTextParam(key, event, (value) => value.replace(".", ","))}
              />
            </label>
          ))}
        </div>
      </>
    );
  }

  if (type === "dialogue.workbench") {
    const state = normalizeDialogueWorkbenchState(params.state, {
      nodeId: "dialogue",
      defaultModelProfileId: String(params.defaultModelProfileId ?? "text.default")
    });
    const profile = modelProfiles.find((entry) => entry.id === (state.defaultModelProfileId ?? params.defaultModelProfileId));
    return (
      <div className="dialogueInlineSummary">
        <div><span>default model</span><strong>{profile?.displayName ?? String(params.defaultModelProfileId ?? "text.default")}</strong></div>
        <div><span>messages</span><strong>{state.messages.length}</strong></div>
        <div><span>selected outputs</span><strong>{state.selectedOutputs.length}</strong></div>
        <div className="nodeHint">Open the Workbench for messages, pins, outputs, and transcript exports.</div>
      </div>
    );
  }

  if (type === "ai.text") {
    const systemPromptConnected = connectedInputPorts.has("systemPrompt");
    const promptConnected = connectedInputPorts.has("prompt");
    const model = String(params.model ?? "text.default");
    const nodeModelOptions = modelOptionsForNodes["ai.text"] ?? [];
    const selectedNodeModel = nodeModelOptions.find((entry) => entry.storedModelId === model);
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={modelOptionForNodeLogo(selectedNodeModel) ?? modelLogoFor("openrouter", model)}>
            <select className="nodrag nopan nodeInput nodeSelect" value={model} onChange={(event) => onChange({ model: event.target.value })}>
              <option value="text.default">Auto / default text model</option>
              {(nodeModelOptions.length > 0
                ? nodeModelOptions.map((entry) => <option key={entry.id} value={entry.storedModelId}>{modelOptionForNodeLabel(entry)}</option>)
                : openRouterModels.filter((entry) => modelSupportsText(entry)).map((entry) => (
                  <option key={entry.id} value={entry.id}>{llmModelOptionLabel(entry.name ?? entry.id, entry.id, openRouterModelSupportsVisionInput(entry))}</option>
                ))
              )}
              {model && model !== "text.default" && !nodeModelOptions.some((entry) => entry.storedModelId === model) && !openRouterModels.some((entry) => entry.id === model) ? <option value={model}>{model}</option> : null}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{openRouterCostLabel(openRouterModels.find((entry) => entry.id === model))}</small>
        </label>
        <label className="nodeField">
          <span>system prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${systemPromptConnected ? "nodeParamDisabled" : ""}`} value={String(params.systemPrompt ?? "")} disabled={systemPromptConnected} onChange={(event) => updateTextParam("systemPrompt", event)} />
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`} value={String(params.prompt ?? "")} disabled={promptConnected} onChange={(event) => updateTextParam("prompt", event)} />
        </label>
        <details className="nodeAdvanced">
          <summary>Advanced</summary>
          <label className="nodeField">
            <span>provider mode</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={String(params.providerMode ?? "auto")} onChange={(event) => onChange({ providerMode: event.target.value })}>
              <option value="auto">Auto</option>
              <option value="openrouter">OpenRouter</option>
              <option value="direct">Direct</option>
            </select>
          </label>
          <div className="nodeGridFields">
            <label className="nodeField"><span>temperature</span><input className="nodrag nopan nodeInput" inputMode="decimal" value={String(params.temperature ?? "")} onChange={(event) => updateTextParam("temperature", event, numericParam)} /></label>
            <label className="nodeField"><span>max tokens</span><input className="nodrag nopan nodeInput" inputMode="numeric" value={String(params.max_tokens ?? "")} onChange={(event) => updateTextParam("max_tokens", event, numericParam)} /></label>
          </div>
        </details>
      </>
    );
  }

  if (type === "ai.image.generate") {
    const promptConnected = connectedInputPorts.has("prompt");
    const model = String(params.model ?? "image.nano-banana");
    const connectionRoute = String(params.providerMode ?? "auto");
    const nodeModelOptions = modelOptionsForNodes["ai.image.generate"] ?? [];
    const modelOptions = nodeModelOptions.length > 0
      ? imageModelOptionsFromNodeOptions(nodeModelOptions, model)
      : enrichImageGenerationModelOptions(imageGenerationModelOptions(openRouterModels, model), catalogImageModels ?? []);
    const selectedModel = modelOptions.find((entry) => entry.id === model);
    const aspectRatioOptions = imageAspectRatioOptions(selectedModel);
    const imageSizeOptions = imageSizeOptionsForModel(selectedModel);
    const aspectRatio = supportedOptionValue(params.aspectRatio, aspectRatioOptions);
    const imageSize = supportedOptionValue(params.imageSize, imageSizeOptions);
    const routePreview = imageRoutePreview(selectedModel, connectionRoute);
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={imageModelOptionLogo(selectedModel, model)}>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={model}
              onChange={(event) => {
                const nextModel = modelOptions.find((entry) => entry.id === event.target.value);
                const nextAspectRatios = imageAspectRatioOptions(nextModel);
                const nextImageSizes = imageSizeOptionsForModel(nextModel);
                onChange({
                  model: event.target.value,
                  aspectRatio: supportedOptionValue(params.aspectRatio, nextAspectRatios),
                  imageSize: supportedOptionValue(params.imageSize, nextImageSizes)
                });
              }}
            >
              {modelOptions.map((entry) => (
                <option key={entry.id} value={entry.id} disabled={entry.disabled}>{imageModelOptionLabel(entry)}</option>
              ))}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{imageModelCostLabel(selectedModel)}</small>
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`} value={String(params.prompt ?? "")} disabled={promptConnected} onChange={(event) => updateTextParam("prompt", event)} />
        </label>
        <div className="nodeGridFields">
          <label className="nodeField">
            <span>aspect ratio</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={aspectRatio} onChange={(event) => onChange({ aspectRatio: event.target.value })}>
              {aspectRatioOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="nodeField">
            <span>quality</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={imageSize} onChange={(event) => onChange({ imageSize: event.target.value })}>
              {imageSizeOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <details className="nodeAdvanced">
          <summary>Advanced</summary>
          <label className="nodeField">
            <span>Connection route</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={connectionRoute} onChange={(event) => onChange({ providerMode: event.target.value })}>
              <option value="auto">Auto</option>
              <option value="openrouter">OpenRouter</option>
              <option value="direct">Direct API</option>
            </select>
            <small className="nodeConnectedHint">{connectionRouteHelper(connectionRoute)}</small>
          </label>
          <div className="nodeRoutePreview">
            <div><span>Selected model</span><strong>{routePreview.selectedModelLabel}</strong></div>
            <div><span>Model slug</span><strong>{routePreview.selectedModelId}</strong></div>
            <div><span>Connection route</span><strong>{routePreview.selectedConnectionRoute}</strong></div>
            <div><span>Resolved provider</span><strong>{routePreview.resolvedProvider}</strong></div>
            <div><span>Resolved route</span><strong>{routePreview.resolvedRoute}</strong></div>
            <div><span>Image support</span><strong>{routePreview.supportsImageGeneration}</strong></div>
            <div><span>Fallback</span><strong>{routePreview.fallbackUsed ? "yes" : "no"}</strong></div>
            {routePreview.fallbackReason ? <div><span>Fallback reason</span><strong>{routePreview.fallbackReason}</strong></div> : null}
          </div>
        </details>
      </>
    );
  }

  if (type === "polza.text") {
    const systemPromptConnected = connectedInputPorts.has("systemPrompt");
    const promptConnected = connectedInputPorts.has("prompt");
    const model = String(params.model ?? "");
    const nodeModelOptions = modelOptionsForNodes["polza.text"] ?? [];
    const modelOptions = polzaModelsFromNodeOptions(nodeModelOptions, model);
    const selectedModel = modelOptions.find((entry) => entry.id === model);
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={modelLogoFor("polza", selectedModel?.id ?? model)}>
            <select className="nodrag nopan nodeInput nodeSelect" value={model} onChange={(event) => onChange({ model: event.target.value })}>
              {modelOptions.length === 0 ? <option value="" disabled>Model catalog unavailable</option> : null}
              {modelOptions.map((entry) => (
                <option key={entry.id} value={entry.id}>{llmModelOptionLabel(entry.name ?? entry.id, entry.id, polzaModelSupportsVisionInput(entry))}</option>
              ))}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{polzaModelHint(selectedModel, "Text model via Polza.ai")}</small>
        </label>
        <label className="nodeField">
          <span>system prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${systemPromptConnected ? "nodeParamDisabled" : ""}`} value={String(params.systemPrompt ?? "")} disabled={systemPromptConnected} onChange={(event) => updateTextParam("systemPrompt", event)} />
          {systemPromptConnected ? <small className="nodeConnectedHint">System prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`} value={String(params.prompt ?? "")} disabled={promptConnected} onChange={(event) => updateTextParam("prompt", event)} />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <details className="nodeAdvanced">
          <summary>Advanced</summary>
          <div className="nodeGridFields">
            <label className="nodeField"><span>temperature</span><input className="nodrag nopan nodeInput" inputMode="decimal" value={String(params.temperature ?? "")} onChange={(event) => updateTextParam("temperature", event, numericParam)} /></label>
            <label className="nodeField"><span>max tokens</span><input className="nodrag nopan nodeInput" inputMode="numeric" value={String(params.max_tokens ?? "")} onChange={(event) => updateTextParam("max_tokens", event, numericParam)} /></label>
          </div>
        </details>
      </>
    );
  }

  if (type === "polza.image.generate") {
    const promptConnected = connectedInputPorts.has("prompt");
    const model = polzaProviderModelId(String(params.model ?? ""));
    const nodeModelOptions = modelOptionsForNodes["polza.image.generate"] ?? [];
    const modelOptions = enrichPolzaImageModelOptions(polzaModelsFromNodeOptions(nodeModelOptions, model), catalogImageModels ?? []);
    const selectedModel = modelOptions.find((entry) => entry.id === model);
    const selectedModelId = selectedModel?.id ?? model;
    const aspectRatio = supportedOptionValue(params.aspectRatio, POLZA_IMAGE_ASPECT_RATIOS);
    const imageResolution = supportedOptionValue(params.imageResolution ?? params.imageSize, POLZA_IMAGE_RESOLUTIONS);
    const quality = supportedOptionValue(params.quality, POLZA_IMAGE_QUALITIES);
    const outputFormat = supportedOptionValue(params.outputFormat, POLZA_IMAGE_FORMATS);
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={polzaImageModelLogo(selectedModel, model)}>
            <select className="nodrag nopan nodeInput nodeSelect" value={selectedModelId} onChange={(event) => onChange({ model: event.target.value })}>
              {modelOptions.length === 0 ? <option value="" disabled>Model catalog unavailable</option> : null}
              {modelOptions.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name ? `${entry.name} (${entry.id})` : entry.id}</option>
              ))}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{polzaModelHint(selectedModel, "Image model via Polza.ai")}</small>
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`} value={String(params.prompt ?? "")} disabled={promptConnected} onChange={(event) => updateTextParam("prompt", event)} />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <div className="nodeGridFields">
          <label className="nodeField">
            <span>aspect ratio</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={aspectRatio} onChange={(event) => onChange({ aspectRatio: event.target.value })}>
              {POLZA_IMAGE_ASPECT_RATIOS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="nodeField">
            <span>resolution</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={imageResolution} onChange={(event) => onChange({ imageResolution: event.target.value })}>
              {POLZA_IMAGE_RESOLUTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <details className="nodeAdvanced">
          <summary>Advanced</summary>
          <div className="nodeGridFields">
            <label className="nodeField">
              <span>quality</span>
              <select className="nodrag nopan nodeInput nodeSelect" value={quality} onChange={(event) => onChange({ quality: event.target.value })}>
                {POLZA_IMAGE_QUALITIES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="nodeField">
              <span>format</span>
              <select className="nodrag nopan nodeInput nodeSelect" value={outputFormat} onChange={(event) => onChange({ outputFormat: event.target.value })}>
                {POLZA_IMAGE_FORMATS.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          </div>
        </details>
      </>
    );
  }

  if (type === "polza.video.generate") {
    const promptConnected = connectedInputPorts.has("prompt");
    const model = isPolzaVideoUpscaleModelId(String(params.model ?? "")) ? "" : String(params.model ?? "");
    const executionProvider = String(params.executionProvider ?? "polza") === "openrouter" ? "openrouter" : "polza";
    const nodeModelOptions = modelOptionsForNodes["polza.video.generate"] ?? [];
    const modelOptions = videoModelOptionsFromNodeOptions(nodeModelOptions, model);
    const selectedModel = modelOptions.find((entry) => entry.id === model && entry.providerId === executionProvider) ?? modelOptions.find((entry) => entry.id === model);
    const selectedModelKey = selectedModel ? videoModelOptionKey(selectedModel) : "";
    const resolution = supportedOptionValue(params.resolution, POLZA_VIDEO_RESOLUTIONS);
    const duration = supportedOptionValue(params.duration, POLZA_VIDEO_DURATIONS);
    const supportsAudio = polzaVideoSupportsAudio(selectedModel ?? { id: model });
    const generateAudio = params.generate_audio !== false;
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={modelLogoFor(selectedModel?.providerId ?? "polza", selectedModel?.id ?? model)}>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={selectedModelKey}
              onChange={(event) => {
                const nextModel = modelOptions.find((entry) => videoModelOptionKey(entry) === event.target.value);
                if (!nextModel) return;
                onChange({ model: nextModel.id, executionProvider: nextModel.providerId });
              }}
            >
              {modelOptions.length === 0 ? <option value="" disabled>Model catalog unavailable</option> : null}
              {modelOptions.map((entry) => (
                <option key={videoModelOptionKey(entry)} value={videoModelOptionKey(entry)}>{entry.name ? `${entry.name} (${entry.id}) - ${entry.providerLabel}` : `${entry.id} - ${entry.providerLabel}`}</option>
              ))}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{videoModelHint(selectedModel, "Video model")}</small>
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`} value={String(params.prompt ?? "")} disabled={promptConnected} onChange={(event) => updateTextParam("prompt", event)} />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <div className="nodeGridFields">
          <label className="nodeField">
            <span>resolution</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={resolution} onChange={(event) => onChange({ resolution: event.target.value })}>
              {POLZA_VIDEO_RESOLUTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="nodeField">
            <span>duration</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={duration} onChange={(event) => onChange({ duration: event.target.value })}>
              {POLZA_VIDEO_DURATIONS.map((value) => <option key={value} value={value}>{value}s</option>)}
            </select>
          </label>
        </div>
        <details className="nodeAdvanced">
          <summary>Advanced</summary>
          {supportsAudio ? (
            <label className="nodeCheckField">
              <input className="nodrag nopan" type="checkbox" checked={generateAudio} onChange={(event) => onChange({ generate_audio: event.target.checked })} />
              <span>sound</span>
            </label>
          ) : null}
          <label className="nodeCheckField">
            <input className="nodrag nopan" type="checkbox" checked={Boolean(params.multi_shots)} onChange={(event) => onChange({ multi_shots: event.target.checked })} />
            <span>multi shots</span>
          </label>
        </details>
      </>
    );
  }

  if (type === "gemini.nano-banana-2") {
    const promptConnected = connectedInputPorts.has("prompt");
    return (
      <>
        <div className="nodeFixedModelLine">
          <span>model</span>
          <strong>gemini-3.1-flash-image-preview</strong>
          {modelCreditBadge}
        </div>
        <label className="nodeField">
          <span>prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.prompt ?? "")}
            disabled={promptConnected}
            onChange={(event) => updateTextParam("prompt", event)}
          />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <div className="nodeGridFields">
          <label className="nodeField">
            <span>aspect ratio</span>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={String(params.aspectRatio ?? "1:1")}
              onChange={(event) => onChange({ aspectRatio: event.target.value })}
            >
              {["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="nodeField">
            <span>quality</span>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={String(params.imageSize ?? "2K")}
              onChange={(event) => onChange({ imageSize: event.target.value })}
            >
              {["1K", "2K", "4K"].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
      </>
    );
  }

  if (type === "gemini.llm") {
    const systemPromptConnected = connectedInputPorts.has("systemPrompt");
    const promptConnected = connectedInputPorts.has("prompt");
    return (
      <>
        <label className="nodeField">
          <span>system prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${systemPromptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.systemPrompt ?? "")}
            disabled={systemPromptConnected}
            onChange={(event) => updateTextParam("systemPrompt", event)}
          />
          {systemPromptConnected ? <small className="nodeConnectedHint">System prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.prompt ?? "")}
            disabled={promptConnected}
            onChange={(event) => updateTextParam("prompt", event)}
          />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={modelLogoFor("gemini", String(params.model ?? "gemini-2.5-flash-lite"))}>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={String(params.model ?? "gemini-2.5-flash-lite")}
              onChange={(event) => onChange({ model: event.target.value })}
            >
              {GEMINI_LLM_MODEL_OPTIONS.map((model) => (
                <option key={model.value} value={model.value}>
                  {llmModelOptionLabel(model.label, model.value, model.supportsVision)}
                </option>
              ))}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{geminiLlmPricingLabel(String(params.model ?? "gemini-2.5-flash-lite"))}</small>
        </label>
      </>
    );
  }

  if (type === "local.stableDiffusion.textToImage") {
    const promptConnected = connectedInputPorts.has("prompt");
    const negativeConnected = connectedInputPorts.has("negativePrompt");
    const endpoint = String(params.endpoint ?? "http://127.0.0.1:7860");
    const selectedModel = String(params.model ?? "");
    return (
      <>
        <label className="nodeField">
          <span>endpoint</span>
          <input className="nodrag nopan nodeInput" value={endpoint} onChange={(event) => updateTextParam("endpoint", event)} />
        </label>
        <label className="nodeField">
          <span>model</span>
          <ModelSelectWithLogo logo={modelLogoFor("local", selectedModel || "stable-diffusion")}>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={selectedModel}
              onChange={(event) => onChange({ model: event.target.value })}
            >
              <option value="">current WebUI model</option>
              {stableDiffusionModels.map((model) => (
                <option key={model.title} value={model.title}>{model.title}</option>
              ))}
              {selectedModel && !stableDiffusionModels.some((model) => model.title === selectedModel) ? <option value={selectedModel}>{selectedModel}</option> : null}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">Sent as sd_model_checkpoint for this request.</small>
        </label>
        <button className="nodeSmallButton nodrag nopan" type="button" onClick={() => onRefreshStableDiffusionModels?.(endpoint)}>Refresh models</button>
        {stableDiffusionModels.length === 0 ? (
          <label className="nodeField">
            <span>manual model</span>
            <input className="nodrag nopan nodeInput" value={selectedModel} placeholder="Optional checkpoint title" onChange={(event) => updateTextParam("model", event)} />
          </label>
        ) : null}
        <label className="nodeField">
          <span>prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.prompt ?? "")}
            disabled={promptConnected}
            onChange={(event) => updateTextParam("prompt", event)}
          />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span>negative</span>
          <textarea
            className={`nodrag nopan nodeTextarea compact ${negativeConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.negativePrompt ?? "")}
            disabled={negativeConnected}
            onChange={(event) => updateTextParam("negativePrompt", event)}
          />
        </label>
        <div className="nodeGridFields">
          {(["width", "height", "steps", "cfgScale", "batchSize", "seed"] as const).map((key) => (
            <label className="nodeField" key={key}>
              <span>{key}</span>
              <input className="nodrag nopan nodeInput" inputMode="decimal" value={String(params[key] ?? "")} onChange={(event) => updateTextParam(key, event)} />
            </label>
          ))}
        </div>
        <label className="nodeField">
          <span>sampler</span>
          <input className="nodrag nopan nodeInput" value={String(params.samplerName ?? "")} onChange={(event) => updateTextParam("samplerName", event)} />
        </label>
      </>
    );
  }

  if (type === "http.request") {
    const bodyMode = String(params.bodyMode ?? "none");
    return (
      <>
        <label className="nodeField">
          <span>url</span>
          <input className="nodrag nopan nodeInput" value={String(params.url ?? "")} onChange={(event) => updateTextParam("url", event)} />
        </label>
        <div className="nodeGridFields">
          <label className="nodeField">
            <span>method</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={String(params.method ?? "GET")} onChange={(event) => onChange({ method: event.target.value })}>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => <option key={method} value={method}>{method}</option>)}
            </select>
          </label>
          <label className="nodeField">
            <span>response</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={String(params.responseMode ?? "json")} onChange={(event) => onChange({ responseMode: event.target.value })}>
              {["json", "text"].map((mode) => <option key={mode} value={mode}>{mode}</option>)}
            </select>
          </label>
        </div>
        <label className="nodeField">
          <span>headers JSON</span>
          <textarea className="nodrag nopan nodeTextarea compact" value={formatJsonish(params.headers ?? {})} onChange={(event) => updateTextParam("headers", event)} />
        </label>
        <label className="nodeField">
          <span>query JSON</span>
          <textarea className="nodrag nopan nodeTextarea compact" value={formatJsonish(params.query ?? {})} onChange={(event) => updateTextParam("query", event)} />
        </label>
        <label className="nodeField">
          <span>body mode</span>
          <select className="nodrag nopan nodeInput nodeSelect" value={bodyMode} onChange={(event) => onChange({ bodyMode: event.target.value })}>
            <option value="none">none</option>
            <option value="rawJson">raw JSON</option>
            <option value="rawText">raw text</option>
          </select>
        </label>
        {bodyMode !== "none" ? (
          <label className="nodeField">
            <span>body</span>
            <textarea className="nodrag nopan nodeTextarea" value={String(params.body ?? "")} onChange={(event) => updateTextParam("body", event)} />
          </label>
        ) : null}
      </>
    );
  }

  if (type === "preview.image") return null;

  if (type === "preview.panorama360") {
    return <div className="nodeHint">Connect an equirectangular 360 image, run the block, then drag the preview to look around.</div>;
  }

  if (type === "output.text") {
    return <div className="nodeHint">Text output</div>;
  }

  if (type === "debug.log") {
    return (
      <>
        <label className="nodeField">
          <span>message</span>
          <input className="nodrag nopan nodeInput" value={String(params.message ?? "")} onChange={(event) => updateTextParam("message", event)} />
        </label>
        <label className="nodeField">
          <span>value</span>
          <textarea className="nodrag nopan nodeTextarea" value={String(params.value ?? "")} onChange={(event) => updateTextParam("value", event)} />
        </label>
      </>
    );
  }

  if (type === "output.file") {
    return (
      <>
        <label className="nodeField">
          <span>filename</span>
          <input className="nodrag nopan nodeInput" value={String(params.filename ?? "")} onChange={(event) => updateTextParam("filename", event)} />
        </label>
        <label className="nodeField">
          <span>from</span>
          <textarea className="nodrag nopan nodeTextarea" value={String(params.from ?? "")} onChange={(event) => updateTextParam("from", event)} />
        </label>
      </>
    );
  }

  if (manifest?.params?.length) {
    return <GenericManifestParams manifest={manifest} params={params} onChange={onChange} updateTextParam={updateTextParam} />;
  }

  return null;
}

function composePromptPreview(params: Record<string, unknown>): string {
  const trimParts = params.trimParts !== false;
  const skipEmpty = params.skipEmpty !== false;
  const separator = String(params.separator ?? "\n\n");
  const manualText = params.manualText === undefined || params.manualText === null ? "" : String(params.manualText);
  const slotParts = promptComposeFixedSlots().flatMap((slot) => [1, 2, 3].map((index) => ({ slot, index, raw: params[`${slot.id}${index}`] })));
  const legacyParts = [1, 2, 3, 4, 5, 6].map((index) => ({ slot: { id: `text${index}`, label: `Text ${index}` }, index: 1, raw: params[`text${index}`] }));
  const hasSlotParts = slotParts.some((part) => part.raw !== undefined);
  const values = hasSlotParts ? slotParts : legacyParts;
  const parts = [
    { label: "Prompt", index: 1, value: trimParts ? manualText.trim() : manualText },
    ...values
    .map(({ slot, index, raw }) => {
      const text = raw === undefined || raw === null ? "" : String(raw);
      const value = trimParts ? text.trim() : text;
      return { label: slot.label, index, value };
    })
  ]
    .filter((part) => !skipEmpty || part.value !== "");
  const body = parts
    .map((part) => hasSlotParts && part.label !== "Prompt" ? `${part.label}${part.index > 1 ? ` ${part.index}` : ""}:\n${part.value}` : part.value)
    .join(separator);
  return `${String(params.prefix ?? "")}${body}${String(params.suffix ?? "")}`;
}

function promptComposeFixedSlots(): Array<{ id: string; label: string }> {
  return [
    { id: "subject", label: "Subject" },
    { id: "style", label: "Style" },
    { id: "scene", label: "Scene" }
  ];
}

function PromptLibraryPromptCard({
  prompt,
  selected,
  onSelect,
  onContextMenu
}: {
  prompt: PromptLibraryPrompt;
  selected: boolean;
  onSelect: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewSrc = prompt.previewImage && !previewFailed ? promptPreviewSrc(prompt) : "";
  return (
    <button
      className={`nodePromptCard nodrag nopan ${previewSrc ? "withPreview" : ""} ${selected ? "selected" : ""}`}
      type="button"
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event);
      }}
      title="Right-click for prompt actions"
    >
      {previewSrc ? <img src={previewSrc} alt="" onError={() => setPreviewFailed(true)} /> : null}
      <div className="nodePromptCardHeader">
        <strong>{prompt.title}</strong>
        <span className={`promptStatusBadge ${prompt.status ?? "published"}`}>{prompt.status ?? "published"}</span>
      </div>
      {prompt.description ? <span>{truncateText(prompt.description, 80)}</span> : null}
    </button>
  );
}

function NodeInlineResult({
  nodeId,
  type,
  result,
  outputPinned,
  onOpenImage,
  onDownloadImage,
  onImageResultContextMenu,
  onFixNodeOutput,
  onConfigureMissingSecret
}: {
  nodeId: string;
  type: string;
  result: NodeRunResult;
  outputPinned?: boolean;
  onOpenImage?: (image: ImageViewerState) => void;
  onDownloadImage?: (src: string, filename: string) => void;
  onImageResultContextMenu?: (event: React.MouseEvent, nodeId: string, result: NodeRunResult) => void;
  onFixNodeOutput?: (nodeId: string, output: unknown, options?: FixNodeOutputOptions) => void;
  onConfigureMissingSecret?: () => void;
}) {
  const previewVersion = result.completedAt ?? result.startedAt ?? "";
  const liveFisheye = liveFisheyeOutput(result.output);
  if (liveFisheye) {
    return (
      <LiveFisheyePreview
        source={liveFisheye.source}
        fovDegrees={liveFisheye.fovDegrees}
        yawDegrees={liveFisheye.yawDegrees}
        pitchDegrees={liveFisheye.pitchDegrees}
        onOpenImage={onOpenImage}
        onDownloadImage={onDownloadImage}
      />
    );
  }
  const imageSrc = versionedAssetPreviewSrc(imagePreviewSrc(result.output), previewVersion);
  const videoSrc = versionedAssetPreviewSrc(videoPreviewSrc(result.output), previewVersion);
  const cost = costLabel(result.output);
  const creditCost = result.actualCredits !== undefined && result.actualCredits > 0
    ? `Spent: ${formatCredits(result.actualCredits)} credits${result.costEstimate?.provider ? ` · Provider: ${result.costEstimate.provider}` : ""} · Usage: ${result.usageSource ?? "unknown"}`
    : result.costEstimate && result.costEstimate.estimatedCredits > 0 ? `≈ ${formatCredits(result.costEstimate.estimatedCredits)} credits` : "";
  const statusText = result.status && result.status !== "succeeded" ? result.status : null;
  const imageTitle = imageLabel(result.output);
  const panoramaSrc = type === "preview.panorama360" ? versionedAssetPreviewSrc(panoramaSourceSrc(result.output), previewVersion) ?? imageSrc : null;
  if (type === "preview.panorama360" && panoramaSrc) {
    return (
      <div className={`nodeResult panoramaResult ${result.status === "failed" ? "failed" : "succeeded"}`}>
        {statusText ? <div>{statusText}</div> : null}
        {creditCost ? <span className="nodeCost">{creditCost}</span> : null}
        {cost ? <span className="nodeCost">{cost}</span> : null}
        <Panorama360Viewer
          src={panoramaSrc}
          title={imageTitle}
          filename={downloadFilename(result.output)}
          onFixFrame={(output) => onFixNodeOutput?.(nodeId, output, { persist: false, logMessage: `Fixed current panorama frame for ${nodeId}.` })}
        />
      </div>
    );
  }
  if (imageSrc) {
    return (
      <div className={`nodeResult ${result.status === "failed" ? "failed" : "succeeded"}`}>
        {statusText ? <div>{statusText}</div> : null}
        {creditCost ? <span className="nodeCost">{creditCost}</span> : null}
        {cost ? <span className="nodeCost">{cost}</span> : null}
        <div className="nodeImageActions">
          <button
            className="nodeImageActionButton nodrag nopan"
            type="button"
            title="View image"
            onClick={(event) => {
              event.stopPropagation();
              onOpenImage?.({ src: imageSrc, title: imageTitle, filename: downloadFilename(result.output) });
            }}
          >
            <Eye size={16} strokeWidth={2.2} />
          </button>
          <button
            className="nodeImageActionButton nodrag nopan"
            type="button"
            title="Download image"
            onClick={(event) => {
              event.stopPropagation();
              onDownloadImage?.(imageSrc, downloadFilename(result.output));
            }}
          >
            <Download size={14} />
          </button>
          <button
            className={`nodeImageActionButton nodrag nopan ${outputPinned ? "pinned" : ""}`}
            type="button"
            title={outputPinned ? "Output is pinned for this project" : "Pin output for this project"}
            aria-pressed={outputPinned}
            onClick={(event) => { event.stopPropagation(); onFixNodeOutput?.(nodeId, result.output); }}
          >
            <Pin size={14} />
          </button>
        </div>
        <button
          className="nodeImagePreviewButton nodrag nopan"
          type="button"
          title="View image"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onImageResultContextMenu?.(event, nodeId, result);
          }}
          onClick={(event) => {
            event.stopPropagation();
            onOpenImage?.({ src: imageSrc, title: imageTitle, filename: downloadFilename(result.output) });
          }}
        >
          <img className="nodeImagePreview" src={imageSrc} alt="" />
        </button>
      </div>
    );
  }
  if (videoSrc) {
    const filename = downloadFilename(result.output, "snarkroute-video.mp4");
    return (
      <div className={`nodeResult ${result.status === "failed" ? "failed" : "succeeded"}`}>
        {statusText ? <div>{statusText}</div> : null}
        {creditCost ? <span className="nodeCost">{creditCost}</span> : null}
        {cost ? <span className="nodeCost">{cost}</span> : null}
        <div className="nodeImageActions">
          <button
            className="nodeImageActionButton nodrag nopan"
            type="button"
            title="Download video"
            onClick={(event) => {
              event.stopPropagation();
              onDownloadImage?.(videoSrc, filename);
            }}
          >
            <Download size={14} />
          </button>
          <button
            className={`nodeImageActionButton nodrag nopan ${outputPinned ? "pinned" : ""}`}
            type="button"
            title={outputPinned ? "Output is pinned for this project" : "Pin output for this project"}
            aria-pressed={outputPinned}
            onClick={(event) => { event.stopPropagation(); onFixNodeOutput?.(nodeId, result.output); }}
          >
            <Pin size={14} />
          </button>
        </div>
        <video className="nodeVideoPreview nodrag nopan" src={videoSrc} controls preload="metadata" />
      </div>
    );
  }
  const textOutput = result.status !== "failed" ? outputText(result.output) : null;
  const preview = result.error ? truncateText(userFacingErrorMessage(result.error), 420) : result.output === undefined ? "" : truncateText(JSON.stringify(result.output, null, 2), 420);
  return (
    <div className={`nodeResult ${result.status === "failed" ? "failed" : "succeeded"}`}>
      {statusText ? <div>{statusText}</div> : null}
      {creditCost ? <span className="nodeCost">{creditCost}</span> : null}
      {cost ? <span className="nodeCost">{cost}</span> : null}
      {textOutput !== null ? <textarea className="nodrag nopan nodeTextarea outputTextArea" readOnly value={textOutput} /> : preview ? <pre>{preview}</pre> : null}
      {result.status === "failed" && onConfigureMissingSecret ? <button className="nodeSmallButton nodrag nopan" onClick={onConfigureMissingSecret}><KeyRound size={14} /> Configure key</button> : null}
      {result.status === "succeeded" && hasPinnableOutput(result.output) ? <button className={`nodeSmallButton nodrag nopan ${outputPinned ? "pinned" : ""}`} aria-pressed={outputPinned} onClick={() => onFixNodeOutput?.(nodeId, result.output)}><Pin size={14} /> {outputPinned ? "Pinned output" : "Pin output"}</button> : null}
    </div>
  );
}

function hasPinnableOutput(output: unknown): boolean {
  if (output === undefined || output === null) return false;
  if (typeof output === "object" && !Array.isArray(output)) return Object.keys(output as Record<string, unknown>).length > 0;
  return true;
}

function LiveFisheyePreview({
  source,
  fovDegrees,
  yawDegrees,
  pitchDegrees,
  onOpenImage,
  onDownloadImage
}: {
  source: unknown;
  fovDegrees: number;
  yawDegrees: number;
  pitchDegrees: number;
  onOpenImage?: (image: ImageViewerState) => void;
  onDownloadImage?: (src: string, filename: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const src = imagePreviewSrc(source);
  const title = imageLabel(source) || "Live fisheye preview";

  useEffect(() => {
    if (!src) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    setLoaded(false);
    setError("");
    image.onload = () => {
      imageRef.current = image;
      setLoaded(true);
    };
    image.onerror = () => setError("Could not load input image.");
    image.src = src;
  }, [src]);

  useEffect(() => {
    if (!loaded || !imageRef.current || !canvasRef.current) return;
    renderFisheyeFrame(canvasRef.current, imageRef.current, { fovDegrees, yawDegrees, pitchDegrees });
  }, [loaded, fovDegrees, yawDegrees, pitchDegrees]);

  function currentDataUrl(size = 640): string | null {
    const image = imageRef.current;
    if (!image) return null;
    const canvas = document.createElement("canvas");
    const outputSize = Math.max(1, Math.min(size, image.naturalHeight || size));
    canvas.width = outputSize;
    canvas.height = outputSize;
    renderFisheyeFrame(canvas, image, { fovDegrees, yawDegrees, pitchDegrees });
    return canvas.toDataURL("image/png");
  }

  if (!src) return null;
  return (
    <div className="nodeResult succeeded liveFisheyeResult">
      <div className="nodeImageActions">
        <button
          className="nodeImageActionButton nodrag nopan"
          type="button"
          title="View image"
          disabled={!loaded}
          onClick={(event) => {
            event.stopPropagation();
            const dataUrl = currentDataUrl();
            if (dataUrl) onOpenImage?.({ src: dataUrl, title, filename: "fisheye-preview.png" });
          }}
        >
          <Eye size={16} strokeWidth={2.2} />
        </button>
        <button
          className="nodeImageActionButton nodrag nopan"
          type="button"
          title="Download image"
          disabled={!loaded}
          onClick={(event) => {
            event.stopPropagation();
            const dataUrl = currentDataUrl();
            if (dataUrl) onDownloadImage?.(dataUrl, "fisheye-preview.png");
          }}
        >
          <Download size={14} />
        </button>
      </div>
      <canvas ref={canvasRef} className="nodeImagePreview liveFisheyeCanvas" width={180} height={180} title={title} />
      {!loaded && !error ? <small className="nodeConnectedHint">loading input...</small> : null}
      {error ? <div className="nodeWarning">{error}</div> : null}
    </div>
  );
}

function Panorama360Viewer({ src, title, filename, onFixFrame }: { src: string; title: string; filename: string; onFixFrame?: (output: unknown) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const [view, setView] = useState({ yaw: 0, pitch: 0, fov: 55 });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [fixedAt, setFixedAt] = useState("");

  useEffect(() => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    setLoaded(false);
    setError("");
    setFixedAt("");
    image.onload = () => {
      imageRef.current = image;
      setLoaded(true);
    };
    image.onerror = () => setError("Could not load panorama image.");
    image.src = src;
  }, [src]);

  useEffect(() => {
    if (!loaded || !imageRef.current || !canvasRef.current) return;
    renderPanoramaFrame(canvasRef.current, imageRef.current, view);
  }, [loaded, view]);

  function currentFramePayload(): { dataUrl: string; output: unknown } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.split(",", 2)[1];
    if (!base64) throw new Error("Could not encode current panorama view.");
    const capturedAt = new Date().toISOString();
    return {
      dataUrl,
      output: {
        image: {
          base64,
          mimeType: "image/png",
          filename: panoramaSnapshotFilename(filename)
        },
        panorama: {
          projection: "equirectangular",
          sourceUrl: src,
          fixedFrame: {
            projection: "perspective",
            yaw: view.yaw,
            pitch: view.pitch,
            fov: view.fov,
            capturedAt
          }
        }
      }
    };
  }

  function captureCurrentView() {
    try {
      const payload = currentFramePayload();
      if (!payload) return;
      const link = document.createElement("a");
      link.href = payload.dataUrl;
      link.download = panoramaSnapshotFilename(filename);
      link.click();
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : "Could not capture current view.");
    }
  }

  function fixCurrentFrame() {
    try {
      const payload = currentFramePayload();
      if (!payload) return;
      onFixFrame?.(payload.output);
      setFixedAt(new Date().toLocaleTimeString());
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : "Could not fix current frame.");
    }
  }

  return (
    <div className="panoramaViewer nodrag nopan">
      <canvas
        ref={canvasRef}
        className="panoramaCanvas nodrag nopan"
        width={360}
        height={190}
        title={title}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          setView((current) => ({
            ...current,
            yaw: drag.yaw - (event.clientX - drag.x) * 0.006,
            pitch: clamp(drag.pitch + (event.clientY - drag.y) * 0.0045, -1.25, 1.25)
          }));
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onWheel={(event) => {
          event.preventDefault();
          setView((current) => ({ ...current, fov: clamp(current.fov + Math.sign(event.deltaY) * 5, 35, 90) }));
        }}
      />
      {!loaded && !error ? <div className="panoramaOverlay">Loading panorama...</div> : null}
      {error ? <div className="panoramaOverlay error">{error}</div> : null}
      <div className="panoramaControls">
        <label className="panoramaZoomControl nodrag nopan" title="Zoom">
          <input
            className="nodrag nopan"
            type="range"
            min={35}
            max={90}
            step={1}
            value={view.fov}
            disabled={!loaded}
            onChange={(event) => setView((current) => ({ ...current, fov: Number(event.target.value) }))}
          />
          <span>{view.fov}°</span>
        </label>
        <button className="nodeImageActionButton nodrag nopan" type="button" title="Fix current frame to node output" disabled={!loaded} onClick={fixCurrentFrame}>
          <CheckSquare size={14} />
        </button>
        <button className="nodeImageActionButton nodrag nopan" type="button" title="Capture current view as PNG" disabled={!loaded} onClick={captureCurrentView}>
          <Download size={14} />
        </button>
      </div>
      {fixedAt ? <div className="panoramaFixedStatus">Fixed {fixedAt}</div> : null}
    </div>
  );
}

function statusClass(status?: string): string {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  if (status === "pending") return "pending";
  return "";
}

function readyInputNodeResult(routeNode: RouteDoc["nodes"][number], current?: NodeRunResult): NodeRunResult | undefined {
  if (current?.status === "failed") return current;
  const pinnedOutput = pinnedOutputFromParams(routeNode.params);
  if (pinnedOutput !== undefined) {
    return {
      ...current,
      status: "succeeded",
      output: pinnedOutput,
      logs: ["Using pinned output"]
    };
  }
  if (routeNode.type === "input.text") return { ...current, status: "succeeded" };
  if (routeNode.type === "library.prompt") {
    const mode = String(routeNode.params?.mode ?? "linked");
    if (mode === "embedded") return String(routeNode.params?.embeddedText ?? "").trim() ? { ...current, status: "succeeded" } : current;
    return String(routeNode.params?.category ?? "").trim() && String(routeNode.params?.promptId ?? "").trim() ? { ...current, status: "succeeded" } : current;
  }
  if (routeNode.type === "input.file" || routeNode.type === "input.image" || routeNode.type === "input.video") {
    return String(routeNode.params?.path ?? "").trim() ? { ...current, status: "succeeded" } : current;
  }
  return current;
}

function readyNodeResult(
  routeNode: RouteDoc["nodes"][number],
  current: NodeRunResult | undefined,
  nodes: Node[],
  edges: Edge[],
  runResult: RunDisplayResult | null
): NodeRunResult | undefined {
  if (routeNode.type === "preview.image" || routeNode.type === "preview.panorama360") {
    return readyPreviewNodeResult(routeNode, current, nodes, edges, runResult);
  }
  if (routeNode.type === "transform.panorama360ToFisheye") {
    return readyFisheyeNodeResult(routeNode, current, nodes, edges, runResult);
  }
  return readyInputNodeResult(routeNode, current);
}

function readyFisheyeNodeResult(
  routeNode: RouteDoc["nodes"][number],
  current: NodeRunResult | undefined,
  nodes: Node[],
  edges: Edge[],
  runResult: RunDisplayResult | null
): NodeRunResult | undefined {
  const input = readyPreviewImageInput(routeNode, nodes, edges, runResult);
  if (input === undefined) return current;
  const completedAt = input.completedAt ?? current?.completedAt ?? current?.startedAt;
  return {
    ...current,
    status: "succeeded",
    output: {
      liveFisheye: {
        source: input.value,
        fovDegrees: numberParamValue(routeNode.params?.fovDegrees ?? routeNode.params?.angleDegrees ?? routeNode.params?.angle, 200),
        yawDegrees: numberParamValue(routeNode.params?.yawDegrees ?? routeNode.params?.yaw, 0),
        pitchDegrees: numberParamValue(routeNode.params?.pitchDegrees ?? routeNode.params?.pitch, -90)
      }
    },
    startedAt: input.startedAt ?? current?.startedAt ?? completedAt,
    completedAt
  };
}

function readyPreviewNodeResult(
  routeNode: RouteDoc["nodes"][number],
  current: NodeRunResult | undefined,
  nodes: Node[],
  edges: Edge[],
  runResult: RunDisplayResult | null
): NodeRunResult | undefined {
  const input = readyPreviewImageInput(routeNode, nodes, edges, runResult);
  if (input === undefined) return current;
  const inputSrc = imagePreviewSrc(input.value);
  const currentPanoramaSource = panoramaSourceSrc(current?.output);
  const inputMatchesFixedSource = Boolean(inputSrc && currentPanoramaSource && inputSrc === currentPanoramaSource);
  if (routeNode.type === "preview.panorama360" && inputMatchesFixedSource && hasFixedPanoramaFrame(current?.output) && (!input.completedAt || !current?.completedAt || input.completedAt <= current.completedAt)) {
    return current;
  }
  const completedAt = input.completedAt ?? current?.completedAt ?? current?.startedAt;
  return {
    ...current,
    status: "succeeded",
    output: routeNode.type === "preview.panorama360" ? { image: input.value, panorama: { projection: "equirectangular" } } : { image: input.value },
    startedAt: input.startedAt ?? current?.startedAt ?? completedAt,
    completedAt
  };
}

function readyPreviewImageInput(
  routeNode: RouteDoc["nodes"][number],
  nodes: Node[],
  edges: Edge[],
  runResult: RunDisplayResult | null
): { value: unknown; startedAt?: string; completedAt?: string } | undefined {
  const paramImage = routeNode.params?.image;
  if (imagePreviewSrc(paramImage)) return { value: paramImage };
  const incoming = edges.find((edge) => edge.target === routeNode.id && (!edge.targetHandle || edge.targetHandle === "image"));
  if (!incoming) return undefined;
  const sourceNode = nodes.find((node) => node.id === incoming.source)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
  const sourceResult = runResult?.nodeResults?.[incoming.source];
  const liveSourceResult = sourceNode?.type === "transform.panorama360ToFisheye" ? readyFisheyeNodeResult(sourceNode, sourceResult, nodes, edges, runResult) : undefined;
  const pinnedOutput = pinnedOutputFromParams(sourceNode?.params);
  const sourceOutput = liveSourceResult?.output ?? (sourceResult?.output !== undefined ? sourceResult.output : pinnedOutput);
  const value = readPreviewPort(sourceOutput, incoming.sourceHandle) ?? sourceAssetParamPreview(sourceNode);
  return imagePreviewSrc(value) || liveFisheyeOutput(value) ? { value, startedAt: liveSourceResult?.startedAt ?? sourceResult?.startedAt, completedAt: liveSourceResult?.completedAt ?? sourceResult?.completedAt } : undefined;
}

function hasFixedPanoramaFrame(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const panorama = (output as Record<string, unknown>).panorama;
  return Boolean(panorama && typeof panorama === "object" && !Array.isArray(panorama) && (panorama as Record<string, unknown>).fixedFrame);
}

function pinnedOutputFromParams(params: Record<string, unknown> | undefined): unknown {
  if (!params || !Object.prototype.hasOwnProperty.call(params, "pinnedOutput")) return undefined;
  return params.pinnedOutput;
}

function pinnedInitialNodeOutputs(nodes: RouteDoc["nodes"]): Record<string, unknown> {
  return Object.fromEntries(
    nodes.flatMap((node) => {
      const output = pinnedOutputFromParams(node.params);
      return output === undefined ? [] : [[node.id, output]];
    })
  );
}

function configureHandlerForError(message: string | undefined, handlers: Record<string, (() => void) | undefined>): (() => void) | undefined {
  if (!message) return undefined;
  const key = Object.keys(handlers).find((candidate) => message.includes(candidate));
  return key ? handlers[key] : undefined;
}

const nodeTypes = {
  interface: InterfaceNodeCard,
  route: RouteNodeCard
};

function InterfaceNodeCard({ data }: NodeProps) {
  const routeNode = data.routeNode as RouteDoc["nodes"][number] | undefined;
  const kind = routeNode?.type === "compound.output" ? "output" : "input";
  const portKind = portKindFromManifest(String(routeNode?.params?.kind ?? "data"));
  const title = kind === "input" ? "Input" : "Output";
  const subtitle = kind === "input" ? "Connect to one internal parameter" : "Connect from one internal result";

  return (
    <div className={`interfaceNodeCard ${kind}`}>
      <div className="interfaceNodeHeader">
        <div>
          <strong>{routeNode?.title ?? title}</strong>
          <span>{subtitle}</span>
        </div>
      </div>
      <div className={`interfacePortRow ${kind}`}>
        <span>{String(routeNode?.params?.portId ?? (kind === "input" ? "input" : "output"))}</span>
        <small>{portKind}</small>
      </div>
      <Handle
        className={`typedHandle ${portKind}`}
        id="value"
        type={kind === "input" ? "source" : "target"}
        position={kind === "input" ? Position.Right : Position.Left}
        title={`value: ${portKind}`}
      />
    </div>
  );
}

function getNodePorts(type: string, manifest?: NodeManifest, routeNode?: RouteDoc["nodes"][number]): { inputs: PortSpec[]; outputs: PortSpec[] } {
  if (type === "compound.subroute") {
    return {
      inputs: (routeNode?.compound?.inputs ?? []).map((port) => ({ id: port.id, kind: portKindFromManifest(String(port.kind ?? "json")), label: port.label ?? port.id })),
      outputs: (routeNode?.compound?.outputs ?? []).map((port) => ({ id: port.id, kind: portKindFromManifest(String(port.kind ?? "json")), label: port.label ?? port.id }))
    };
  }
  if (manifest && !isKnownBuiltInPortType(type)) {
    return {
      inputs: manifest.inputs.map((port) => manifestInputPortSpec(port)),
      outputs: manifest.outputs.map((port) => ({ id: port.id, kind: portKindFromManifest(port.type), label: port.label }))
    };
  }
  if (type === "input.text") return { inputs: [], outputs: [{ id: "text", kind: "text" }] };
  if (type === "input.file") return { inputs: [], outputs: [{ id: "file", kind: "file" }] };
  if (type === "input.image") return { inputs: [], outputs: [{ id: "image", kind: "image" }] };
  if (type === "input.video") return { inputs: [], outputs: [{ id: "video", kind: "video" }] };
  if (type === "library.prompt") return { inputs: [], outputs: [{ id: "text", kind: "text" }] };
  if (type === "dialogue.workbench") {
    const selectedOutputs = normalizeDialogueWorkbenchState(routeNode?.params?.state, {
      nodeId: routeNode?.id ?? "dialogue",
      defaultModelProfileId: String(routeNode?.params?.defaultModelProfileId ?? "text.default")
    }).selectedOutputs;
    return {
      inputs: [
        { id: "text", kind: "text", label: "Text", maxConnections: 12 },
        { id: "image", kind: "image", label: "Image", maxConnections: 12 },
        { id: "json", kind: "json", label: "JSON", maxConnections: 12 },
        { id: "context", kind: "conversation_context", label: "Context", maxConnections: 12 }
      ],
      outputs: [
        { id: "conversation_text", kind: "text", label: "conversation_text" },
        { id: "conversation_json", kind: "json", label: "conversation_json" },
        { id: "conversation_capsule", kind: "conversation_context", label: "conversation_capsule" },
        ...selectedOutputs.map((output) => ({ id: output.id, kind: portKindFromDialogueOutput(output.type), label: `${output.name}${output.status === "locked" ? " locked" : ""}` }))
      ]
    };
  }
  if (type === "text.promptCompose") {
    return {
      inputs: [
        { id: "subject", kind: "text", label: "Subject", maxConnections: 24 },
        { id: "style", kind: "text", label: "Style", maxConnections: 24 },
        { id: "scene", kind: "text", label: "Scene", maxConnections: 24 }
      ],
      outputs: [{ id: "text", kind: "text" }]
    };
  }
  if (type === "compound.input") return { inputs: [], outputs: [{ id: "value", kind: portKindFromManifest(String(routeNode?.params?.kind ?? "data")), label: "value" }] };
  if (type === "compound.output") return { inputs: [{ id: "value", kind: portKindFromManifest(String(routeNode?.params?.kind ?? "data")), label: "value" }], outputs: [] };
  if (type === "utility.null") return { inputs: [{ id: "input", kind: "data", label: "Any" }], outputs: [{ id: "output", kind: "data", label: "Output" }] };
  if (type === "replicate.clarity-upscaler") {
    return {
      inputs: [
        { id: "image", kind: "image" },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "gemini.nano-banana-2") {
    return {
      inputs: [
        { id: "images", kind: "image", maxConnections: 14 },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "gemini.llm") {
    return {
      inputs: [
        { id: "systemPrompt", kind: "text", label: "system" },
        { id: "prompt", kind: "text" },
        { id: "images", kind: "image", label: "Images", maxConnections: 14 }
      ],
      outputs: [
        { id: "text", kind: "text" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "local.stableDiffusion.textToImage") {
    return {
      inputs: [
        { id: "prompt", kind: "text" },
        { id: "negativePrompt", kind: "text", label: "negative" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "metadata", kind: "json" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "ai.image.sd15.qr_monster_hidden_control") {
    return {
      inputs: [
        { id: "controlImage", kind: "image", label: "image" },
        { id: "prompt", kind: "text" },
        { id: "negativePrompt", kind: "text", label: "negative" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "images", kind: "image", label: "images" },
        { id: "metadata", kind: "json" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "http.request") {
    return {
      inputs: [
        { id: "text", kind: "text" },
        { id: "json", kind: "json", label: "JSON" }
      ],
      outputs: [
        { id: "responseJson", kind: "json", label: "JSON" },
        { id: "responseText", kind: "text", label: "text" },
        { id: "output", kind: "json", label: "output" }
      ]
    };
  }
  if (type === "transform.chooseCameraPoint") {
    return {
      inputs: [{ id: "image", kind: "image", label: "Image" }],
      outputs: [
        { id: "view", kind: "image", label: "View" },
        { id: "panorama", kind: "image", label: "360" }
      ]
    };
  }
  if (type === "preview.image" || type === "preview.panorama360" || type === "transform.panorama360ToFisheye") return { inputs: [{ id: "image", kind: "image", label: "Image" }], outputs: [{ id: "image", kind: "image", label: "Image" }] };
  if (type === "ai.text") {
    return {
      inputs: [
        { id: "systemPrompt", kind: "text", label: "system" },
        { id: "prompt", kind: "text" },
        { id: "images", kind: "image", label: "Images", maxConnections: 14 }
      ],
      outputs: [
        { id: "text", kind: "text" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "ai.image.generate") {
    return {
      inputs: [
        { id: "images", kind: "image", maxConnections: 14 },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "polza.image.generate") {
    return {
      inputs: [
        { id: "images", kind: "image", maxConnections: 14 },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "polza.video.generate") {
    return {
      inputs: [
        { id: "images", kind: "image", label: "Images", maxConnections: polzaVideoImageInputLimit(routeNode) },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "video", kind: "video" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "polza.text") {
    return {
      inputs: [
        { id: "systemPrompt", kind: "text", label: "system" },
        { id: "prompt", kind: "text" },
        { id: "images", kind: "image", label: "Images", maxConnections: 14 }
      ],
      outputs: [
        { id: "text", kind: "text" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "replicate.model") return { inputs: [{ id: "input", kind: "json", label: "JSON" }], outputs: [{ id: "output", kind: "json", label: "JSON" }] };
  if (type === "output.text") return { inputs: [{ id: "from", kind: "text" }], outputs: [{ id: "text", kind: "text" }] };
  if (type === "output.file") return { inputs: [{ id: "from", kind: "text" }], outputs: [] };
  if (type === "transform.template") return { inputs: [{ id: "template", kind: "text" }], outputs: [{ id: "text", kind: "text" }] };
  if (type === "debug.log") return { inputs: [{ id: "value", kind: "json", label: "JSON" }], outputs: [{ id: "value", kind: "json", label: "JSON" }] };
  return { inputs: [{ id: "input", kind: "json", label: "JSON" }], outputs: [{ id: "output", kind: "json", label: "JSON" }] };
}

function portLabel(port: PortSpec, connectedCount: number): string {
  const base = port.label ?? port.id;
  return typeof port.maxConnections === "number" ? `${base} ${connectedCount}/${port.maxConnections}` : base;
}

function polzaVideoImageInputLimit(routeNode?: RouteDoc["nodes"][number]): number {
  return polzaVideoImageInputLimitForModel({ id: String(routeNode?.params?.model ?? "") });
}

function polzaVideoImageInputLimitForModel(modelInfo: Pick<PolzaModel, "id" | "maxImageInputs">): number {
  const explicit = Number(modelInfo.maxImageInputs);
  if (Number.isFinite(explicit) && explicit > 0 && !isPolzaVideoUpscaleModelId(modelInfo.id)) return Math.max(1, Math.floor(explicit));
  const model = String(modelInfo.id ?? "").toLowerCase();
  if (!model) return 14;
  if (isPolzaVideoUpscaleModelId(model)) return 1;
  if (/veo[-_]?3/.test(model)) return 2;
  if (/seedance/.test(model)) return 9;
  if (/wan/.test(model)) return 2;
  return 14;
}

function isPolzaVideoUpscaleModelId(modelId: string | undefined): boolean {
  return /(^|\/)(video-)?upscale|upscaler|topaz/i.test(String(modelId ?? ""));
}

function isPolzaVideoGenerationModel(model: PolzaModel): boolean {
  return !isPolzaVideoUpscaleModelId(model.id);
}

function inputConnectionCounts(nodeId: string, edges: Edge[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const edge of edges) {
    if (edge.target !== nodeId || !edge.targetHandle) continue;
    counts[edge.targetHandle] = (counts[edge.targetHandle] ?? 0) + 1;
  }
  return counts;
}

function activeFlowEdgeIds(nodes: Node[], edges: Edge[], nodeCatalog: NodeCatalogItem[]): Set<string> {
  const routeNodeById = new Map<string, RouteDoc["nodes"][number]>();
  for (const node of nodes) {
    if (isCompoundInterfaceNode(node)) continue;
    routeNodeById.set(node.id, node.data.routeNode as RouteDoc["nodes"][number]);
  }
  const seenByPort = new Map<string, number>();
  const active = new Set<string>();
  for (const edge of edges) {
    const targetRouteNode = routeNodeById.get(edge.target);
    if (!targetRouteNode || !edge.targetHandle) {
      active.add(edge.id);
      continue;
    }
    const targetManifest = nodeCatalog.find((item) => item.type === targetRouteNode.type)?.manifest;
    const targetPort = getNodePorts(targetRouteNode.type, targetManifest, targetRouteNode).inputs.find((port) => port.id === edge.targetHandle);
    const maxConnections = targetPort?.maxConnections ?? 1;
    const key = `${edge.target}:${edge.targetHandle}`;
    const index = seenByPort.get(key) ?? 0;
    seenByPort.set(key, index + 1);
    if (index < maxConnections) active.add(edge.id);
  }
  return active;
}

function inputConnectionCountsForActiveEdges(nodeId: string, edges: Edge[], activeEdgeIds: Set<string>): Record<string, number> {
  return inputConnectionCounts(nodeId, edges.filter((edge) => activeEdgeIds.has(edge.id)));
}

function ModelCreditBadge({ costEstimate }: { costEstimate?: CostEstimate }) {
  if (!costEstimate || costEstimate.estimatedCredits <= 0) return null;
  return (
    <span className="modelCreditBadge" title={creditPriceExplanation(costEstimate)}>
      <span className="modelCreditDot" aria-hidden="true" />
      <span>{formatCredits(costEstimate.estimatedCredits)}</span>
    </span>
  );
}

function manifestInputPortSpec(port: NodeManifest["inputs"][number]): PortSpec {
  const kind = portKindFromManifest(port.type);
  return {
    id: port.id,
    kind,
    label: port.label,
    maxConnections: port.id === "images" && kind === "image" ? 14 : undefined
  };
}

function isModelQuoteableNodeType(type: string): boolean {
  return ["ai.text", "ai.image.generate", "gemini.nano-banana-2", "polza.text", "polza.image.generate", "polza.video.generate"].includes(type);
}

function unknownQuotePreview(node: RouteDoc["nodes"][number]): ModelQuotePreview {
  return {
    selected: {
      logicalModel: String(node.params?.model ?? node.type),
      provider: "unknown",
      providerModel: String(node.params?.model ?? node.type),
      capability: node.type.includes("image") || node.type.includes("banana") ? "image.generate" : "text.generate",
      estimatedCost: null,
      currency: null,
      pricingSource: "unknown",
      confidence: "unknown",
      unit: "unknown",
      warnings: ["Quote preview is unavailable."]
    },
    alternatives: [],
    warnings: ["Quote preview is unavailable."]
  };
}

function isKnownBuiltInPortType(type: string): boolean {
  return type === "compound.subroute" || isPolzaNode(type) || library.some((item) => item.type === type);
}

function isCompoundInterfaceType(type: string): boolean {
  return type === "compound.input" || type === "compound.output";
}

function isCompoundInterfaceNode(node: Node): boolean {
  return isCompoundInterfaceType(String((node.data.routeNode as RouteDoc["nodes"][number] | undefined)?.type ?? ""));
}

function portKindFromManifest(value: string): PortKind {
  if (value === "text" || value === "image" || value === "video" || value === "file" || value === "json" || value === "data" || value === "conversation_context") return value;
  if (value === "number" || value === "boolean") return "data";
  return "json";
}

function portKindFromDialogueOutput(type: DialogueOutputType): PortKind {
  if (type === "text" || type === "image" || type === "file" || type === "json") return type;
  return "json";
}

function uniqueOutputId(outputs: DialogueSelectedOutput[], name: string): string {
  const base = (name.trim() || "output").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "output";
  const used = new Set(outputs.map((output) => output.id));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

function partText(part: DialogueContentPart): string {
  if (part.type === "text") return part.text;
  if (part.type === "image") return part.assetRef;
  if (part.type === "file") return part.assetRef;
  return JSON.stringify(part.value);
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function modelLabel(profileId: string, profiles: ModelProfile[], message: DialogueMessage): string {
  const profile = profiles.find((entry) => entry.id === profileId);
  if (profile) return `${profile.displayName} · ${profile.providerId}/${profile.modelId}`;
  return [profileId, message.actualProviderId, message.actualModelId].filter(Boolean).join(" · ");
}

function buildStudioModelProfiles(openRouterModels: OpenRouterModel[], polzaTextModels: PolzaModel[], polzaImageModels: PolzaModel[], polzaVideoModels: PolzaModel[]): ModelProfile[] {
  const dynamicOpenRouter = openRouterModels.slice(0, 80).map((model): ModelProfile => ({
    id: `openrouter:${model.id}`,
    displayName: model.name ? `${model.name} (OpenRouter)` : model.id,
    providerId: "openrouter",
    modelId: model.id,
    capabilities: openRouterModelCapabilities(model),
    costClass: "unknown",
    privacyClass: "external"
  }));
  const dynamicPolza = [...polzaTextModels, ...polzaImageModels, ...polzaVideoModels].slice(0, 80).map((model): ModelProfile => ({
    id: `polza:${model.id}`,
    displayName: model.name ? `${model.name} (Polza)` : model.id,
    providerId: "polza",
    modelId: model.id,
    capabilities: [...new Set<ModelProfile["capabilities"][number]>([
      "text",
      ...(polzaModelSupportsVisionInput(model) ? ["vision" as const] : []),
      ...(model.type === "image" ? ["image_generation" as const] : []),
      ...(model.type === "video" && !isPolzaVideoUpscaleModelId(model.id) ? ["video_generation" as const] : []),
      ...(model.type !== "image" && model.type !== "video" ? ["json_output" as const] : [])
    ])],
    costClass: "unknown",
    privacyClass: "external"
  }));
  const byId = new Map([...DEFAULT_MODEL_PROFILES, ...dynamicOpenRouter, ...dynamicPolza].map((profile) => [profile.id, profile]));
  return [...byId.values()];
}

function modelInfoItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
  if (!value || typeof value !== "object") return [];
  const models = (value as Record<string, unknown>).models;
  return Array.isArray(models) ? models.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry))) : [];
}

function isOpenRouterV1Model(record: Record<string, unknown>): boolean {
  return record.provider === "openrouter" && stringArrayValue(record.outputTypes).some((type) => type === "text" || type === "image" || type === "video");
}

function modelInfoToOpenRouterModel(record: Record<string, unknown>): OpenRouterModel {
  const metadata = recordValue(record.metadata);
  const inputTypes = stringArrayValue(record.inputTypes);
  const outputTypes = stringArrayValue(record.outputTypes);
  const kind = typeof record.kind === "string" ? record.kind : outputTypes.includes("video") ? "video" : outputTypes.includes("image") ? "image" : "text";
  const architecture = recordValue(record.architecture);
  const modelId = String(record.providerModelId ?? record.id ?? "");
  const displayName = String(record.displayName ?? record.name ?? record.title ?? record.providerModelId ?? record.id ?? "");
  return {
    id: modelId,
    provider: "openrouter",
    providerId: "openrouter",
    kind: kind === "image" || kind === "video" || kind === "text" ? kind : "text",
    name: displayName,
    title: displayName,
    capabilities: stringArrayValue(record.capabilities),
    inputTypes,
    outputTypes,
    pricing: Object.keys(recordValue(record.pricing)).length ? recordValue(record.pricing) : recordValue(metadata.pricing),
    pricingHint: typeof record.pricingHint === "string" ? record.pricingHint : undefined,
    metadata,
    defaultParameters: recordValue(record.defaultParameters),
    supported_parameters: stringArrayValue(record.supported_parameters).length ? stringArrayValue(record.supported_parameters) : stringArrayValue(metadata.supportedParameters),
    supported_aspect_ratios: stringArrayValue(record.supported_aspect_ratios).length ? stringArrayValue(record.supported_aspect_ratios) : stringArrayValue(metadata.supportedAspectRatios),
    supported_durations: stringArrayValue(record.supported_durations).length ? stringArrayValue(record.supported_durations) : stringArrayValue(metadata.supportedDurations),
    supported_resolutions: stringArrayValue(record.supported_resolutions).length ? stringArrayValue(record.supported_resolutions) : stringArrayValue(metadata.supportedResolutions),
    supported_frame_image_modes: stringArrayValue(record.supported_frame_image_modes).length ? stringArrayValue(record.supported_frame_image_modes) : stringArrayValue(metadata.supportedFrameImageModes),
    architecture: {
      input_modalities: stringArrayValue(architecture.input_modalities).length ? stringArrayValue(architecture.input_modalities) : inputTypes,
      output_modalities: stringArrayValue(architecture.output_modalities).length ? stringArrayValue(architecture.output_modalities) : outputTypes,
      modality: typeof architecture.modality === "string" ? architecture.modality : undefined
    }
  };
}

function modelInfoToPolzaModel(record: Record<string, unknown>, type: "chat" | "image" | "video"): PolzaModel {
  const metadata = recordValue(record.metadata);
  const storedModelId = String(record.storedModelId ?? record.providerModelId ?? record.id ?? "");
  const displayName = String(record.displayName ?? record.name ?? record.title ?? record.providerModelId ?? record.id ?? "");
  const generationParameters = Array.isArray(record.generationParameters)
    ? record.generationParameters as PolzaModel["generationParameters"]
    : Array.isArray(record.parameters)
      ? record.parameters as PolzaModel["generationParameters"]
    : Array.isArray(metadata.generationParameters)
      ? metadata.generationParameters as PolzaModel["generationParameters"]
      : undefined;
  return {
    id: storedModelId,
    name: displayName,
    title: displayName,
    providerId: "polza",
    capabilities: stringArrayValue(record.capabilities),
    inputTypes: stringArrayValue(record.inputTypes),
    outputTypes: stringArrayValue(record.outputTypes),
    type,
    iconPath: typeof record.iconPath === "string" ? record.iconPath : undefined,
    catalogModelId: typeof record.id === "string" ? record.id : undefined,
    catalogProviderModelId: typeof record.providerModelId === "string" ? record.providerModelId : undefined,
    catalogParameters: Array.isArray(record.parameters) ? record.parameters as PolzaModel["catalogParameters"] : undefined,
    short_description: typeof record.short_description === "string" ? record.short_description : typeof metadata.description === "string" ? metadata.description : undefined,
    supported_parameters: stringArrayValue(record.supported_parameters).length ? stringArrayValue(record.supported_parameters) : stringArrayValue(metadata.supportedParameters),
    generationParameters,
    maxImageInputs: typeof record.maxImageInputs === "number" ? record.maxImageInputs : typeof metadata.maxImageInputs === "number" ? metadata.maxImageInputs : undefined,
    pricing: Object.keys(recordValue(record.pricing)).length ? recordValue(record.pricing) : recordValue(metadata.pricing),
    pricingHint: typeof record.pricingHint === "string" ? record.pricingHint : undefined,
    metadata,
    defaultParameters: recordValue(record.defaultParameters),
    architecture: { input_modalities: stringArrayValue(record.inputTypes), output_modalities: stringArrayValue(record.outputTypes) }
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function isDialogueModelProfile(profile: ModelProfile): boolean {
  const capabilities = new Set(profile.capabilities);
  if (capabilities.has("text") || capabilities.has("vision") || capabilities.has("json_output") || capabilities.has("tool_calling")) return true;
  return !capabilities.has("image_generation") && !capabilities.has("video_generation") && !capabilities.has("audio");
}

function filterDialogueModelProfiles(profiles: ModelProfile[], query: string): ModelProfile[] {
  const normalized = query.trim().toLowerCase();
  const selected = normalized
    ? profiles.filter((profile) =>
        [
          profile.displayName,
          profile.id,
          profile.providerId,
          profile.modelId,
          profile.costClass,
          profile.privacyClass,
          ...(profile.capabilities ?? [])
        ].some((value) => String(value ?? "").toLowerCase().includes(normalized))
      )
    : profiles;
  return [...selected].sort((left, right) => modelSortScore(right) - modelSortScore(left) || left.displayName.localeCompare(right.displayName));
}

function modelSortScore(profile: ModelProfile): number {
  let score = 0;
  if (profile.capabilities.includes("vision")) score += 8;
  if (profile.capabilities.includes("text")) score += 4;
  if (profile.providerId === "openrouter") score += 2;
  if (profile.id === "text.default") score += 20;
  return score;
}

function openRouterModelCapabilities(model: OpenRouterModel): ModelProfile["capabilities"] {
  const input = model.architecture?.input_modalities ?? [];
  const output = model.architecture?.output_modalities ?? [];
  const capabilities: ModelProfile["capabilities"] = [];
  if (modelSupportsText(model)) capabilities.push("text");
  if (input.includes("image")) capabilities.push("vision");
  if (output.includes("image")) capabilities.push("image_generation");
  if (output.includes("video") || model.kind === "video" || modalityOutputModalities(model.architecture?.modality ?? "").includes("video")) capabilities.push("video_generation");
  if (model.supported_parameters?.includes("tools")) capabilities.push("tool_calling");
  if (model.supported_parameters?.includes("response_format")) capabilities.push("json_output");
  return [...new Set(capabilities)];
}

function connectedInputSummaries(
  nodeId: string,
  nodes: Node[],
  edges: Edge[],
  runResult: RunDisplayResult | null,
  nodeCatalog: NodeCatalogItem[]
): DialogueConnectedInput[] {
  return edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => {
      const sourceNode = nodes.find((node) => node.id === edge.source);
      const sourceRouteNode = sourceNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
      const sourceManifest = sourceRouteNode ? nodeCatalog.find((entry) => entry.type === sourceRouteNode.type)?.manifest : undefined;
      const sourcePort = sourceRouteNode ? getNodePorts(sourceRouteNode.type, sourceManifest, sourceRouteNode).outputs.find((port) => port.id === edge.sourceHandle) : undefined;
      const value = readPreviewPort(runResult?.nodeResults?.[edge.source]?.output, edge.sourceHandle) ?? sourceParamPreview(sourceRouteNode, edge.sourceHandle);
      const type = connectedDialogueInputType(edge.targetHandle, sourcePort?.kind ?? "json");
      const textValue = type === "text" ? textConnectedInputValue(value, sourceRouteNode) : value;
      return {
        id: edge.targetHandle ?? edge.source,
        type,
        sourceNodeId: edge.source,
        sourcePort: edge.sourceHandle ?? undefined,
        preview: type === "text" ? textPreviewValue(textValue) : previewValue(value),
        value,
        chipBackgroundAssetRef: type === "text" ? imageAssetRef(value) ?? imageAssetRef(sourceParamPreview(sourceRouteNode, edge.sourceHandle)) ?? undefined : undefined,
        sourceAccentColor: type === "text" ? sourceNodeAccentColor(sourceRouteNode) : undefined
      };
    });
}

function sourceNodeAccentColor(sourceNode: RouteDoc["nodes"][number] | undefined): string | undefined {
  const ui = sourceNode?.ui as Record<string, unknown> | undefined;
  const explicit = typeof ui?.accentColor === "string" ? ui.accentColor : typeof ui?.color === "string" ? ui.color : "";
  if (/^#[0-9a-f]{3,8}$/i.test(explicit.trim())) return explicit.trim();
  if (sourceNode?.type === "input.text" || sourceNode?.type === "library.prompt") return "#7dd3c0";
  if (sourceNode?.type.startsWith("text.")) return "#d8b4fe";
  return undefined;
}

function connectedDialogueInputType(targetHandle: string | null | undefined, sourceKind: PortKind): PortKind {
  if (targetHandle === "context") return "conversation_context";
  if (sourceKind === "text") return "text";
  if (targetHandle === "text" || targetHandle === "image" || targetHandle === "json") return targetHandle;
  return sourceKind;
}

function readPreviewPort(output: unknown, port?: string | null): unknown {
  if (!output || !port) return output;
  if (output && typeof output === "object" && port in output) return (output as Record<string, unknown>)[port];
  return output;
}

function sourceParamPreview(node: RouteDoc["nodes"][number] | undefined, port?: string | null): unknown {
  if (!node) return "";
  if (node.type === "input.text") return node.params?.value ?? "";
  if (node.type === "input.image" || node.type === "input.file" || node.type === "input.video") return node.params?.path ?? "";
  if (node.type === "transform.chooseCameraPoint") {
    if (port === "panorama") return node.params?.renderedPanorama ?? node.params?.panoramaImage ?? node.params?.outputPanorama ?? "";
    if (port === "view" || port === "image") return node.params?.renderedImage ?? node.params?.outputImage ?? "";
  }
  if (node.type === "dialogue.workbench" && port === "conversation_capsule") {
    const state = normalizeDialogueWorkbenchState(node.params?.state, { nodeId: node.id, defaultModelProfileId: String(node.params?.defaultModelProfileId ?? "text.default") });
    return buildDialogueWorkbenchOutputs({ nodeId: node.id, nodeTitle: node.title, state }).conversation_capsule;
  }
  return node.params ?? "";
}

function sourceAssetParamPreview(node: RouteDoc["nodes"][number] | undefined): unknown {
  if (!node) return "";
  if (node.type === "input.image" || node.type === "input.file" || node.type === "input.video") return node.params?.path ?? "";
  return "";
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return value.length > 700 ? `${value.slice(0, 697)}...` : value;
  return JSON.stringify(value ?? "", null, 2).slice(0, 900);
}

function textPreviewValue(value: unknown): string {
  if (typeof value === "string") return previewValue(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const text = record.text ?? record.prompt ?? record.value ?? record.description;
    if (typeof text === "string") return previewValue(text);
  }
  return previewValue(value);
}

function textConnectedInputValue(value: unknown, sourceNode: RouteDoc["nodes"][number] | undefined): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string" || typeof record.prompt === "string" || typeof record.value === "string" || typeof record.description === "string") return value;
  }
  const params = sourceNode?.params;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const record = params as Record<string, unknown>;
    return record.text ?? record.prompt ?? record.value ?? record.description ?? value;
  }
  return value;
}

function defaultParamsFromManifest(manifest?: NodeManifest): Record<string, unknown> {
  return Object.fromEntries((manifest?.params ?? []).map((param) => [param.id, param.default ?? ""]));
}

function catalogItemTitle(item: NodeCatalogItem | (typeof library)[number]): string {
  return "title" in item ? item.title : item.label;
}

function catalogItemPorts(item: NodeCatalogItem | (typeof library)[number]): { inputs: PortSpec[]; outputs: PortSpec[] } {
  return getNodePorts(item.type, "manifest" in item ? item.manifest : undefined);
}

type NodeCatalogSection = { id: string; title: string; types: string[]; items: NodeCatalogItem[] };

function groupNodeCatalog(items: NodeCatalogItem[], layout: NodeLibraryLayout): NodeCatalogSection[] {
  const hiddenTypes = new Set(layout.hiddenTypes);
  const visibleItems = items.filter((entry) => entry.enabled !== false && !hiddenTypes.has(entry.type));
  const itemByType = new Map(visibleItems.map((item) => [item.type, item]));
  const assignedTypes = new Set<string>();
  const groups = layout.groups.map((group) => {
    const groupItems = group.types.flatMap((type) => {
      const item = itemByType.get(type);
      if (!item) return [];
      assignedTypes.add(type);
      return [item];
    });
    return { id: group.id, title: group.title, types: [...group.types], items: sortCatalogItems(groupItems, group.types) };
  });
  const extraGroups = new Map<string, NodeCatalogItem[]>();
  for (const item of visibleItems) {
    if (assignedTypes.has(item.type)) continue;
    const title = item.manifest?.category ?? fallbackSectionTitle(item.type);
    extraGroups.set(title, [...(extraGroups.get(title) ?? []), item]);
  }
  return [
    ...groups,
    ...[...extraGroups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([title, sectionItems]) => ({ id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "nodes", title, types: sectionItems.map((item) => item.type), items: sortCatalogItems(sectionItems) }))
  ];
}

function fallbackSectionTitle(type: string): string {
  return librarySections.find((section) => section.types.includes(type))?.title ?? "Installed";
}

function studioDocKindLabel(kind: StudioDocEntry["kind"]): string {
  if (kind === "capabilities") return "Capabilities";
  if (kind === "prompt-library") return "Prompt Library";
  return "Guide";
}

function sortCatalogItems(items: NodeCatalogItem[], orderedTypes: string[] = []): NodeCatalogItem[] {
  return [...items].sort((left, right) => {
    const leftIndex = orderedTypes.indexOf(left.type);
    const rightIndex = orderedTypes.indexOf(right.type);
    if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
    return catalogItemTitle(left).localeCompare(catalogItemTitle(right));
  });
}

function catalogItemMatchesSearch(item: NodeCatalogItem, query: string): boolean {
  if (!query) return true;
  const manifest = item.manifest;
  const searchable = [
    item.title,
    item.type,
    item.description,
    manifest?.title,
    manifest?.id,
    manifest?.description,
    manifest?.category,
    manifest?.author.name,
    manifest?.origin,
    manifest?.source,
    ...(manifest?.tags ?? []),
    ...(manifest?.inputs ?? []).flatMap((port) => [port.id, port.type, port.label]),
    ...(manifest?.outputs ?? []).flatMap((port) => [port.id, port.type, port.label]),
    ...(manifest?.params ?? []).flatMap((param) => [param.id, param.type, param.label])
  ];
  return searchable.some((value) => String(value ?? "").toLowerCase().includes(query));
}

function connectionNodeEntryMatchesSearch(entry: ConnectionNodeEntry, query: string): boolean {
  if (!query) return true;
  if (entry.kind === "output") {
    return ["output", "compound output", entry.inputPort.id, entry.inputPort.kind, entry.inputPort.label]
      .some((value) => String(value ?? "").toLowerCase().includes(query));
  }
  return catalogItemMatchesSearch(entry.item, query)
    || [entry.inputPort.id, entry.inputPort.kind, entry.inputPort.label].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function defaultNodeLibraryLayout(): NodeLibraryLayout {
  return { groups: librarySections.map((section) => ({ id: section.id, title: section.title, types: [...section.types] })), hiddenTypes: [] };
}

function loadNodeLibraryLayout(): NodeLibraryLayout {
  try {
    const text = localStorage.getItem(NODE_LIBRARY_LAYOUT_STORAGE_KEY);
    if (!text) return defaultNodeLibraryLayout();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultNodeLibraryLayout();
    const record = parsed as { groups?: unknown; hiddenTypes?: unknown };
    const groups = Array.isArray(record.groups)
      ? record.groups.flatMap((group) => {
          if (!group || typeof group !== "object" || Array.isArray(group)) return [];
          const candidate = group as { id?: unknown; title?: unknown; types?: unknown };
          if (typeof candidate.id !== "string" || typeof candidate.title !== "string" || !Array.isArray(candidate.types)) return [];
          return [{ id: candidate.id, title: candidate.title, types: candidate.types.filter((type): type is string => typeof type === "string") }];
        })
      : [];
    const hiddenTypes = Array.isArray(record.hiddenTypes) ? record.hiddenTypes.filter((type): type is string => typeof type === "string") : [];
    return { groups: groups.length > 0 ? groups : defaultNodeLibraryLayout().groups, hiddenTypes };
  } catch {
    return defaultNodeLibraryLayout();
  }
}

function saveNodeLibraryLayout(layout: NodeLibraryLayout): void {
  try {
    localStorage.setItem(NODE_LIBRARY_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Library layout is a local Studio preference; route editing can continue without it.
  }
}

function withBuiltInCatalogItems(items: NodeCatalogItem[]): NodeCatalogItem[] {
  const known = new Set(items.map((item) => item.type));
  const missingBuiltIns = library
    .filter((item) => !known.has(item.type))
    .map((item) => ({ type: item.type, title: item.label, params: item.params }));
  return [...items, ...missingBuiltIns];
}

function canImportNodePackageFile(file: File): boolean {
  return canImportNodePackageFilename(file.name);
}

function permissionsSummary(manifest: NodeManifest): string {
  const permissions = manifest.permissions;
  return [
    permissions.network ? `network(${permissions.networkHosts?.join(", ") || "unspecified hosts"})` : "no network",
    permissions.readFiles ? "read files" : "no file reads",
    permissions.writeOutputs ? "write outputs" : "no output writes",
    permissions.shell ? "shell requested" : "no shell",
    permissions.env?.length ? `env: ${permissions.env.join(", ")}` : "no env"
  ].join("; ");
}

function requiresEnv(manifest: NodeManifest | undefined, key: string): boolean {
  return Boolean(manifest?.permissions.env?.includes(key));
}

function formatApiIssues(value: unknown): string {
  if (!value || typeof value !== "object") return "Request failed.";
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (Array.isArray(record.issues)) {
    return record.issues.map((issue) => {
      const item = issue as Record<string, unknown>;
      return `${item.path ?? "<root>"}: ${item.message ?? "invalid"}`;
    }).join("; ");
  }
  return "Request failed.";
}

function arePortsCompatible(source: PortKind, target: PortKind): boolean {
  if (source === "data" || target === "data") return true;
  if (source === "json" && target === "text") return true;
  if (source === "text" && target === "json") return true;
  return source === target;
}

function describeConnection(connection: Connection): string {
  return `${connection.source ?? "unknown"}.${connection.sourceHandle ?? "output"} -> ${connection.target ?? "unknown"}.${connection.targetHandle ?? "input"}`;
}

function countInputConnections(edges: Edge[], nodeId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const edge of edges) {
    if (edge.target !== nodeId || !edge.targetHandle) continue;
    counts[edge.targetHandle] = (counts[edge.targetHandle] ?? 0) + 1;
  }
  return counts;
}

function isReplicateNode(type: string): boolean {
  return type === "replicate.model" || type === "replicate.clarity-upscaler";
}

function isGeminiNode(type: string): boolean {
  return type === "gemini.nano-banana-2" || type === "gemini.llm";
}

function isRemoteAiNode(type: string): boolean {
  return type === "ai.text" || type === "ai.image.generate";
}

function isPolzaNode(type: string): boolean {
  return type === "polza.text" || type === "polza.image.generate" || type === "polza.video.generate";
}

function executorKind(type: string, manifest?: NodeManifest): string {
  if (manifest?.origin && manifest.origin !== "bundled") return "custom";
  if (manifest?.executor.type === "plugin") return "custom";
  if (type === "ai.image.sd15.qr_monster_hidden_control") return "local";
  if (type.startsWith("local.")) return "local";
  if (type.startsWith("ai.")) return "openrouter";
  if (type.startsWith("polza.")) return "polza";
  if (type.startsWith("gemini.")) return "gemini";
  if (type.startsWith("replicate.")) return "replicate";
  if (type.startsWith("http.")) return "http";
  if (type.startsWith("input.") || type.startsWith("output.") || type.startsWith("preview.") || type.startsWith("debug.") || type.startsWith("transform.") || type.startsWith("library.") || type.startsWith("compound.")) return "local";
  return "custom";
}

function executorLabel(type: string, manifest?: NodeManifest): string {
  if (manifest?.executor.type === "plugin") return `${manifest.executor.runtime ?? "plugin"} plugin`;
  if (manifest?.executor.type === "declarative") return "declarative";
  const kind = executorKind(type, manifest);
  if (kind === "gemini") return "Gemini";
  if (kind === "polza") return "Polza.ai";
  if (kind === "openrouter") return "OpenRouter";
  if (kind === "replicate") return "Replicate";
  if (kind === "http") return "HTTP";
  if (kind === "local") return "local";
  return "unknown/custom";
}

function shouldShowInlineResult(type: string): boolean {
  if (type === "transform.chooseCameraPoint") return false;
  return !type.startsWith("input.") && type !== "library.prompt";
}

function shouldShowNodeRunButton(type: string): boolean {
  return !type.startsWith("input.");
}

function nodeIcon(type: string) {
  if (type === "input.text") return <Type size={15} />;
  if (type === "input.image") return <ImageIcon size={15} />;
  if (type === "input.video") return <Video size={15} />;
  if (type === "library.prompt") return <BookOpen size={15} />;
  if (type === "dialogue.workbench") return <MessageSquareText size={15} />;
  if (type === "text.promptCompose") return <Braces size={15} />;
  if (type === "compound.input") return <ChevronRight size={15} />;
  if (type === "compound.output") return <ChevronRight size={15} />;
  if (type === "transform.template") return <Braces size={15} />;
  if (type === "transform.chooseCameraPoint") return <Globe size={15} />;
  if (type === "transform.panorama360ToFisheye") return <Aperture size={15} />;
  if (type === "replicate.clarity-upscaler") return <Wand2 size={15} />;
  if (type === "replicate.model") return <span className="providerGlyph">R</span>;
  if (type === "gemini.llm") return <Type size={15} />;
  if (type === "polza.text") return <span className="providerGlyph">P</span>;
  if (type === "polza.image.generate") return <ImageIcon size={15} />;
  if (type === "polza.video.generate") return <Film size={15} />;
  if (type === "ai.text") return <Type size={15} />;
  if (type === "ai.image.generate") return <ImageIcon size={15} />;
  if (type.includes("seedance")) return <Film size={15} />;
  if (type === "gemini.nano-banana-2") return <Sparkles size={15} />;
  if (type === "local.stableDiffusion.textToImage") return <Cpu size={15} />;
  if (type === "ai.image.sd15.qr_monster_hidden_control") return <Sparkles size={15} />;
  if (type === "http.request") return <Globe size={15} />;
  if (type === "preview.image" || type === "preview.panorama360") return <Eye size={15} />;
  if (type === "debug.log") return <Bug size={15} />;
  if (type === "utility.null") return <Eraser size={15} />;
  if (type === "compound.subroute") return <FolderOpen size={15} />;
  if (type === "output.text") return <FileText size={15} />;
  if (type === "output.file") return <Save size={15} />;
  return <FileJson size={15} />;
}

function compactNodeClass(type: string): string {
  return type === "transform.panorama360ToFisheye" || type === "transform.chooseCameraPoint" ? "compactRouteNode" : "";
}

function nodeIconClass(type: string): string {
  if (type.includes("seedance")) return "seedance";
  if (type.startsWith("input.")) return "input";
  if (type.startsWith("ai.")) return "gemini";
  if (type.startsWith("polza.")) return "polza";
  if (type === "compound.input") return "input";
  if (type.startsWith("library.")) return "transform";
  if (type.startsWith("dialogue.")) return "dialogue";
  if (type.startsWith("text.")) return "transform";
  if (type.startsWith("output.")) return "output";
  if (type === "compound.output") return "output";
  if (type.startsWith("replicate.")) return "replicate";
  if (type.startsWith("gemini.")) return "gemini";
  if (type.startsWith("local.")) return "local";
  if (type.startsWith("http.")) return "http";
  if (type.startsWith("preview.")) return "preview";
  if (type.startsWith("debug.")) return "debug";
  if (type.startsWith("utility.")) return "debug";
  if (type.startsWith("transform.")) return "transform";
  if (type === "compound.subroute") return "transform";
  return "generic";
}

function flowToRoute(nodes: Node[], edges: Edge[], baseRoute: RouteDoc): RouteDoc {
  const routeNodes = nodes.filter((node) => !isCompoundInterfaceNode(node));
  const routeNodeIds = new Set(routeNodes.map((node) => node.id));
  const routeEdges = edges.filter((edge) => routeNodeIds.has(edge.source) && routeNodeIds.has(edge.target));
  return {
    routeVersion: baseRoute.routeVersion,
    route: baseRoute.route,
    economics: baseRoute.economics,
    nodes: routeNodes.map((node) => {
      const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
      return { ...routeNode, ui: { ...(routeNode.ui ?? {}), x: node.position.x, y: node.position.y } };
    }),
    edges: routeEdges.map((edge) => ({
      id: edge.id,
      from: edge.source,
      to: edge.target,
      fromPort: edge.sourceHandle ?? undefined,
      toPort: edge.targetHandle ?? undefined
    })),
    provenance: { tool: "snarkroute-studio", updatedAt: new Date().toISOString() }
  };
}

function routeWithOnlyActiveEdges(route: RouteDoc, nodeCatalog: NodeCatalogItem[]): RouteDoc {
  const routeNodeById = new Map(route.nodes.map((node) => [node.id, node]));
  const seenByPort = new Map<string, number>();
  return {
    ...route,
    edges: route.edges.filter((edge) => {
      const targetRouteNode = routeNodeById.get(edge.to);
      if (!targetRouteNode || !edge.toPort) return true;
      const targetManifest = nodeCatalog.find((item) => item.type === targetRouteNode.type)?.manifest;
      const targetPort = getNodePorts(targetRouteNode.type, targetManifest, targetRouteNode).inputs.find((port) => port.id === edge.toPort);
      const maxConnections = targetPort?.maxConnections ?? 1;
      const key = `${edge.to}:${edge.toPort}`;
      const index = seenByPort.get(key) ?? 0;
      seenByPort.set(key, index + 1);
      return index < maxConnections;
    })
  };
}

function flowToCompoundInterface(nodes: Node[], edges: Edge[], nodeCatalog: NodeCatalogItem[]): CompoundInterface {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const inputMappings = edges.flatMap((edge): CompoundPortMapping[] => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target || !isCompoundInterfaceNode(source) || isCompoundInterfaceNode(target)) return [];
    const sourceRouteNode = source.data.routeNode as RouteDoc["nodes"][number];
    if (sourceRouteNode.type !== "compound.input") return [];
    const targetRouteNode = target.data.routeNode as RouteDoc["nodes"][number];
    const targetManifest = nodeCatalog.find((item) => item.type === targetRouteNode.type)?.manifest;
    const targetPort = getNodePorts(targetRouteNode.type, targetManifest, targetRouteNode).inputs.find((port) => port.id === edge.targetHandle);
    const id = String(sourceRouteNode.params?.portId ?? sourceRouteNode.id);
    return [{ id, label: sourceRouteNode.title ?? id, kind: targetPort?.kind ?? String(sourceRouteNode.params?.kind ?? "data"), nodeId: edge.target, port: edge.targetHandle ?? "input" }];
  });
  const outputMappings = edges.flatMap((edge): CompoundPortMapping[] => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target || isCompoundInterfaceNode(source) || !isCompoundInterfaceNode(target)) return [];
    const targetRouteNode = target.data.routeNode as RouteDoc["nodes"][number];
    if (targetRouteNode.type !== "compound.output") return [];
    const sourceRouteNode = source.data.routeNode as RouteDoc["nodes"][number];
    const sourceManifest = nodeCatalog.find((item) => item.type === sourceRouteNode.type)?.manifest;
    const sourcePort = getNodePorts(sourceRouteNode.type, sourceManifest, sourceRouteNode).outputs.find((port) => port.id === edge.sourceHandle);
    const id = String(targetRouteNode.params?.portId ?? targetRouteNode.id);
    return [{ id, label: targetRouteNode.title ?? id, kind: sourcePort?.kind ?? String(targetRouteNode.params?.kind ?? "data"), nodeId: edge.source, port: edge.sourceHandle ?? "output" }];
  });
  return { inputs: mergeCompoundInputMappings(inputMappings, (mapping) => mapping.id), outputs: uniqueCompoundMappings(outputMappings) };
}

function routeSnapshot(route: RouteDoc): string {
  return JSON.stringify({
    routeVersion: route.routeVersion,
    route: route.route,
    economics: route.economics ?? null,
    nodes: route.nodes,
    edges: route.edges.map(({ id: _id, ...edge }) => edge),
    provenance: route.provenance ? { ...route.provenance, updatedAt: undefined } : null
  });
}

function compactBreadcrumbTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length <= 10) return normalized;
  return normalized.slice(-10);
}

function loadInitialRoute(): { route: RouteDoc; loadedSavedProject: boolean } {
  try {
    const text = localStorage.getItem(SAVED_PROJECT_STORAGE_KEY);
    if (!text) return { route: parseBundledDefaultRoute(), loadedSavedProject: false };
    return { route: loadRouteFromText(text, "saved-project.orp.json") as RouteDoc, loadedSavedProject: true };
  } catch {
    return { route: parseBundledDefaultRoute(), loadedSavedProject: false };
  }
}

function parseBundledDefaultRoute(): RouteDoc {
  try {
    return loadRouteFromText(JSON.stringify(defaultRouteDocument), DEFAULT_ROUTE_FILENAME) as RouteDoc;
  } catch {
    return blankRoute;
  }
}

function loadLibraryNodeMetadata(): LibraryNodeMetadata {
  try {
    const text = localStorage.getItem(LIBRARY_NODE_METADATA_STORAGE_KEY);
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([id, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const record = value as { status?: unknown; order?: unknown };
        const status = isLibraryNodeStatus(record.status) ? record.status : undefined;
        const order = typeof record.order === "number" && Number.isFinite(record.order) ? record.order : undefined;
        return [[id, { status, order }]];
      })
    );
  } catch {
    return {};
  }
}

function saveLibraryNodeMetadata(metadata: LibraryNodeMetadata): void {
  try {
    localStorage.setItem(LIBRARY_NODE_METADATA_STORAGE_KEY, JSON.stringify(metadata));
  } catch {
    // Metadata is a UI convenience; route editing should keep working if storage is unavailable.
  }
}

function isLibraryNodeStatus(value: unknown): value is LibraryNodeStatus {
  return typeof value === "string" && libraryNodeStatuses.some((status) => status.id === value);
}

function libraryNodeStatusLabel(status: LibraryNodeStatus): string {
  return libraryNodeStatuses.find((item) => item.id === status)?.label ?? status;
}

function defaultLibraryNodeStatus(node: NodeManifest): LibraryNodeStatus {
  return node.enabled === false ? "archived" : "candidate";
}

function libraryNodeStatus(node: NodeManifest, metadata: LibraryNodeMetadata): LibraryNodeStatus {
  return metadata[node.id]?.status ?? defaultLibraryNodeStatus(node);
}

function libraryNodeOrder(node: NodeManifest, metadata: LibraryNodeMetadata, fallbackOrder: number): number {
  return metadata[node.id]?.order ?? fallbackOrder;
}

function flowToNodeRoute(nodes: Node[], edges: Edge[], baseRoute: RouteDoc, targetNodeId: string): RouteDoc {
  const included = new Set<string>([targetNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (included.has(edge.target) && !included.has(edge.source)) {
        included.add(edge.source);
        changed = true;
      }
    }
  }
  return flowToRoute(
    nodes.filter((node) => included.has(node.id)),
    edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
    {
      ...baseRoute,
      route: {
        ...baseRoute.route,
        id: `${baseRoute.route.id}-${targetNodeId}`,
        title: `${baseRoute.route.title}: ${targetNodeId}`
      }
    }
  );
}

function useBlinkingFavicon(active: boolean) {
  useEffect(() => {
    const favicon = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!favicon) return undefined;

    if (!active) {
      favicon.href = STUDIO_FAVICON_HREF;
      return undefined;
    }

    const image = new Image();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    let intervalId = 0;
    let stopped = false;

    canvas.width = 64;
    canvas.height = 64;

    const drawFrame = (lit: boolean) => {
      if (stopped || !context) return;
      const glowAlpha = lit ? 0.9 : 0.12;
      const lampAlpha = lit ? 1 : 0.22;

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      context.save();
      context.globalAlpha = glowAlpha;
      context.fillStyle = "#f59e0b";
      context.beginPath();
      context.arc(50, 14, 14, 0, Math.PI * 2);
      context.fill();
      context.restore();

      context.save();
      context.globalAlpha = lampAlpha;
      context.fillStyle = "#fde047";
      context.strokeStyle = "#92400e";
      context.lineWidth = 3;
      context.beginPath();
      context.arc(50, 14, 9, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.restore();

      favicon.href = canvas.toDataURL("image/png");
    };

    image.onload = () => {
      if (stopped) return;
      let lit = true;
      drawFrame(lit);
      intervalId = window.setInterval(() => {
        lit = !lit;
        drawFrame(lit);
      }, 650);
    };
    image.onerror = () => {
      favicon.href = STUDIO_FAVICON_HREF;
    };
    image.src = STUDIO_FAVICON_HREF;

    return () => {
      stopped = true;
      if (intervalId) window.clearInterval(intervalId);
      favicon.href = STUDIO_FAVICON_HREF;
    };
  }, [active]);
}

function App() {
  const initialRouteState = useMemo(() => loadInitialRoute(), []);
  const initial = useMemo(() => routeToFlow(initialRouteState.route), [initialRouteState.route]);
  const canvasRef = useRef<HTMLElement | null>(null);
  const promptAssetMenuRef = useRef<HTMLDivElement | null>(null);
  const [routeBase, setRouteBase] = useState<RouteDoc>(initialRouteState.route);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const nodesRef = useRef<Node[]>(initial.nodes);
  const edgesRef = useRef<Edge[]>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paramsText, setParamsText] = useState("{}");
  const [paramsError, setParamsError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>(initialRouteState.loadedSavedProject ? ["Loaded saved project.", "BoojumRoute Lab ready."] : ["BoojumRoute Lab ready."]);
  const [outputs, setOutputs] = useState<unknown>(null);
  const [runResult, setRunResult] = useState<RunDisplayResult | null>(null);
  const [staleResultNodeIds, setStaleResultNodeIds] = useState<Set<string>>(() => new Set());
  const undoStackRef = useRef<Array<{ nodes: Node[]; edges: Edge[]; selectedId: string | null; label: string }>>([]);
  const [replicateToken, setReplicateToken] = useState("");
  const [replicateConfigured, setReplicateConfigured] = useState(false);
  const [geminiToken, setGeminiToken] = useState("");
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [openAiToken, setOpenAiToken] = useState("");
  const [openAiConfigured, setOpenAiConfigured] = useState(false);
  const [openAiMaskedKey, setOpenAiMaskedKey] = useState("");
  const [worldLabsToken, setWorldLabsToken] = useState("");
  const [worldLabsConfigured, setWorldLabsConfigured] = useState(false);
  const [worldLabsMaskedKey, setWorldLabsMaskedKey] = useState("");
  const [seedanceToken, setSeedanceToken] = useState("");
  const [seedanceConfigured, setSeedanceConfigured] = useState(false);
  const [seedanceMaskedKey, setSeedanceMaskedKey] = useState("");
  const [seedanceSettings, setSeedanceSettings] = useState<SeedanceSettings>({ configured: false });
  const [seedanceBackend, setSeedanceBackend] = useState("");
  const [seedanceBaseUrl, setSeedanceBaseUrl] = useState("");
  const [polzaToken, setPolzaToken] = useState("");
  const [polzaConfigured, setPolzaConfigured] = useState(false);
  const [polzaMaskedKey, setPolzaMaskedKey] = useState("");
  const [openRouterToken, setOpenRouterToken] = useState("");
  const [openRouterSettings, setOpenRouterSettings] = useState<OpenRouterSettings>({ configured: false });
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [catalogImageModels, setCatalogImageModels] = useState<UnifiedModelInfo[] | null>(null);
  const [modelOptionsForNodes, setModelOptionsForNodes] = useState<Record<string, ModelOptionForNodeV1[] | undefined>>({});
  const [polzaTextModels, setPolzaTextModels] = useState<PolzaModel[]>([]);
  const [polzaImageModels, setPolzaImageModels] = useState<PolzaModel[]>([]);
  const [polzaVideoModels, setPolzaVideoModels] = useState<PolzaModel[]>([]);
  const [openRouterDefaultModel, setOpenRouterDefaultModel] = useState("text.default");
  const [openRouterBudgetWarningUsd, setOpenRouterBudgetWarningUsd] = useState("");
  const [providerLinks, setProviderLinks] = useState<ProviderLinks>({});
  const [capabilities, setCapabilities] = useState<AppCapabilities>(DEFAULT_APP_CAPABILITIES);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [devIdentity, setDevIdentity] = useState<"guest" | "user" | "admin">("guest");
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null);
  const [adminMessage, setAdminMessage] = useState("");
  const [creditBalance, setCreditBalance] = useState<{ balance: number; currency: string } | null>(null);
  const [creditTransactions, setCreditTransactions] = useState<CreditTransaction[]>([]);
  const [creditHistoryOpen, setCreditHistoryOpen] = useState(false);
  const [runCostEstimate, setRunCostEstimate] = useState<RunCostSummary | null>(null);
  const [userSessionCredentials, setUserSessionCredentials] = useState<Record<string, string>>({});
  const [apiConnected, setApiConnected] = useState(false);
  const [apiError, setApiError] = useState("");
  const [shuttingDown, setShuttingDown] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [canvasBackgroundTheme, setCanvasBackgroundTheme] = useState<CanvasBackgroundTheme>(() => loadCanvasBackgroundTheme());
  const [systemUpdateStatus, setSystemUpdateStatus] = useState<SystemUpdateStatus | null>(null);
  const [systemUpdating, setSystemUpdating] = useState(false);
  const [pendingBrowse, setPendingBrowse] = useState<{ nodeId: string; kind: AssetKind } | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [bottomCollapsed, setBottomCollapsed] = useState(true);
  const [ledgerSummary, setLedgerSummary] = useState<LedgerSummary | null>(null);
  const [promptLibrary, setPromptLibrary] = useState<PromptLibraryData>(DEFAULT_PROMPT_LIBRARY);
  const [promptLibraryStatusFilter, setPromptLibraryStatusFilter] = useState<PromptStatusFilter>("all");
  const [stableDiffusionModels, setStableDiffusionModels] = useState<StableDiffusionModel[]>([]);
  const [nodeCatalog, setNodeCatalog] = useState<NodeCatalogItem[]>(() => library.map((item) => ({ type: item.type, title: item.label, params: item.params })));
  const [nodeSearch, setNodeSearch] = useState("");
  const [showHiddenNodes, setShowHiddenNodes] = useState(false);
  const [installedNodes, setInstalledNodes] = useState<NodeManifest[]>([]);
  const [nodeUrl, setNodeUrl] = useState("");
  const [nodePackagePath, setNodePackagePath] = useState("");
  const [libraryUrl, setLibraryUrl] = useState("");
  const [libraryPreview, setLibraryPreview] = useState<NodeLibraryPreview | null>(null);
  const [selectedLibraryNodeIds, setSelectedLibraryNodeIds] = useState<Record<string, boolean>>({});
  const [libraryInstallStatus, setLibraryInstallStatus] = useState<LibraryNodeStatus>("candidate");
  const [libraryNodeMetadata, setLibraryNodeMetadata] = useState<LibraryNodeMetadata>(() => loadLibraryNodeMetadata());
  const [libraryStatusFilter, setLibraryStatusFilter] = useState<LibraryStatusFilter>("all");
  const [librarySearch, setLibrarySearch] = useState("");
  const [librarySortMode, setLibrarySortMode] = useState<LibrarySortMode>("status");
  const [nodeLibraryLayout, setNodeLibraryLayout] = useState<NodeLibraryLayout>(() => loadNodeLibraryLayout());
  const [exampleMenuOpen, setExampleMenuOpen] = useState(false);
  const [docsMenuOpen, setDocsMenuOpen] = useState(false);
  const [activeDoc, setActiveDoc] = useState<StudioDocEntry | null>(null);
  const [activeDialogueWorkbenchId, setActiveDialogueWorkbenchId] = useState<string | null>(null);
  const [modelQuotePreviews, setModelQuotePreviews] = useState<Record<string, ModelQuotePreview>>({});
  const [quoteRefreshTick, setQuoteRefreshTick] = useState(0);
  const [loadedRouteSnapshot, setLoadedRouteSnapshot] = useState(() => routeSnapshot(initialRouteState.route));
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [imageViewer, setImageViewer] = useState<ImageViewerState | null>(null);
  const [collapsedLibrarySections, setCollapsedLibrarySections] = useState<Record<string, boolean>>(
    () => ({})
  );
  const [pendingConnectionStart, setPendingConnectionStart] = useState<PendingConnectionStart | null>(null);
  const [connectionNodeMenu, setConnectionNodeMenu] = useState<ConnectionNodeMenuState | null>(null);
  const [connectionNodeSearch, setConnectionNodeSearch] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [libraryItemMenu, setLibraryItemMenu] = useState<LibraryItemMenuState | null>(null);
  const [librarySectionMenu, setLibrarySectionMenu] = useState<LibrarySectionMenuState | null>(null);
  const [promptAssetMenu, setPromptAssetMenu] = useState<PromptAssetMenuState | null>(null);
  const [promptLibraryMenu, setPromptLibraryMenu] = useState<PromptLibraryMenuState | null>(null);
  const [promptAssetDraft, setPromptAssetDraft] = useState<PromptAssetDraft | null>(null);
  const [promptAssetError, setPromptAssetError] = useState("");
  const [promptAssetSaving, setPromptAssetSaving] = useState(false);
  const [routeStack, setRouteStack] = useState<SubrouteFrame[]>([]);
  const supportsLocalFilesystem = capabilities.supportsLocalFilesystem;
  const isCloudMode = capabilities.mode === "cloud";
  const isAdmin = currentUser?.role === "admin";
  const showDeveloperDiagnostics = capabilities.supportsDeveloperDiagnostics && (!isCloudMode || isAdmin);
  const productLabel = capabilities.product === "snark" ? "SnarkRoute" : "Boojum";
  const currentUserLabel = currentUser ? (currentUser.displayName || currentUser.email || currentUser.id) : "Guest";
  const routeEstimatedCredits = Math.max(0, Math.ceil(runCostEstimate?.totalEstimatedCredits ?? 0));
  const routeHasPaidEstimate = routeEstimatedCredits > 0;
  const routeHasEnoughCredits = !isCloudMode || !currentUser || !creditBalance || creditBalance.balance >= routeEstimatedCredits;
  const routeBalanceAfter = currentUser && creditBalance ? creditBalance.balance - routeEstimatedCredits : null;
  const runDisabledReason = isCloudMode && currentUser && creditBalance && routeHasPaidEstimate && !routeHasEnoughCredits
    ? `Not enough credits: need ${formatCredits(routeEstimatedCredits)}, balance ${formatCredits(creditBalance.balance)}`
    : "";

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes, quoteRefreshTick]);

  useEffect(() => {
    if (isAdmin) void loadAdminOverview();
    else setAdminOverview(null);
  }, [isAdmin]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    saveCanvasBackgroundTheme(canvasBackgroundTheme);
  }, [canvasBackgroundTheme]);

  useEffect(() => {
    if (!promptAssetMenu) return;

    const animationFrame = window.requestAnimationFrame(() => promptAssetMenuRef.current?.focus());
    const closeIfOutside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && promptAssetMenuRef.current?.contains(target)) return;
      setPromptAssetMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPromptAssetMenu(null);
    };

    window.addEventListener("pointerdown", closeIfOutside, true);
    window.addEventListener("focusin", closeIfOutside, true);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("pointerdown", closeIfOutside, true);
      window.removeEventListener("focusin", closeIfOutside, true);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [promptAssetMenu]);

  useEffect(() => {
    function handleUndoKey(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "z" || isTextEditingTarget(event.target)) return;
      event.preventDefault();
      undoLastAction();
    }
    window.addEventListener("keydown", handleUndoKey);
    return () => window.removeEventListener("keydown", handleUndoKey);
  }, []);

  useBlinkingFavicon(runResult?.status === "running");

  const selectedNode = nodes.find((node) => node.id === selectedId);
  const activeDialogueRouteNode = activeDialogueWorkbenchId
    ? nodes.find((node) => node.id === activeDialogueWorkbenchId)?.data.routeNode as RouteDoc["nodes"][number] | undefined
    : undefined;
  const contextNode = contextMenu?.nodeId ? nodes.find((node) => node.id === contextMenu.nodeId) : null;
  const contextRouteNode = contextNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
  const selectedNodeCount = nodes.filter((node) => node.selected).length;
  const selectedEdgeCount = edges.filter((edge) => edge.selected).length;
  const activeEdgeIds = useMemo(() => activeFlowEdgeIds(nodes, edges, nodeCatalog), [nodes, edges, nodeCatalog]);
  const highlightedNodeIds = useMemo(() => new Set(nodes.filter((node) => node.selected || node.id === selectedId).map((node) => node.id)), [nodes, selectedId]);
  const displayEdges = useMemo(
    () => edges.map((edge) => {
      const selected = Boolean(edge.selected);
      const inactive = !activeEdgeIds.has(edge.id);
      const highlighted = selected || highlightedNodeIds.has(edge.source) || highlightedNodeIds.has(edge.target);
      if (!highlighted && !inactive) return edge;
      return {
        ...edge,
        className: [edge.className, highlighted ? "highlightedRouteEdge" : "", selected ? "selectedRouteEdge" : "", inactive ? "inactiveRouteEdge" : ""].filter(Boolean).join(" "),
        style: {
          ...edge.style,
          stroke: inactive ? "#667085" : selected ? "#9ef5df" : "#7dd3c0",
          strokeDasharray: inactive ? "6 6" : edge.style?.strokeDasharray,
          strokeWidth: inactive ? 1.8 : selected ? 3.5 : 2.5,
          opacity: inactive ? 0.48 : edge.style?.opacity
        },
        zIndex: selected ? 1001 : 1000
      };
    }),
    [edges, highlightedNodeIds, activeEdgeIds]
  );
  const canvasThemeConfig = availableCanvasThemes.find((theme) => theme.id === canvasBackgroundTheme) ?? availableCanvasThemes[0];
  const catalogSections = useMemo(() => groupNodeCatalog(nodeCatalog, nodeLibraryLayout), [nodeCatalog, nodeLibraryLayout]);
  const nodeSearchQuery = nodeSearch.trim().toLowerCase();
  const hiddenNodeTypes = useMemo(() => new Set(nodeLibraryLayout.hiddenTypes), [nodeLibraryLayout.hiddenTypes]);
  const hiddenNodeCount = nodeCatalog.filter((item) => item.enabled !== false && hiddenNodeTypes.has(item.type)).length;
  const visibleCatalogSections = useMemo(
    () => {
      const includeHidden = nodeSearchQuery || showHiddenNodes;
      const sections = includeHidden ? groupNodeCatalog(nodeCatalog, { ...nodeLibraryLayout, hiddenTypes: [] }) : catalogSections;
      return sections
        .map((section) => {
          const routeItems = routeStack.length > 0 ? section.items : section.items.filter((item) => !isCompoundInterfaceType(item.type));
          const items = nodeSearchQuery ? routeItems.filter((item) => catalogItemMatchesSearch(item, nodeSearchQuery)) : routeItems;
          return { ...section, items };
        })
        .filter((section) => {
          if (nodeSearchQuery) return section.items.length > 0;
          if (section.items.length > 0) return true;
          return section.types.length === 0;
        });
    },
    [catalogSections, nodeCatalog, nodeLibraryLayout, nodeSearchQuery, routeStack.length, showHiddenNodes]
  );
  const visibleCatalogItemCount = visibleCatalogSections.reduce((sum, section) => sum + section.items.length, 0);
  const librarySelectedCount = Object.values(selectedLibraryNodeIds).filter(Boolean).length;
  const libraryStatusCounts = useMemo(() => {
    const counts: Record<LibraryNodeStatus, number> = { draft: 0, candidate: 0, approved: 0, published: 0, archived: 0 };
    for (const node of installedNodes) counts[libraryNodeStatus(node, libraryNodeMetadata)] += 1;
    return counts;
  }, [installedNodes, libraryNodeMetadata]);
  const visibleInstalledNodes = useMemo(() => {
    const query = librarySearch.trim().toLowerCase();
    const withIndex = installedNodes.map((node, index) => ({
      node,
      status: libraryNodeStatus(node, libraryNodeMetadata),
      order: libraryNodeOrder(node, libraryNodeMetadata, index)
    }));
    return withIndex
      .filter(({ node, status }) => {
        if (libraryStatusFilter !== "all" && status !== libraryStatusFilter) return false;
        if (!query) return true;
        return [node.title, node.id, node.description, node.category, node.author.name, node.source].some((value) => String(value ?? "").toLowerCase().includes(query));
      })
      .sort((left, right) => {
        if (librarySortMode === "title") return left.node.title.localeCompare(right.node.title) || left.node.id.localeCompare(right.node.id);
        if (librarySortMode === "manual") return left.order - right.order || left.node.title.localeCompare(right.node.title);
        const leftStatus = libraryNodeStatuses.findIndex((status) => status.id === left.status);
        const rightStatus = libraryNodeStatuses.findIndex((status) => status.id === right.status);
        return leftStatus - rightStatus || left.order - right.order || left.node.title.localeCompare(right.node.title);
      });
  }, [installedNodes, libraryNodeMetadata, librarySearch, librarySortMode, libraryStatusFilter]);
  const modelProfiles = useMemo(() => buildStudioModelProfiles(openRouterModels, polzaTextModels, polzaImageModels, polzaVideoModels), [openRouterModels, polzaTextModels, polzaImageModels, polzaVideoModels]);
  const agentPresets = DEFAULT_AGENT_PRESETS;
  const activeDialogueInputs = useMemo(
    () => activeDialogueWorkbenchId ? connectedInputSummaries(activeDialogueWorkbenchId, nodes, edges, runResult, nodeCatalog) : [],
    [activeDialogueWorkbenchId, nodes, edges, runResult, nodeCatalog]
  );
  const routeBreadcrumbs = useMemo(
    () =>
      routeStack.map((frame) => {
        const compound = frame.parentRoute.nodes.find((node) => node.id === frame.compoundId);
        return { id: frame.compoundId, title: compound?.title ?? compound?.compound?.title ?? frame.compoundId };
      }),
    [routeStack]
  );
  const displayNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          manifest: nodeCatalog.find((item) => item.type === String((node.data.routeNode as RouteDoc["nodes"][number]).type))?.manifest,
          isMissingNode: !isKnownBuiltInPortType(String((node.data.routeNode as RouteDoc["nodes"][number]).type)) && !nodeCatalog.some((item) => item.type === String((node.data.routeNode as RouteDoc["nodes"][number]).type)),
          onParamsChange: updateNodeParams,
          onParamsCollapsedChange: updateNodeParamsCollapsed,
          paramsCollapsed: routeNodeParamsCollapsed(node.data.routeNode as RouteDoc["nodes"][number]),
          onBrowseAsset: browseAsset,
          onConfigureReplicate: openReplicateSettings,
          onConfigureGemini: openGeminiSettings,
          onConfigureOpenAi: openOpenAiSettings,
          onConfigureSeedance: openSeedanceSettings,
          onConfigureWorldLabs: openWorldLabsSettings,
          onConfigurePolza: openPolzaSettings,
          onConfigureOpenRouter: openOpenRouterSettings,
          onOpenImage: setImageViewer,
          onDownloadImage: downloadImageSrc,
          onImageResultContextMenu: supportsLocalFilesystem ? openPromptAssetMenu : undefined,
          onFixNodeOutput: fixNodeOutput,
          onRunNodeOnly: runNodeOnly,
          onRunNodeWithDependencies: runNodeWithDependencies,
          onOpenSubroute: openSubroute,
          onOpenDialogueWorkbench: openDialogueWorkbench,
          onUncollapse: uncollapseCompoundNode,
          onNodeUiChange: updateNodeUi,
          onPublishNodeOutput: publishNodeOutput,
          onRefreshPromptLibrary: refreshPromptLibraryData,
          promptStatusFilter: promptLibraryStatusFilter,
          onPromptStatusFilterChange: setPromptLibraryStatusFilter,
          onPromptContextMenu: supportsLocalFilesystem ? openPromptLibraryMenu : undefined,
          onRefreshStableDiffusionModels: refreshStableDiffusionModels,
          supportsLocalFilesystem,
          costEstimate: runCostEstimate?.estimates.find((estimate) => estimate.nodeId === node.id),
          connectedInputPorts: edges.filter((edge) => edge.target === node.id).map((edge) => edge.targetHandle).filter((handle): handle is string => Boolean(handle)),
          connectedInputCounts: inputConnectionCountsForActiveEdges(node.id, edges, activeEdgeIds),
          resizeInputImage: String((node.data.routeNode as RouteDoc["nodes"][number]).type) === "transform.imageResize"
            ? readyPreviewImageInput(node.data.routeNode as RouteDoc["nodes"][number], nodes, edges, runResult)?.value
            : undefined,
          chooseCameraInputImage: String((node.data.routeNode as RouteDoc["nodes"][number]).type) === "transform.chooseCameraPoint"
            ? readyPreviewImageInput(node.data.routeNode as RouteDoc["nodes"][number], nodes, edges, runResult)?.value
            : undefined,
          canRunNodeOnly: canRunNodeOnly(node.id),
          promptLibrary,
          stableDiffusionModels,
          openRouterConfigured: openRouterSettings.configured,
          openRouterModels,
          catalogImageModels,
          modelOptionsForNodes,
          modelProfiles,
          polzaConfigured,
          polzaTextModels,
          polzaImageModels,
          polzaVideoModels,
          quotePreview: modelQuotePreviews[node.id],
          onRefreshPricing: refreshPricingCatalog,
          creditBalance: currentUser ? creditBalance : null,
          openAiConfigured,
          seedanceConfigured,
          seedanceStatusText: seedanceSettings.statusText,
          replicateConfigured,
          geminiConfigured,
          result: staleResultNodeIds.has(node.id) ? undefined : readyNodeResult(node.data.routeNode as RouteDoc["nodes"][number], runResult?.nodeResults?.[node.id], nodes, edges, runResult)
        }
      })),
    [nodes, edges, activeEdgeIds, runResult, staleResultNodeIds, promptLibrary, promptLibraryStatusFilter, stableDiffusionModels, supportsLocalFilesystem, runCostEstimate, openRouterSettings.configured, openRouterModels, catalogImageModels, modelOptionsForNodes, modelProfiles, polzaConfigured, polzaTextModels, polzaImageModels, polzaVideoModels, modelQuotePreviews, currentUser, creditBalance, openAiConfigured, seedanceConfigured, seedanceSettings.statusText, replicateConfigured, geminiConfigured, nodeCatalog]
  );

  useEffect(() => {
    void loadCapabilities();
    void loadCurrentUser();
    void loadCreditBalance();
    void loadCreditTransactions();
    void loadSettings();
    void loadSystemUpdateStatus();
    void loadProviderLinks();
    void loadCatalogImageModels();
    void loadModelOptionsForNodes();
    void loadOpenRouterModels();
    void loadPolzaModels();
    void loadNodeCatalog();
    void loadPromptLibraryData();
    void loadLedgerSummary();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshRunCostEstimate();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [nodes, edges, routeBase]);

  useEffect(() => {
    const quoteableNodes = nodes
      .map((node) => node.data.routeNode as RouteDoc["nodes"][number])
      .filter((node) => isModelQuoteableNodeType(node.type));
    if (quoteableNodes.length === 0) {
      setModelQuotePreviews({});
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const entries = await Promise.all(quoteableNodes.map(async (node) => {
        try {
          const response = await fetch(`${apiBase}/api/model-gateway/quote`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nodeType: node.type, params: node.params ?? {} })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? "Quote preview unavailable.");
          return [node.id, result as ModelQuotePreview] as const;
        } catch {
          return [node.id, unknownQuotePreview(node)] as const;
        }
      }));
      if (!cancelled) setModelQuotePreviews(Object.fromEntries(entries));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [nodes]);

  useEffect(() => {
    saveLibraryNodeMetadata(libraryNodeMetadata);
  }, [libraryNodeMetadata]);

  useEffect(() => {
    saveNodeLibraryLayout(nodeLibraryLayout);
  }, [nodeLibraryLayout]);

  useEffect(() => {
    async function handlePaste(event: ClipboardEvent) {
      if (isTextEditingTarget(event.target)) return;
      const file = imageFileFromClipboard(event);
      if (!file) return;
      event.preventDefault();
      try {
        await addAssetNodeFromFile(file, "image", flowPositionFromViewportCenter(), "Pasted image");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLogs((entries) => [`Paste import error: ${message}`, ...entries]);
      }
    }

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [nodeCatalog, reactFlowInstance]);

  async function loadNodeCatalog() {
    try {
      const response = await fetch(`${apiBase}/api/nodes`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Node catalog unavailable.");
      const catalog = Array.isArray(result.nodes)
        ? result.nodes.map((entry: NodeCatalogItem) => {
            const fallback = library.find((item) => item.type === entry.type);
            return { ...entry, title: entry.title ?? entry.manifest?.title ?? fallback?.label ?? entry.type, params: fallback?.params ?? defaultParamsFromManifest(entry.manifest) };
          })
        : [];
      setNodeCatalog(withBuiltInCatalogItems(catalog));
      try {
        const installedResponse = await fetch(`${apiBase}/api/node-packages/installed`);
        const installedResult = await installedResponse.json();
        if (!installedResponse.ok) throw new Error(installedResult.error ?? "Installed node registry refresh failed.");
        setInstalledNodes(Array.isArray(installedResult.nodes) ? installedResult.nodes : []);
      } catch (error) {
        setLogs((current) => [`Installed node registry refresh failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
      }
    } catch (error) {
      setNodeCatalog(library.map((item) => ({ type: item.type, title: item.label, params: item.params })));
      setLogs((current) => [`Node catalog unavailable: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  async function loadCapabilities() {
    try {
      const response = await fetch(`${apiBase}/api/capabilities`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Capabilities unavailable.");
      setCapabilities({ ...DEFAULT_APP_CAPABILITIES, ...result });
    } catch (error) {
      setCapabilities(DEFAULT_APP_CAPABILITIES);
      setLogs((current) => [`Capabilities unavailable: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  async function loadCurrentUser() {
    try {
      const response = await apiFetch(`${apiBase}/api/auth/current`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Current user unavailable.");
      setCurrentUser(result.user ?? null);
      setDevIdentity(result.user?.role === "admin" ? "admin" : result.user ? "user" : "guest");
    } catch {
      setCurrentUser(null);
      setDevIdentity("guest");
    }
  }

  async function loadCreditBalance() {
    try {
      const response = await apiFetch(`${apiBase}/api/billing/balance`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Balance unavailable.");
      setCreditBalance({ balance: Number(result.balance ?? 0), currency: String(result.currency ?? "credits") });
    } catch {
      setCreditBalance(null);
    }
  }

  async function loadCreditTransactions(limit = 25) {
    try {
      const response = await apiFetch(`${apiBase}/api/billing/transactions?limit=${limit}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Credit history unavailable.");
      const rows = Array.isArray(result.transactions) ? result.transactions : Array.isArray(result) ? result : [];
      setCreditTransactions(rows.map(normalizeCreditTransaction).filter(Boolean) as CreditTransaction[]);
    } catch {
      setCreditTransactions([]);
    }
  }

  async function loadAdminOverview() {
    try {
      const response = await apiFetch(`${apiBase}/api/admin/overview`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Admin overview unavailable.");
      setAdminOverview(result as AdminOverview);
      setAdminMessage("");
    } catch (error) {
      setAdminOverview(null);
      setAdminMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function switchDevIdentity(identity: "guest" | "user" | "admin") {
    try {
      const response = await apiFetch(`${apiBase}/api/dev/switch-identity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Dev identity switch unavailable.");
      setDevIdentity(identity);
      await loadCurrentUser();
      void loadCreditBalance();
      void loadCreditTransactions();
      if (identity === "admin") void loadAdminOverview();
      else setAdminOverview(null);
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshRunCostEstimate(route: RouteDoc = routeWithOnlyActiveEdges(flowToRoute(nodesRef.current, edgesRef.current, routeBase), nodeCatalog)) {
    try {
      const response = await apiFetch(`${apiBase}/api/billing/estimate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(route)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Estimate unavailable.");
      setRunCostEstimate(result as RunCostSummary);
    } catch {
      setRunCostEstimate(null);
    }
  }

  async function login() {
    try {
      const response = await apiFetch(`${apiBase}/api/auth/login`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Login unavailable.");
      setCurrentUser(result.user ?? null);
      void loadCreditBalance();
      void loadCreditTransactions();
      setSettingsMessage(result.user ? `Logged in as ${result.user.displayName ?? result.user.email ?? result.user.id}.` : "Local mode does not require login.");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function startProviderLogin(provider: "google" | "yandex") {
    window.location.href = `${apiBase}/api/auth/${provider}/start`;
  }

  async function logout() {
    try {
      const response = await apiFetch(`${apiBase}/api/auth/logout`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Logout unavailable.");
      await loadCurrentUser();
      void loadCreditBalance();
      setCreditTransactions([]);
      setSettingsMessage("Logged out.");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadSettings() {
    try {
      const response = await fetch(`${apiBase}/api/settings`);
      if (!response.ok) throw new Error(localApiUnavailableMessage(apiBase));
      const result = await response.json();
      setReplicateConfigured(Boolean(result.replicate?.configured ?? result.replicateConfigured));
      setGeminiConfigured(Boolean(result.gemini?.configured ?? result.geminiConfigured));
      setOpenAiConfigured(Boolean(result.openai?.configured));
      setOpenAiMaskedKey(String(result.openai?.maskedApiKey ?? ""));
      setWorldLabsConfigured(Boolean(result.worldlabs?.configured));
      setWorldLabsMaskedKey(String(result.worldlabs?.maskedApiKey ?? ""));
      const nextSeedance = result.seedance ?? { configured: false };
      setSeedanceSettings(nextSeedance);
      setSeedanceConfigured(Boolean(nextSeedance.configured));
      setSeedanceMaskedKey(String(nextSeedance.maskedApiKey ?? ""));
      setSeedanceBackend(String(nextSeedance.backend ?? ""));
      setSeedanceBaseUrl(nextSeedance.baseUrlSource === "custom" ? String(nextSeedance.baseUrl ?? "") : "");
      setPolzaConfigured(Boolean(result.polza?.configured));
      setPolzaMaskedKey(String(result.polza?.maskedApiKey ?? ""));
      setOpenRouterSettings(result.openrouter ?? { configured: false });
      setOpenRouterDefaultModel(String(result.openrouter?.defaultModel ?? "text.default"));
      setOpenRouterBudgetWarningUsd(result.openrouter?.budgetWarningUsd == null ? "" : String(result.openrouter.budgetWarningUsd));
      setApiConnected(true);
      setApiError("");
    } catch {
      const message = localApiUnavailableMessage(apiBase);
      setApiConnected(false);
      setReplicateConfigured(false);
      setGeminiConfigured(false);
      setOpenAiConfigured(false);
      setOpenAiMaskedKey("");
      setWorldLabsConfigured(false);
      setWorldLabsMaskedKey("");
      setSeedanceConfigured(false);
      setSeedanceMaskedKey("");
      setSeedanceSettings({ configured: false });
      setSeedanceBackend("");
      setSeedanceBaseUrl("");
      setPolzaConfigured(false);
      setPolzaMaskedKey("");
      setOpenRouterSettings({ configured: false });
      setApiError(message);
      setSettingsMessage(message);
    }
  }

  async function loadSystemUpdateStatus() {
    try {
      const response = await fetch(`${apiBase}/api/system/update/status`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Update status unavailable.");
      setSystemUpdateStatus(result);
    } catch (error) {
      setSystemUpdateStatus({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function updateAppFromGitHub() {
    if (systemUpdating) return;
    const confirmed = window.confirm("Update BoojumRoute from GitHub now? Local changes must be clean. Restart the app after a successful update.");
    if (!confirmed) return;
    setSystemUpdating(true);
    setSettingsMessage("Updating from GitHub...");
    try {
      const response = await fetch(`${apiBase}/api/system/update`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "GitHub update failed.");
      setSystemUpdateStatus(result.after ?? null);
      const before = result.before?.commit ? String(result.before.commit) : "previous";
      const after = result.after?.commit ? String(result.after.commit) : "latest";
      const changed = before !== after;
      setSettingsMessage(changed ? `Updated from ${before} to ${after}. Restart the app to use the new version.` : "Already up to date. Restart only if you expect newly installed dependencies.");
      setLogs((current) => [`GitHub update: ${changed ? `${before} -> ${after}` : "already up to date"}`, ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`GitHub update failed: ${message}`, ...current]);
      void loadSystemUpdateStatus();
    } finally {
      setSystemUpdating(false);
    }
  }

  async function shutdownServices() {
    if (shuttingDown) return;
    const confirmed = window.confirm("Close BoojumRoute Lab and stop local services?");
    if (!confirmed) return;
    setShuttingDown(true);
    setLogs((current) => ["Stopping local services...", ...current]);
    try {
      const response = await fetch(`${apiBase}/api/system/shutdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studioPort: window.location.port })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(result.error ?? "Shutdown request failed."));
      setLogs((current) => ["Shutdown requested. Local windows and services should close shortly.", ...current]);
      window.setTimeout(() => window.close(), 700);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setShuttingDown(false);
      setLogs((current) => [`Shutdown failed: ${message}`, ...current]);
    }
  }

  async function loadProviderLinks() {
    try {
      const response = await fetch(`${apiBase}/api/providers/links`);
      const result = await response.json();
      if (response.ok) setProviderLinks(result);
    } catch {
      setProviderLinks({});
    }
  }

  async function loadCatalogImageModels() {
    try {
      const models = await fetchImageCatalogModels();
      setCatalogImageModels(models.length > 0 ? models : null);
      if (models.length > 0) setLogs((current) => [`Image model catalog loaded: ${models.length} models.`, ...current]);
    } catch {
      setCatalogImageModels(null);
    }
  }

  async function loadModelOptionsForNodes() {
    const nodeTypes = ["polza.image.generate", "polza.text", "polza.video.generate", "ai.image.generate", "ai.text"];
    try {
      const entries = await Promise.all(nodeTypes.map(async (nodeType) => [nodeType, await fetchModelsForNode(nodeType)] as const));
      setModelOptionsForNodes(Object.fromEntries(entries));
      const total = entries.reduce((sum, [, models]) => sum + models.length, 0);
      if (total > 0) setLogs((current) => [`Model Catalog V1 node options loaded: ${total} options.`, ...current]);
    } catch {
      setModelOptionsForNodes({});
    }
  }

  async function loadOpenRouterModels() {
    try {
      const response = await fetch(`${apiBase}/api/models/v1`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Model Catalog V1 unavailable.");
      const models = modelInfoItems(result).filter(isOpenRouterV1Model).map(modelInfoToOpenRouterModel);
      setOpenRouterModels(models);
      const videoModels = models.filter((model: OpenRouterModel) => model.outputTypes?.includes("video"));
      if (videoModels.length > 0) setLogs((current) => [`OpenRouter V1 video models: ${videoModels.map((model: OpenRouterModel) => `${model.id} [${model.kind ?? "unknown"}]`).join(", ")}`, ...current]);
      if (models.length > 0) setLogs((current) => [`OpenRouter Model Catalog V1 loaded: ${models.length} models.`, ...current]);
    } catch {
      setOpenRouterModels([]);
    }
  }

  async function loadPolzaModels() {
    try {
      const [textResponse, imageResponse, videoResponse] = await Promise.all([
        fetch(`${apiBase}/api/models/for-node/polza.text`),
        fetch(`${apiBase}/api/models/for-node/polza.image.generate`),
        fetch(`${apiBase}/api/models/for-node/polza.video.generate`)
      ]);
      const [textResult, imageResult, videoResult] = await Promise.all([textResponse.json(), imageResponse.json(), videoResponse.json()]);
      setPolzaTextModels(textResponse.ok ? modelInfoItems(textResult).map((model) => modelInfoToPolzaModel(model, "chat")) : []);
      setPolzaImageModels(imageResponse.ok ? modelInfoItems(imageResult).map((model) => modelInfoToPolzaModel(model, "image")) : []);
      setPolzaVideoModels(videoResponse.ok ? modelInfoItems(videoResult).map((model) => modelInfoToPolzaModel(model, "video")) : []);
    } catch {
      setPolzaTextModels([]);
      setPolzaImageModels([]);
      setPolzaVideoModels([]);
    }
  }

  async function loadLedgerSummary() {
    try {
      const response = await fetch(`${apiBase}/api/ledger/summary`);
      if (!response.ok) throw new Error("Ledger API unavailable.");
      setLedgerSummary(await response.json());
    } catch {
      setLedgerSummary(null);
    }
  }

  async function loadPromptLibraryData() {
    try {
      const response = await fetch(`${apiBase}/api/prompt-library`);
      const result = await response.json();
      const fallbackMessage = result.error ?? "data/prompt-library/ was not found.";
      setPromptLibrary({ categories: response.ok && Array.isArray(result.categories) ? result.categories : DEFAULT_PROMPT_LIBRARY.categories });
      if (!response.ok) setLogs((current) => [`Prompt library unavailable: ${fallbackMessage}. Showing bundled starter prompt. Restart the API server to use the local library file.`, ...current]);
    } catch {
      setPromptLibrary(DEFAULT_PROMPT_LIBRARY);
    }
  }

  async function refreshPromptLibraryData() {
    try {
      const response = await fetch(`${apiBase}/api/prompt-library/refresh`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Prompt library refresh failed.");
      setPromptLibrary({ categories: Array.isArray(result.categories) ? result.categories : [], diagnostics: result.diagnostics ?? [] });
      const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
      setLogs((current) => [
        `Prompt library refreshed: ${result.categories?.length ?? 0} categor${result.categories?.length === 1 ? "y" : "ies"}.`,
        ...diagnostics.map((entry: { severity: string; path: string; message: string }) => `${entry.severity}: ${entry.path}: ${entry.message}`),
        ...current
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLogs((current) => [`Prompt library refresh failed: ${message}`, ...current]);
    }
  }

  function openPromptAssetMenu(event: React.MouseEvent, nodeId: string, result: NodeRunResult) {
    setContextMenu(null);
    setPromptLibraryMenu(null);
    setPromptAssetMenu({ clientX: event.clientX, clientY: event.clientY, nodeId, result });
  }

  function openPromptLibraryMenu(event: React.MouseEvent, prompt: PromptLibraryPrompt) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setPromptAssetMenu(null);
    setPromptLibraryMenu({ clientX: event.clientX, clientY: event.clientY, prompt });
  }

  async function updatePromptLibraryPrompt(prompt: PromptLibraryPrompt, patch: { status?: string; category?: string }) {
    if (!prompt.category || !prompt.id) return;
    try {
      const response = await fetch(`${apiBase}/api/prompt-library/${encodeURIComponent(prompt.category)}/${encodeURIComponent(prompt.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Prompt update failed.");
      if (result.library) setPromptLibrary(result.library);
      if (patch.category && patch.category !== prompt.category) retargetPromptLibraryNodes(prompt.category, prompt.id, patch.category);
      setLogs((current) => [`Updated prompt ${patch.category ?? prompt.category}/${prompt.id}.`, ...current]);
    } catch (error) {
      setLogs((current) => [`Prompt update failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  async function deletePromptLibraryPrompt(prompt: PromptLibraryPrompt) {
    if (!prompt.category || !prompt.id) return;
    const used = nodes.some((node) => {
      const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
      return routeNode.type === "library.prompt" && routeNode.params?.category === prompt.category && routeNode.params?.promptId === prompt.id;
    });
    const message = used
      ? `Delete prompt "${prompt.category}/${prompt.id}"?\n\nIt is used by the current route and that node will become unresolved.`
      : `Delete prompt "${prompt.category}/${prompt.id}"?`;
    if (!window.confirm(message)) return;
    try {
      const response = await fetch(`${apiBase}/api/prompt-library/${encodeURIComponent(prompt.category)}/${encodeURIComponent(prompt.id)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Prompt delete failed.");
      if (result.library) setPromptLibrary(result.library);
      setLogs((current) => [`Deleted prompt ${prompt.category}/${prompt.id}.`, ...current]);
    } catch (error) {
      setLogs((current) => [`Prompt delete failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  function movePromptLibraryPrompt(prompt: PromptLibraryPrompt) {
    const currentCategory = prompt.category ?? "";
    const nextCategory = window.prompt("Move prompt to category", currentCategory)?.trim();
    if (!nextCategory || nextCategory === currentCategory) return;
    void updatePromptLibraryPrompt(prompt, { category: slugFromText(nextCategory) || nextCategory });
  }

  function retargetPromptLibraryNodes(previousCategory: string, promptId: string, nextCategory: string) {
    setNodes((current) =>
      current.map((node) => {
        const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
        if (routeNode.type !== "library.prompt" || routeNode.params?.category !== previousCategory || routeNode.params?.promptId !== promptId) return node;
        const updated = { ...routeNode, params: { ...(routeNode.params ?? {}), category: nextCategory } };
        return { ...node, data: { ...node.data, routeNode: updated } };
      })
    );
  }

  function promptAssetMenuWarning(menu: PromptAssetMenuState): string {
    const draft = promptAssetDraftFromResult(menu.nodeId, menu.result);
    if (!draft) return "This image output has no local preview file to save.";
    if (!draft.prompt.trim()) return "This output has no stored prompt metadata.";
    return "";
  }

  function openPromptAssetDialog(nodeId: string, result: NodeRunResult) {
    const draft = promptAssetDraftFromResult(nodeId, result);
    if (!draft) {
      setLogs((current) => ["Could not create prompt asset: image output has no local file path.", ...current]);
      return;
    }
    if (!draft.prompt.trim()) {
      setLogs((current) => ["This output has no stored prompt metadata.", ...current]);
      return;
    }
    setPromptAssetDraft(draft);
    setPromptAssetError("");
    setPromptAssetSaving(false);
  }

  function promptAssetDraftFromResult(nodeId: string, result: NodeRunResult): PromptAssetDraft | null {
    const imageSrc = imagePreviewSrc(result.output);
    const imagePath = imageLocalPath(result.output);
    if (!imageSrc || !imagePath) return null;
    const sourceNode = sourceGeneratedImageNode(nodeId);
    const routeNode = sourceNode ?? (nodes.find((node) => node.id === nodeId)?.data.routeNode as RouteDoc["nodes"][number] | undefined);
    const prompt = promptTextForNode(routeNode?.id ?? nodeId) || stringParam(routeNode?.params, "prompt") || outputString(result.output, "prompt");
    const negativePrompt =
      promptTextForNode(routeNode?.id ?? nodeId, "negativePrompt") ||
      stringParam(routeNode?.params, "negativePrompt") ||
      stringParam(routeNode?.params, "negative_prompt") ||
      outputString(result.output, "negativePrompt") ||
      outputString(result.output, "negative_prompt");
    const title = routeNode?.title || routeNode?.id || imageLabel(result.output);
    const slug = slugFromText(title);
    const modelHints = [stringParam(routeNode?.params, "model"), outputString(result.output, "model"), providerHintForNode(routeNode)].filter(Boolean);
    return {
      title,
      slug,
      category: "image-generation",
      categoryMode: promptLibrary.categories.some((category) => category.id === "image-generation") ? "existing" : "custom",
      description: `Reusable prompt asset promoted from ${routeNode?.id ?? nodeId}.`,
      tagsText: "image, generated",
      prompt: prompt || "",
      negativePrompt,
      modelHintsText: [...new Set(modelHints)].join(", "),
      sourceNodeId: routeNode?.id ?? nodeId,
      sourceRouteId: routeBase.route.id,
      sourceRunId: runResult?.runId ?? "",
      sourceOutputId: imageOutputIdForResult(result),
      imageSrc,
      imagePath,
      generalize: false
    };
  }

  function sourceGeneratedImageNode(nodeId: string): RouteDoc["nodes"][number] | undefined {
    const currentNode = nodes.find((node) => node.id === nodeId)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (currentNode?.type !== "preview.image") return currentNode;
    const edge = edges.find((entry) => entry.target === nodeId && (!entry.targetHandle || entry.targetHandle === "image"));
    return nodes.find((node) => node.id === edge?.source)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
  }

  function promptTextForNode(nodeId: string, targetHandle = "prompt"): string {
    const edge = edges.find((entry) => entry.target === nodeId && entry.targetHandle === targetHandle);
    const sourceNode = nodes.find((node) => node.id === edge?.source)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (!sourceNode) return "";
    const sourceOutput = runResult?.nodeResults?.[sourceNode.id]?.output;
    const textOutput = outputText(sourceOutput);
    if (textOutput) return textOutput;
    if (sourceNode.type === "input.text") return stringParam(sourceNode.params, "value");
    if (sourceNode.type === "library.prompt") return promptTextFromLibraryNode(sourceNode);
    return stringParam(sourceNode.params, "prompt") || stringParam(sourceNode.params, "value");
  }

  function promptTextFromLibraryNode(node: RouteDoc["nodes"][number]): string {
    if (String(node.params?.mode ?? "linked") === "embedded") return stringParam(node.params, "embeddedText");
    const category = String(node.params?.category ?? "");
    const promptId = String(node.params?.promptId ?? "");
    return promptLibrary.categories.find((entry) => entry.id === category)?.prompts.find((prompt) => prompt.id === promptId)?.text ?? "";
  }

  async function savePromptAsset() {
    if (!promptAssetDraft || promptAssetSaving) return;
    setPromptAssetError("");
    if (!promptAssetDraft.prompt.trim()) {
      setPromptAssetError("Prompt body is required.");
      return;
    }
    setPromptAssetSaving(true);
    try {
      const imageDataBase64 = await imageUrlToPngBase64(promptAssetDraft.imageSrc);
      const response = await fetch(`${apiBase}/api/prompt-library/generated-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: promptAssetDraft.title,
          slug: promptAssetDraft.slug,
          category: promptAssetDraft.category,
          description: promptAssetDraft.description,
          tags: splitCsv(promptAssetDraft.tagsText),
          prompt: promptAssetDraft.prompt,
          negativePrompt: promptAssetDraft.negativePrompt,
          modelHints: splitCsv(promptAssetDraft.modelHintsText),
          source: {
            runId: promptAssetDraft.sourceRunId,
            routeId: promptAssetDraft.sourceRouteId,
            nodeId: promptAssetDraft.sourceNodeId,
            outputId: promptAssetDraft.sourceOutputId
          },
          imagePath: promptAssetDraft.imagePath,
          imageDataBase64,
          assetFormat: "png"
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Could not save prompt asset.");
      if (result.library?.categories) setPromptLibrary(result.library);
      else await refreshPromptLibraryData();
      setPromptLibraryStatusFilter("all");
      setPromptAssetDraft(null);
      setLogs((current) => [`Created prompt asset ${promptAssetDraft.category}/${promptAssetDraft.slug}.`, ...current]);
    } catch (error) {
      setPromptAssetError(error instanceof Error ? error.message : String(error));
    } finally {
      setPromptAssetSaving(false);
    }
  }

  async function refreshStableDiffusionModels(endpoint: string) {
    try {
      const response = await fetch(`${apiBase}/api/local-stable-diffusion/models?endpoint=${encodeURIComponent(endpoint)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Stable Diffusion model refresh failed.");
      const models = Array.isArray(result.models) ? result.models : [];
      setStableDiffusionModels(models);
      setLogs((current) => [`Stable Diffusion models refreshed: ${models.length}.`, ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStableDiffusionModels([]);
      setLogs((current) => [`Stable Diffusion model refresh failed: ${message}`, ...current]);
    }
  }

  async function saveReplicateToken() {
    const token = replicateToken.trim();
    if (!token) {
      setSettingsMessage("Token cannot be empty.");
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/settings/replicate-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replicateApiToken: token })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Failed to save token.");
      setReplicateConfigured(Boolean(result.replicate?.configured ?? result.replicateConfigured));
      setReplicateToken("");
      setSettingsMessage("Replicate token saved locally.");
      setLogs((current) => ["Replicate token saved locally.", ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Settings error: ${message}`, ...current]);
    }
  }

  async function saveGeminiToken() {
    const token = geminiToken.trim();
    if (!token) {
      setSettingsMessage("Gemini key cannot be empty.");
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/settings/gemini-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiApiKey: token })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Failed to save Gemini key.");
      setGeminiConfigured(Boolean(result.gemini?.configured ?? result.geminiConfigured));
      setGeminiToken("");
      setSettingsMessage("Gemini key saved locally.");
      setLogs((current) => ["Gemini key saved locally.", ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Settings error: ${message}`, ...current]);
    }
  }

  async function saveOpenAiToken() {
    const token = openAiToken.trim();
    if (!token) {
      setSettingsMessage("OpenAI key cannot be empty.");
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/settings/openai-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openAiApiKey: token })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Failed to save OpenAI key.");
      setOpenAiConfigured(Boolean(result.openai?.configured));
      setOpenAiMaskedKey(String(result.openai?.maskedApiKey ?? ""));
      setOpenAiToken("");
      setSettingsMessage("OpenAI key saved locally.");
      setLogs((current) => ["OpenAI key saved locally.", ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Settings error: ${message}`, ...current]);
    }
  }

  async function saveWorldLabsToken() {
    const token = worldLabsToken.trim();
    if (!token) {
      setSettingsMessage("WORLDS_API_KEY cannot be empty.");
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/settings/worldlabs-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worldsApiKey: token })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Failed to save World Labs key.");
      setWorldLabsConfigured(Boolean(result.worldlabs?.configured));
      setWorldLabsMaskedKey(String(result.worldlabs?.maskedApiKey ?? ""));
      setWorldLabsToken("");
      setSettingsMessage("World Labs key saved locally.");
      setLogs((current) => ["World Labs key saved locally.", ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Settings error: ${message}`, ...current]);
    }
  }

  async function saveSeedanceToken() {
    const token = seedanceToken.trim();
    if (!token && !seedanceBackend && !seedanceBaseUrl.trim()) {
      setSettingsMessage("Seedance provider backend is not selected");
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/settings/seedance-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seedanceApiKey: token || undefined,
          backend: seedanceBackend || undefined,
          seedanceApiBaseUrl: seedanceBaseUrl
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Failed to save Seedance settings.");
      const nextSeedance = result.seedance ?? { configured: false };
      setSeedanceSettings(nextSeedance);
      setSeedanceConfigured(Boolean(nextSeedance.configured));
      setSeedanceMaskedKey(String(nextSeedance.maskedApiKey ?? ""));
      setSeedanceBackend(String(nextSeedance.backend ?? seedanceBackend));
      setSeedanceBaseUrl(nextSeedance.baseUrlSource === "custom" ? String(nextSeedance.baseUrl ?? "") : "");
      setSeedanceToken("");
      setSettingsMessage(nextSeedance.configured ? "Seedance settings saved locally." : String(nextSeedance.statusText ?? "Seedance settings saved locally."));
      setLogs((current) => ["Seedance settings saved locally.", ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Settings error: ${message}`, ...current]);
    }
  }

  async function testSeedanceConfiguration() {
    try {
      const response = await fetch(`${apiBase}/api/providers/seedance/test`, { method: "POST" });
      const result = await response.json();
      if (result.seedance) {
        setSeedanceSettings(result.seedance);
        setSeedanceConfigured(Boolean(result.seedance.configured));
        setSeedanceMaskedKey(String(result.seedance.maskedApiKey ?? ""));
      }
      if (!response.ok) throw new Error(result.error ?? "Seedance configuration test failed.");
      setSettingsMessage("Seedance configuration has the required local settings.");
      setLogs((current) => ["Seedance configuration check passed.", ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Seedance configuration check failed: ${message}`, ...current]);
    }
  }

  async function savePolzaToken() {
    const token = polzaToken.trim();
    if (!token) {
      setSettingsMessage("Polza.ai key cannot be empty.");
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/settings/polza-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ polzaAiApiKey: token })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Failed to save Polza.ai key.");
      setPolzaConfigured(Boolean(result.polza?.configured));
      setPolzaMaskedKey(String(result.polza?.maskedApiKey ?? ""));
      setPolzaToken("");
      setSettingsMessage("Polza.ai key saved locally.");
      setLogs((current) => ["Polza.ai key saved locally.", ...current]);
      await loadPolzaModels();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Settings error: ${message}`, ...current]);
    }
  }

  async function saveOpenRouterSettings() {
    const token = openRouterToken.trim();
    if (!token && !openRouterDefaultModel.trim() && !openRouterBudgetWarningUsd.trim()) {
      setSettingsMessage("OpenRouter API key is not set");
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/settings/openrouter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openRouterApiKey: token || undefined,
          defaultModel: openRouterDefaultModel.trim() || "text.default",
          budgetWarningUsd: openRouterBudgetWarningUsd.trim() ? Number(openRouterBudgetWarningUsd) : null
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Failed to save OpenRouter settings.");
      setOpenRouterSettings(result.openrouter ?? { configured: Boolean(token) });
      setOpenRouterToken("");
      setSettingsMessage("OpenRouter settings saved locally. Do not commit API keys to git.");
      setLogs((current) => ["OpenRouter settings saved locally.", ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Settings error: ${message}`, ...current]);
    }
  }

  async function testOpenRouterConnection() {
    try {
      const response = await fetch(`${apiBase}/api/providers/openrouter/test`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "OpenRouter connection test failed.");
      setSettingsMessage("Connected");
      setLogs((current) => [`OpenRouter connected. Catalog reports ${result.modelCount ?? 0} models.`, ...current]);
      await loadSettings();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`OpenRouter test failed: ${message}`, ...current]);
    }
  }

  async function refreshOpenRouterCatalog() {
    try {
      const response = await fetch(`${apiBase}/api/providers/openrouter/refresh-model-catalog`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "OpenRouter catalog refresh failed.");
      setOpenRouterModels(Array.isArray(result.models) ? result.models : []);
      setOpenRouterSettings((current) => ({ ...current, catalog: { refreshedAt: result.refreshedAt, modelCount: result.modelCount, sourceCounts: result.sourceCounts } }));
      const sourceCounts = result.sourceCounts ? ` (/models: ${result.sourceCounts.models ?? 0}, /videos/models: ${result.sourceCounts.videoModels ?? 0})` : "";
      const klingModels = Array.isArray(result.models) ? result.models.filter((model: OpenRouterModel) => /kling/i.test(`${model.id} ${model.name ?? ""}`)) : [];
      setSettingsMessage(`OpenRouter catalog refreshed: ${result.modelCount ?? 0} models${sourceCounts}.`);
      setLogs((current) => [
        `OpenRouter catalog refreshed: ${result.modelCount ?? 0} models${sourceCounts}.`,
        `OpenRouter catalog Kling models: ${klingModels.length ? klingModels.map((model: OpenRouterModel) => `${model.id} [${model.kind ?? "unknown"}]`).join(", ") : "none"}`,
        ...current
      ]);
      await loadSettings();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`OpenRouter catalog refresh failed: ${message}`, ...current]);
    }
  }

  async function refreshPricingCatalog(provider: string) {
    try {
      const response = await fetch(`${apiBase}/api/model-pricing/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Pricing refresh failed.");
      const refreshed = Array.isArray(result.refreshed) ? result.refreshed.join(", ") : provider;
      const failed = Array.isArray(result.failed) && result.failed.length > 0 ? ` Failed: ${result.failed.map((entry: { provider?: string; error?: string }) => `${entry.provider}: ${entry.error}`).join("; ")}` : "";
      setSettingsMessage(`Pricing refresh complete: ${refreshed || "none"}.${failed}`);
      setLogs((current) => [`Pricing refresh complete: ${refreshed || "none"}.${failed}`, ...current]);
      setQuoteRefreshTick((tick) => tick + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Pricing refresh failed: ${message}`, ...current]);
    }
  }

  function openReplicateSettings() {
    setRightCollapsed(false);
    setSettingsMessage("Paste your Replicate token in Settings \u2192 Secrets \u2192 Replicate.");
    setTimeout(() => document.getElementById("replicate-api-token-input")?.focus(), 0);
  }

  function openGeminiSettings() {
    setRightCollapsed(false);
    setSettingsMessage("Paste your Gemini API key in Settings \u2192 Secrets \u2192 Gemini.");
    setTimeout(() => document.getElementById("gemini-api-key-input")?.focus(), 0);
  }

  function openOpenAiSettings() {
    setRightCollapsed(false);
    setSettingsMessage("Paste your OpenAI API key in Settings -> Advanced / Direct Secrets -> OpenAI.");
    setTimeout(() => document.getElementById("openai-api-key-input")?.focus(), 0);
  }

  function openSeedanceSettings() {
    setRightCollapsed(false);
    setSettingsMessage("Choose a Seedance backend, then add the matching API key in Settings -> Advanced / Direct Secrets -> Seedance.");
    setTimeout(() => document.getElementById("seedance-api-key-input")?.focus(), 0);
  }

  function openWorldLabsSettings() {
    setRightCollapsed(false);
    setSettingsMessage("Paste your World Labs key in Settings -> Advanced / Direct Secrets -> World Labs.");
    setTimeout(() => {
      const input = document.getElementById("worldlabs-api-key-input");
      input?.scrollIntoView({ block: "center" });
      input?.focus();
    }, 0);
  }

  function openPolzaSettings() {
    setRightCollapsed(false);
    setSettingsMessage("Paste your Polza.ai API key in Settings -> AI Providers -> Polza.ai.");
    setTimeout(() => document.getElementById("polza-api-key-input")?.focus(), 0);
  }

  function openOpenRouterSettings() {
    setRightCollapsed(false);
    setSettingsMessage("Paste your OpenRouter API key in Settings → AI Providers → OpenRouter.");
    setTimeout(() => document.getElementById("openrouter-api-key-input")?.focus(), 0);
  }

  async function browseAsset(nodeId: string, kind: AssetKind) {
    if (!supportsLocalFilesystem) {
      setLogs((entries) => [`Local ${kind} browsing is disabled in ${capabilities.mode} mode.`, ...entries]);
      return;
    }
    setPendingBrowse({ nodeId, kind });
    setTimeout(() => document.getElementById("asset-file-picker")?.click(), 0);
  }

  async function applyLocalFile(nodeId: string, file: File, kind: AssetKind) {
    if (!supportsLocalFilesystem) throw new Error(`Local ${kind} import is disabled in ${capabilities.mode} mode.`);
    const path = await importLocalAsset(file, kind);
    const current = nodes.find((node) => node.id === nodeId)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    updateNodeParams(nodeId, { ...(current?.params ?? {}), path });
    setLogs((entries) => [`Selected ${kind}: ${path}`, ...entries]);
  }

  async function handleFallbackFile(file: File | null) {
    if (!file || !pendingBrowse) return;
    try {
      await applyLocalFile(pendingBrowse.nodeId, file, pendingBrowse.kind);
      setPendingBrowse(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLogs((entries) => [`Local import error: ${message}`, ...entries]);
    }
  }

  async function importRouteOntoCanvas(file: File, position: { x: number; y: number }) {
    const route = loadRouteFromText(await file.text(), routeImportFilename(file)) as RouteDoc;
    const imported = routeToFlow(route);
    const usedNodeIds = new Set(nodes.map((node) => node.id));
    const usedEdgeIds = new Set(edges.map((edge) => edge.id));
    const nodeIdMap = new Map<string, string>();
    const minX = Math.min(...imported.nodes.map((node) => node.position.x), position.x);
    const minY = Math.min(...imported.nodes.map((node) => node.position.y), position.y);
    const offset = { x: position.x - minX, y: position.y - minY };

    const importedNodes = imported.nodes.map((node) => {
      const importedId = uniqueFlowId(node.id, usedNodeIds);
      nodeIdMap.set(node.id, importedId);
      const routeNode = { ...(node.data.routeNode as RouteDoc["nodes"][number]), id: importedId };
      return {
        ...node,
        id: importedId,
        position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
        data: { ...node.data, label: `${routeNode.title ?? routeNode.id}\n${routeNode.type}`, routeNode }
      };
    });

    const importedEdges = imported.edges.map((edge, index) => ({
      ...edge,
      id: uniqueFlowId(edge.id ?? `${edge.source}-${edge.target}-${index}`, usedEdgeIds),
      source: nodeIdMap.get(edge.source) ?? edge.source,
      target: nodeIdMap.get(edge.target) ?? edge.target
    }));

    pushUndoSnapshot(`Import ${file.name}`);
    setNodes((current) => {
      const nextNodes = [...current, ...importedNodes];
      nodesRef.current = nextNodes;
      return nextNodes;
    });
    setEdges((current) => {
      const nextEdges = [...current, ...importedEdges];
      edgesRef.current = nextEdges;
      return nextEdges;
    });
    setLogs((current) => [`Imported ${file.name} onto canvas.`, ...current]);
  }

  async function handleCanvasDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const draggedNodeType = event.dataTransfer.getData(NODE_DRAG_MIME);
    if (draggedNodeType) {
      addNode(draggedNodeType, flowPositionFromEvent(event));
      return;
    }

    const files = Array.from(event.dataTransfer.files ?? []);
    const file = files[0];
    if (!file) return;
    if (!supportsLocalFilesystem) {
      setLogs((entries) => [`Local file drops are disabled in ${capabilities.mode} mode.`, ...entries]);
      return;
    }
    if (files.length === 1 && canImportNodePackageFile(file)) {
      await importNodePackageFile(file, flowPositionFromEvent(event));
      return;
    }
    if (files.length === 1 && canImportDroppedRouteFile(file)) {
      try {
        await importRouteOntoCanvas(file, flowPositionFromEvent(event));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLogs((entries) => [`Drop route import error: ${message}`, ...entries]);
      }
      return;
    }

    const imageFiles = files.filter(isImageFile);
    if (imageFiles.length > 1) {
      try {
        await addAssetNodesFromFiles(imageFiles, "image", flowPositionFromEvent(event), "Dropped images");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLogs((entries) => [`Drop import error: ${message}`, ...entries]);
      }
      return;
    }

    const kind = isImageFile(file) ? "image" : file.type.startsWith("video/") ? "video" : "file";
    try {
      await addAssetNodeFromFile(file, kind, flowPositionFromEvent(event), `Dropped ${kind}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLogs((entries) => [`Drop import error: ${message}`, ...entries]);
    }
  }

  async function importNodePackageFile(file: File, position?: { x: number; y: number }) {
    if (!supportsLocalFilesystem) {
      setLogs((current) => [`Local block package files are disabled in ${capabilities.mode} mode.`, ...current]);
      return;
    }
    try {
      const payload = await readNodePackageFilePayload(file);
      const previewResponse = await fetch(`${apiBase}${NODE_PACKAGE_PREVIEW_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const preview = await previewResponse.json();
      if (!previewResponse.ok || !preview.ok) throw new Error(formatApiIssues(preview));
      const manifest = preview.manifest as NodeManifest;
      const warningText = Array.isArray(preview.warnings) && preview.warnings.length ? `\n\nWarnings:\n${preview.warnings.join("\n")}` : "";
      const confirmed = window.confirm(`Install block package?\n\n${manifest.title}\nAuthor: ${manifest.author.name}\nVersion: ${manifest.version}\nOrigin/source: ${manifest.origin} / ${manifest.source ?? "local-file"}\nExecutor: ${manifest.executor.type} ${manifest.executor.runtime ?? ""}\nPermissions: ${permissionsSummary(manifest)}${warningText}`);
      if (!confirmed) return;
      const installResponse = await fetch(`${apiBase}${NODE_PACKAGE_INSTALL_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, source: file.name })
      });
      const installed = await installResponse.json();
      if (!installResponse.ok || !installed.ok) throw new Error(installed.error ?? formatApiIssues(installed));
      await loadNodeCatalog();
      if (position) addNodeFromCatalogItem({ type: manifest.id, title: manifest.title, manifest, params: defaultParamsFromManifest(manifest) }, position);
      setLogs((current) => [`Installed node ${manifest.id}.`, ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(`Node package import failed: ${message}`);
      setRightCollapsed(false);
      setLogs((current) => [`Node package import failed: ${message}`, ...current]);
    }
  }

  async function installNodeFromUrl() {
    try {
      const previewResponse = await fetch(`${apiBase}/api/node-packages/preview-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: nodeUrl })
      });
      const preview = await previewResponse.json();
      if (!previewResponse.ok || !preview.ok || !preview.manifest) throw new Error(formatApiIssues(preview));
      const manifest = preview.manifest as NodeManifest;
      const confirmed = window.confirm(`Install block from URL?\n\n${manifest.title}\nAuthor: ${manifest.author.name}\nVersion: ${manifest.version}\nSource: ${nodeUrl}\nExecutor: ${manifest.executor.type} ${manifest.executor.runtime ?? ""}\nPermissions: ${permissionsSummary(manifest)}`);
      if (!confirmed) return;
      const response = await fetch(`${apiBase}/api/node-packages/install-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: nodeUrl })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? formatApiIssues(result));
      await loadNodeCatalog();
      setLogs((current) => [`Installed node from URL: ${result.manifest?.id ?? nodeUrl}`, ...current]);
    } catch (error) {
      setLogs((current) => [`URL install failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  async function installNodeFromPath() {
    if (!supportsLocalFilesystem) {
      setLogs((current) => [`Local path installs are disabled in ${capabilities.mode} mode.`, ...current]);
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/node-packages/install-path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: nodePackagePath })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? formatApiIssues(result));
      await loadNodeCatalog();
      setLogs((current) => [`Installed block package from path: ${result.manifest?.id ?? nodePackagePath}`, ...current]);
    } catch (error) {
      setLogs((current) => [`Path install failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  async function previewLibraryFromUrl() {
    try {
      const response = await fetch(`${apiBase}/api/node-packages/preview-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: libraryUrl })
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !result.library) throw new Error(formatApiIssues(result));
      setLibraryPreview(result.library);
      setSelectedLibraryNodeIds(Object.fromEntries((result.library.nodes as NodeLibraryPreview["nodes"]).map((node) => [node.id, false])));
    } catch (error) {
      setLogs((current) => [`Library preview failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  function selectLibraryPreviewNodes(selected: boolean) {
    if (!libraryPreview) return;
    setSelectedLibraryNodeIds(Object.fromEntries(libraryPreview.nodes.map((node) => [node.id, selected])));
  }

  async function installSelectedLibraryNodes() {
    try {
      if (!libraryPreview) return;
      const nodeIds = Object.entries(selectedLibraryNodeIds).filter(([, selected]) => selected).map(([id]) => id);
      if (nodeIds.length === 0) {
        setLogs((current) => ["Choose at least one library node before installing.", ...current]);
        return;
      }
      const response = await fetch(`${apiBase}/api/node-packages/install-library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryUrl, nodeIds })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? formatApiIssues(result));
      await loadNodeCatalog();
      markInstalledLibraryNodes(nodeIds, libraryInstallStatus);
      setLogs((current) => [`Installed ${result.installed?.length ?? 0} block(s) from library.`, ...current]);
    } catch (error) {
      setLogs((current) => [`Library install failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  function markInstalledLibraryNodes(nodeIds: string[], status: LibraryNodeStatus) {
    setLibraryNodeMetadata((current) => {
      const next = { ...current };
      const maxOrder = Object.values(next).reduce((max, metadata) => Math.max(max, metadata.order ?? -1), -1);
      nodeIds.forEach((id, index) => {
        next[id] = { ...next[id], status, order: next[id]?.order ?? maxOrder + index + 1 };
      });
      return next;
    });
  }

  function setLibraryNodeStatus(id: string, status: LibraryNodeStatus) {
    setLibraryNodeMetadata((current) => ({ ...current, [id]: { ...current[id], status } }));
  }

  function moveInstalledNode(id: string, direction: -1 | 1) {
    const ordered = installedNodes
      .map((node, index) => ({ id: node.id, order: libraryNodeOrder(node, libraryNodeMetadata, index) }))
      .sort((left, right) => left.order - right.order);
    const index = ordered.findIndex((item) => item.id === id);
    const swapIndex = index + direction;
    if (index < 0 || swapIndex < 0 || swapIndex >= ordered.length) return;
    const normalized = ordered.map((item, itemIndex) => ({ ...item, order: itemIndex }));
    const currentItem = normalized[index];
    const swapItem = normalized[swapIndex];
    setLibraryNodeMetadata((current) => ({
      ...current,
      [currentItem.id]: { ...current[currentItem.id], order: swapItem.order },
      [swapItem.id]: { ...current[swapItem.id], order: currentItem.order }
    }));
    setLibrarySortMode("manual");
  }

  async function setInstalledNodeState(id: string, enabled: boolean) {
    const response = await fetch(`${apiBase}/api/node-packages/${encodeURIComponent(id)}/enabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) setLogs((current) => [`Node ${enabled ? "enable" : "disable"} failed: ${result.error ?? "unknown error"}`, ...current]);
    await loadNodeCatalog();
  }

  async function uninstallNode(id: string) {
    const usedInCurrentRoute = nodePackageIsUsedInRoute(
      id,
      nodes.map((node) => node.data.routeNode as RouteDoc["nodes"][number])
    );
    if (!window.confirm(uninstallNodeConfirmationMessage(id, usedInCurrentRoute))) return;
    try {
      const response = await fetch(`${apiBase}/api/node-packages/${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? "unknown error");
      await loadNodeCatalog();
      setLogs((current) => [`Uninstalled node "${id}".`, ...current]);
    } catch (error) {
      setLogs((current) => [`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  async function viewInstalledNodeReadme(id: string) {
    try {
      const response = await fetch(`${apiBase}/api/node-packages/${encodeURIComponent(id)}/readme`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? "README not found.");
      setOutputs({ node: id, readmePath: result.path, readme: result.text });
      setBottomCollapsed(false);
    } catch (error) {
      setLogs((current) => [`README unavailable: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  function flowPositionFromEvent(event: React.DragEvent<HTMLElement>) {
    return reactFlowInstance?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 160 + nodes.length * 30, y: 120 + nodes.length * 24 };
  }

  function flowPositionFromClientPoint(clientX: number, clientY: number) {
    return reactFlowInstance?.screenToFlowPosition({ x: clientX, y: clientY }) ?? { x: 160 + nodes.length * 30, y: 120 + nodes.length * 24 };
  }

  function flowPositionFromViewportCenter() {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) return flowPositionFromClientPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { x: 160 + nodes.length * 30, y: 120 + nodes.length * 24 };
  }

  function positionRightOfAllNodes(preferredY?: number) {
    if (nodes.length === 0) return { x: 160, y: preferredY ?? 140 };
    const maxX = Math.max(...nodes.map((node) => node.position.x));
    const averageY = nodes.reduce((sum, node) => sum + node.position.y, 0) / nodes.length;
    return { x: maxX + 320, y: preferredY ?? averageY };
  }

  function updateNodeParams(nodeId: string, params: Record<string, unknown>, options: { persistProject?: boolean; persistLog?: string } = {}) {
    const currentNodes = nodesRef.current;
    const currentParams = currentNodes.find((node) => node.id === nodeId)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    const paramsChanged = JSON.stringify(currentParams?.params ?? {}) !== JSON.stringify(params);
    if (paramsChanged) pushUndoSnapshot(`Edit ${nodeId}`);
    const changedNodeType = currentParams?.type ?? "";
    const affectedNodeIds = paramsChanged ? [nodeId, ...downstreamNodeIds(nodeId)] : [];
    const staleResultNodeIds = affectedNodeIds.filter((affectedNodeId) => {
      const affectedType = currentNodes.find((node) => node.id === affectedNodeId)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
      return !shouldKeepLiveResultOnParamChange(changedNodeType, affectedType?.type ?? "");
    });
    const nextNodes = currentNodes.map((node) => {
      if (node.id !== nodeId && !affectedNodeIds.includes(node.id)) return node;
      const currentRouteNode = node.data.routeNode as RouteDoc["nodes"][number];
      const routeNode = { ...currentRouteNode, params: node.id === nodeId && !paramsChanged ? params : unpinParams(node.id === nodeId ? params : currentRouteNode.params) };
      return { ...node, data: { ...node.data, routeNode } };
    });
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    if (paramsChanged) {
      markNodeResultsStale(staleResultNodeIds);
      clearNodeRunResults(affectedNodeIds);
    }
    if (selectedId === nodeId) setParamsText(JSON.stringify(params, null, 2));
    if (options.persistProject) {
      saveRouteDocument(buildRouteDocumentFrom(nextNodes, edges), { saveStartup: true, logMessage: options.persistLog });
    }
  }

  function updateNodeUi(nodeId: string, patch: Record<string, unknown>) {
    const currentNodes = nodesRef.current;
    const currentNode = currentNodes.find((node) => node.id === nodeId);
    const currentRouteNode = currentNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (!currentRouteNode) return;

    const nextUi = { ...(currentRouteNode.ui ?? {}) } as Record<string, unknown>;

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete nextUi[key];
      } else {
        nextUi[key] = value;
      }
    }

    const uiChanged = JSON.stringify(currentRouteNode.ui ?? {}) !== JSON.stringify(nextUi);
    if (!uiChanged) return;

    pushUndoSnapshot(`Update ${nodeId} view`);

    const nextNodes = currentNodes.map((node) => {
      if (node.id !== nodeId) return node;

      const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
      const dataPatch =
        Object.prototype.hasOwnProperty.call(patch, "paramsCollapsed")
          ? { paramsCollapsed: nextUi.paramsCollapsed === true }
          : {};

      return {
        ...node,
        data: {
          ...node.data,
          ...dataPatch,
          routeNode: { ...routeNode, ui: nextUi }
        }
      };
    });

    nodesRef.current = nextNodes;
    setNodes(nextNodes);
  }

  function updateNodeParamsCollapsed(nodeId: string, collapsed: boolean) {
    updateNodeUi(nodeId, { paramsCollapsed: collapsed ? true : undefined });
  }

  function updateDialogueWorkbenchState(nodeId: string, state: DialogueWorkbenchState, patch: Record<string, unknown> = {}) {
    const currentNode = nodes.find((node) => node.id === nodeId)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    const persistProject = patch.persistProject === true;
    const { persistProject: _persistProject, ...routePatch } = patch;
    updateNodeParams(nodeId, {
      ...(currentNode?.params ?? {}),
      ...routePatch,
      defaultModelProfileId: state.defaultModelProfileId ?? routePatch.defaultModelProfileId ?? currentNode?.params?.defaultModelProfileId ?? "text.default",
      agentPresetId: state.agentPresetId ?? routePatch.agentPresetId ?? currentNode?.params?.agentPresetId ?? "",
      state
    }, {
      persistProject,
      persistLog: persistProject ? "Saved Dialogue Workbench default model to startup route." : undefined
    });
  }

  function openDialogueWorkbench(nodeId: string) {
    setActiveDialogueWorkbenchId(nodeId);
  }

  function clearNodeRunResult(nodeId: string) {
    clearNodeRunResults([nodeId]);
  }

  function clearNodeRunResults(nodeIds: string[]) {
    const ids = new Set(nodeIds);
    setRunResult((current) => {
      if (!current?.nodeResults || !nodeIds.some((nodeId) => current.nodeResults?.[nodeId])) return current;
      const nodeResults = { ...current.nodeResults };
      for (const nodeId of ids) delete nodeResults[nodeId];
      for (const resultId of Object.keys(nodeResults)) {
        if (nodeIds.some((nodeId) => resultId.startsWith(`${nodeId}/`))) delete nodeResults[resultId];
      }
      return { ...current, nodeResults };
    });
  }

  function markNodeResultsStale(nodeIds: string[]) {
    if (nodeIds.length === 0) return;
    setStaleResultNodeIds((current) => new Set([...current, ...nodeIds]));
  }

  function markNodeResultsFresh(nodeIds: string[]) {
    if (nodeIds.length === 0) return;
    setStaleResultNodeIds((current) => {
      if (nodeIds.every((nodeId) => !current.has(nodeId))) return current;
      const next = new Set(current);
      for (const nodeId of nodeIds) next.delete(nodeId);
      return next;
    });
  }

  function publishNodeOutput(nodeId: string, output: Record<string, unknown>) {
    const now = new Date().toISOString();
    markNodeResultsFresh([nodeId]);
    markNodeResultsStale(downstreamNodeIds(nodeId));
    setRunResult((current) => {
      const nodeResults = { ...(current?.nodeResults ?? {}) };
      nodeResults[nodeId] = {
        ...(nodeResults[nodeId] ?? {}),
        status: "succeeded",
        output,
        startedAt: nodeResults[nodeId]?.startedAt ?? now,
        completedAt: now
      };
      return {
        ...(current ?? {}),
        status: current?.status ?? "succeeded",
        runId: current?.runId ?? "local-preview",
        startedAt: current?.startedAt ?? now,
        completedAt: now,
        nodeResults
      };
    });
  }

  function downstreamNodeIds(nodeId: string): string[] {
    const visited = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const source = queue.shift()!;
      for (const edge of edgesRef.current) {
        if (edge.source !== source || visited.has(edge.target)) continue;
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }
    visited.delete(nodeId);
    return [...visited];
  }

  function unpinParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!params || (!Object.prototype.hasOwnProperty.call(params, "pinnedOutput") && !Object.prototype.hasOwnProperty.call(params, "pinnedOutputAt"))) return params ?? {};
    const { pinnedOutput: _pinnedOutput, pinnedOutputAt: _pinnedOutputAt, ...rest } = params;
    return rest;
  }

  function shouldKeepLiveResultOnParamChange(changedType: string, affectedType: string): boolean {
    if (changedType === "transform.chooseCameraPoint") return affectedType === "transform.chooseCameraPoint" || affectedType === "preview.image";
    return changedType === "transform.panorama360ToFisheye" && (affectedType === "transform.panorama360ToFisheye" || affectedType === "preview.image");
  }

  function cloneFlowNodesForUndo(flowNodes: Node[]): Node[] {
    return flowNodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        routeNode: structuredClone(node.data.routeNode)
      }
    }));
  }

  function cloneFlowEdgesForUndo(flowEdges: Edge[]): Edge[] {
    return flowEdges.map((edge) => ({ ...edge, data: edge.data ? structuredClone(edge.data) : edge.data }));
  }

  function pushUndoSnapshot(label: string) {
    undoStackRef.current = [
      ...undoStackRef.current.slice(-49),
      { nodes: cloneFlowNodesForUndo(nodesRef.current), edges: cloneFlowEdgesForUndo(edgesRef.current), selectedId, label }
    ];
  }

  function undoLastAction() {
    const snapshot = undoStackRef.current.at(-1);
    if (!snapshot) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    nodesRef.current = cloneFlowNodesForUndo(snapshot.nodes);
    edgesRef.current = cloneFlowEdgesForUndo(snapshot.edges);
    setNodes(nodesRef.current);
    setEdges(edgesRef.current);
    setSelectedId(snapshot.selectedId);
    setStaleResultNodeIds(new Set());
    setLogs((current) => [`Undid: ${snapshot.label}.`, ...current]);
  }

  function addNode(type: string, position?: { x: number; y: number }) {
    const item = nodeCatalog.find((candidate) => candidate.type === type) ?? library.find((candidate) => candidate.type === type);
    if (!item) {
      setLogs((current) => [`Cannot add missing node type: ${type}`, ...current]);
      return;
    }
    addNodeFromCatalogItem(item, position);
  }

  function addNodeFromCatalogItem(item: NodeCatalogItem | (typeof library)[number], position?: { x: number; y: number }) {
    const type = item.type;
    const itemTitle = catalogItemTitle(item);
    const manifest = "manifest" in item ? item.manifest : undefined;
    let createdId = "";
    pushUndoSnapshot(`Add ${itemTitle}`);
    setNodes((current) => {
      const usedIds = new Set(current.map((node) => node.id));
      const id = uniqueFlowId(`${type.replace(/\W+/g, "_")}_${current.length + 1}`, usedIds);
      createdId = id;
      const params = structuredClone(item.params ?? {});
      if (type === "dialogue.workbench") {
        params.defaultModelProfileId = params.defaultModelProfileId ?? "text.default";
        params.agentPresetId = params.agentPresetId ?? "plain-collaborator";
        params.state = createDialogueWorkbenchState({ nodeId: id, defaultModelProfileId: String(params.defaultModelProfileId) });
      }
      const routeNode = {
        id,
        type,
        title: itemTitle,
        params,
        nodePackage: manifest && manifest.origin !== "bundled" ? { id: manifest.id, version: manifest.version, origin: manifest.origin, source: manifest.source } : undefined,
        ui: {}
      };
      const nextNodes = [
        ...current,
        { id, type: isCompoundInterfaceType(type) ? "interface" : "route", position: position ?? { x: 120 + current.length * 36, y: 140 + current.length * 28 }, data: { label: `${itemTitle}\n${type}`, routeNode } }
      ];
      nodesRef.current = nextNodes;
      return nextNodes;
    });
    return createdId;
  }

  async function addAssetNodeFromFile(file: File, kind: AssetKind, position: { x: number; y: number } | undefined, logPrefix: string) {
    const type = `input.${kind}`;
    const item = nodeCatalog.find((candidate) => candidate.type === type) ?? library.find((candidate) => candidate.type === type);
    if (!item) throw new Error(`Cannot add missing node type: ${type}`);
    const path = await importLocalAsset(file, kind);
    const itemTitle = catalogItemTitle(item);
    let createdId = "";
    pushUndoSnapshot(`Add ${itemTitle}`);
    setNodes((current) => {
      const usedIds = new Set(current.map((node) => node.id));
      const id = uniqueFlowId(`${type.replace(/\W+/g, "_")}_${current.length + 1}`, usedIds);
      createdId = id;
      const routeNode = { id, type, title: itemTitle, params: { path }, ui: {} };
      const nextNodes = [
        ...current,
        {
          id,
          type: "route",
          position: position ?? { x: 120 + current.length * 36, y: 140 + current.length * 28 },
          data: { label: `${itemTitle}\n${type}`, routeNode }
        }
      ];
      nodesRef.current = nextNodes;
      return nextNodes;
    });
    if (createdId) selectNode(null);
    setLogs((entries) => [`${logPrefix}: ${path}`, ...entries]);
    return createdId;
  }

  async function addAssetNodesFromFiles(files: File[], kind: AssetKind, position: { x: number; y: number } | undefined, logPrefix: string) {
    const type = `input.${kind}`;
    const item = nodeCatalog.find((candidate) => candidate.type === type) ?? library.find((candidate) => candidate.type === type);
    if (!item) throw new Error(`Cannot add missing node type: ${type}`);
    const imported = await Promise.all(files.map(async (file) => ({ file, path: await importLocalAsset(file, kind) })));
    const itemTitle = catalogItemTitle(item);
    const origin = position ?? { x: 120 + nodesRef.current.length * 36, y: 140 + nodesRef.current.length * 28 };
    pushUndoSnapshot(`Add ${files.length} ${kind} nodes`);
    setNodes((current) => {
      const usedIds = new Set(current.map((node) => node.id));
      const createdNodes = imported.map(({ path }, index) => {
        const id = uniqueFlowId(`${type.replace(/\W+/g, "_")}_${current.length + index + 1}`, usedIds);
        const routeNode = { id, type, title: itemTitle, params: { path }, ui: {} };
        return {
          id,
          type: "route",
          position: layoutBatchPosition(origin, index),
          data: { label: `${itemTitle}\n${type}`, routeNode }
        } satisfies Node;
      });
      const nextNodes = [...current, ...createdNodes];
      nodesRef.current = nextNodes;
      return nextNodes;
    });
    selectNode(null);
    setLogs((entries) => [`${logPrefix}: imported ${imported.length} ${kind} file(s).`, ...entries]);
    return imported.map((entry) => entry.path);
  }

  function toggleLibrarySection(id: string) {
    setCollapsedLibrarySections((current) => ({ ...current, [id]: !(current[id] ?? true) }));
  }

  function createLibraryGroup() {
    const title = window.prompt("New group name")?.trim();
    if (!title) return;
    const idBase = title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "group";
    setNodeLibraryLayout((current) => {
      const usedIds = new Set(current.groups.map((group) => group.id));
      let id = idBase;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${idBase}-${suffix}`;
        suffix += 1;
      }
      setCollapsedLibrarySections((sections) => ({ ...sections, [id]: true }));
      return { ...current, groups: [...current.groups, { id, title, types: [] }] };
    });
  }

  function deleteLibraryGroup(id: string, title: string, types: string[]) {
    setLibrarySectionMenu(null);
    const group = nodeLibraryLayout.groups.find((entry) => entry.id === id);
    if (!group) {
      if (!window.confirm(`Delete group "${title}"? Blocks in it will be removed from this list.`)) return;
      setNodeLibraryLayout((current) => ({ ...current, hiddenTypes: [...new Set([...current.hiddenTypes, ...types])] }));
      return;
    }
    if (!window.confirm(`Delete group "${group.title}"? Blocks in it will move to the first group.`)) return;
    setNodeLibraryLayout((current) => {
      const currentGroup = current.groups.find((entry) => entry.id === id);
      const targetGroup = current.groups.find((entry) => entry.id !== id);
      if (!currentGroup || !targetGroup) return current;
      return {
        ...current,
        groups: current.groups
          .filter((entry) => entry.id !== id)
          .map((entry) => (entry.id === targetGroup.id ? { ...entry, types: [...entry.types, ...currentGroup.types.filter((type) => !entry.types.includes(type))] } : entry))
      };
    });
  }

  function moveLibraryItemToGroup(type: string, targetGroupId: string, targetTitle: string) {
    setNodeLibraryLayout((current) => {
      const hasTargetGroup = current.groups.some((group) => group.id === targetGroupId);
      const baseGroups = hasTargetGroup ? current.groups : [...current.groups, { id: targetGroupId, title: targetTitle, types: [] }];
      const groups = baseGroups.map((group) => {
        const withoutType = group.types.filter((entry) => entry !== type);
        return group.id === targetGroupId ? { ...group, types: [...withoutType, type] } : { ...group, types: withoutType };
      });
      return { ...current, groups, hiddenTypes: current.hiddenTypes.filter((entry) => entry !== type) };
    });
    setCollapsedLibrarySections((current) => ({ ...current, [targetGroupId]: false }));
  }

  function hideLibraryItem(type: string) {
    setNodeLibraryLayout((current) => ({
      ...current,
      hiddenTypes: current.hiddenTypes.includes(type) ? current.hiddenTypes : [...current.hiddenTypes, type]
    }));
    setLibraryItemMenu(null);
  }

  function hideLibrarySection(types: string[]) {
    setNodeLibraryLayout((current) => ({
      ...current,
      hiddenTypes: [...new Set([...current.hiddenTypes, ...types])]
    }));
    setLibrarySectionMenu(null);
  }

  function showLibraryItem(type: string) {
    const item = nodeCatalog.find((candidate) => candidate.type === type);
    moveLibraryItemToGroup(type, item?.manifest?.category ?? fallbackSectionTitle(type), item?.manifest?.category ?? fallbackSectionTitle(type));
    setLibraryItemMenu(null);
  }

  function showLibrarySection(types: string[]) {
    setNodeLibraryLayout((current) => ({
      ...current,
      hiddenTypes: current.hiddenTypes.filter((type) => !types.includes(type))
    }));
    setLibrarySectionMenu(null);
  }

  function openLibraryItemMenu(event: React.MouseEvent, item: NodeCatalogItem, section: NodeCatalogSection) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setPromptAssetMenu(null);
    setPromptLibraryMenu(null);
    setConnectionNodeMenu(null);
    setLibrarySectionMenu(null);
    setLibraryItemMenu({ clientX: event.clientX, clientY: event.clientY, type: item.type, sectionId: section.id, sectionTitle: section.title, sectionTypes: [...section.types] });
  }

  function openLibrarySectionMenu(event: React.MouseEvent, section: NodeCatalogSection) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setPromptAssetMenu(null);
    setPromptLibraryMenu(null);
    setConnectionNodeMenu(null);
    setLibraryItemMenu(null);
    setLibrarySectionMenu({ clientX: event.clientX, clientY: event.clientY, sectionId: section.id, sectionTitle: section.title, sectionTypes: [...section.types] });
  }

  async function deleteLibraryItem(type: string) {
    setLibraryItemMenu(null);
    const item = nodeCatalog.find((candidate) => candidate.type === type);
    if (!item?.manifest || !canUninstallNodePackage(item.manifest)) {
      window.alert("Bundled blocks cannot be deleted. Use Hide to remove it from the left panel.");
      return;
    }
    await uninstallNode(type);
  }

  function ensureLibraryGroupForOrder(layout: NodeLibraryLayout, sectionId: string, sectionTitle: string, sectionTypes: string[]): NodeLibraryLayout {
    if (layout.groups.some((group) => group.id === sectionId)) return layout;
    return { ...layout, groups: [...layout.groups, { id: sectionId, title: sectionTitle, types: [...sectionTypes] }] };
  }

  function moveLibrarySection(sectionId: string, sectionTitle: string, sectionTypes: string[], direction: -1 | 1) {
    setNodeLibraryLayout((current) => {
      const layout = ensureLibraryGroupForOrder(current, sectionId, sectionTitle, sectionTypes);
      const index = layout.groups.findIndex((group) => group.id === sectionId);
      const swapIndex = index + direction;
      if (index < 0 || swapIndex < 0 || swapIndex >= layout.groups.length) return layout;
      const groups = [...layout.groups];
      const currentGroup = groups[index];
      groups[index] = groups[swapIndex];
      groups[swapIndex] = currentGroup;
      return { ...layout, groups };
    });
    setLibrarySectionMenu(null);
  }

  function moveLibraryItem(type: string, sectionId: string, sectionTitle: string, sectionTypes: string[], direction: -1 | 1) {
    setNodeLibraryLayout((current) => {
      const layout = ensureLibraryGroupForOrder(current, sectionId, sectionTitle, sectionTypes);
      const targetIndex = layout.groups.findIndex((group) => group.id === sectionId);
      if (targetIndex < 0) return layout;
      const groups = layout.groups.map((group) => ({ ...group, types: group.types.filter((entry) => entry !== type) }));
      const targetGroup = groups[targetIndex];
      const visibleOrder = sectionTypes.filter((entry, index, source) => source.indexOf(entry) === index);
      const targetTypes = targetGroup.types.length > 0 ? targetGroup.types : visibleOrder.filter((entry) => entry !== type);
      const order = visibleOrder.includes(type)
        ? visibleOrder
        : [...targetTypes.filter((entry) => entry !== type), type];
      const index = order.indexOf(type);
      const swapIndex = index + direction;
      if (index < 0 || swapIndex < 0 || swapIndex >= order.length) return layout;
      const nextOrder = [...order];
      const currentType = nextOrder[index];
      nextOrder[index] = nextOrder[swapIndex];
      nextOrder[swapIndex] = currentType;
      const extraTypes = targetTypes.filter((entry) => !nextOrder.includes(entry));
      groups[targetIndex] = { ...targetGroup, types: [...nextOrder, ...extraTypes] };
      return { ...layout, groups };
    });
    setLibraryItemMenu(null);
  }

  function handleLibrarySectionDrop(event: React.DragEvent<HTMLElement>, sectionId: string, sectionTitle: string) {
    const type = event.dataTransfer.getData(NODE_DRAG_MIME);
    if (!type) return;
    event.preventDefault();
    event.stopPropagation();
    moveLibraryItemToGroup(type, sectionId, sectionTitle);
  }

  function renderLibraryItem(item: NodeCatalogItem, section: NodeCatalogSection) {
    const isHidden = hiddenNodeTypes.has(item.type);
    return (
      <div
        key={item.type}
        className={`libraryItem ${isHidden ? "hiddenLibraryItem" : ""}`}
        draggable
        onContextMenu={(event) => openLibraryItemMenu(event, item, section)}
        onDragStart={(event) => {
          event.dataTransfer.setData(NODE_DRAG_MIME, item.type);
          event.dataTransfer.effectAllowed = "copyMove";
        }}
      >
        <button className="libraryItemMain" onClick={() => addNode(item.type)}>
          <span className={`libraryNodeIcon ${nodeIconClass(item.type)}`}>{nodeIcon(item.type)}</span>
          <strong>{catalogItemTitle(item)}</strong>
          <span>{item.type}</span>
          {item.manifest ? <small>{item.manifest.author.name} · {item.manifest.version} · {item.manifest.origin}</small> : null}
          {isHidden ? <em>Hidden</em> : null}
        </button>
      </div>
      );
    }


  function handleNodesChange(changes: NodeChange[]) {
    const interfacePositionChanges = changes.filter((change) => "id" in change && "position" in change && change.type === "position" && subrouteInterfaceKind(change.id) && change.position);
    if (interfacePositionChanges.length > 0) {
      setRouteStack((current) => {
        if (current.length === 0) return current;
        const next = [...current];
        const last = next[next.length - 1];
        let positions = last.interfacePositions ?? {};
        for (const change of interfacePositionChanges) {
          if (!("id" in change) || !("position" in change)) continue;
          const kind = subrouteInterfaceKind(change.id);
          if (!kind || !change.position) continue;
          positions = { ...positions, [kind]: change.position };
        }
        next[next.length - 1] = { ...last, interfacePositions: positions };
        return next;
      });
    }
    const routeNodeChanges = changes.filter((change) => !("id" in change) || !isSubrouteInterfaceId(change.id));
    if (routeNodeChanges.length > 0) {
      if (routeNodeChanges.some((change) => change.type !== "select")) pushUndoSnapshot("Canvas node change");
      onNodesChange(routeNodeChanges);
    }
    const selected = changes.find((change) => change.type === "select" && change.selected);
    if (selected && "id" in selected && !isSubrouteInterfaceId(selected.id)) setSelectedId(selected.id);
  }

  function handleEdgesChange(changes: EdgeChange[]) {
    const routeEdgeChanges = changes.filter((change) => !("id" in change) || !isSubrouteInterfaceId(change.id));
    if (routeEdgeChanges.length > 0) {
      if (routeEdgeChanges.some((change) => change.type !== "select")) pushUndoSnapshot("Canvas edge change");
      onEdgesChange(routeEdgeChanges);
    }
  }

  function deleteSelection() {
    const selectedNodeIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
    const selectedEdgeIds = new Set(edges.filter((edge) => edge.selected).map((edge) => edge.id));

    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0 && selectedId) {
      selectedNodeIds.add(selectedId);
    }

    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return;

    pushUndoSnapshot("Delete selection");
    setNodes((current) => {
      const nextNodes = current.filter((node) => !selectedNodeIds.has(node.id));
      nodesRef.current = nextNodes;
      return nextNodes;
    });
    setEdges((current) => {
      const nextEdges = current.filter((edge) => !selectedEdgeIds.has(edge.id) && !selectedNodeIds.has(edge.source) && !selectedNodeIds.has(edge.target));
      edgesRef.current = nextEdges;
      return nextEdges;
    });
    setSelectedId(null);
    clearNodeRunResults([...selectedNodeIds]);
    setLogs((current) => [`Deleted ${selectedNodeIds.size} block(s), ${selectedEdgeIds.size} edge(s).`, ...current]);
  }

  function collapseSelectedNodes() {
    const selectedNodeIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
    if (selectedNodeIds.size < 2) {
      setLogs((current) => ["Select at least two blocks to collapse.", ...current]);
      return;
    }

    const selectedNodes = nodes.filter((node) => selectedNodeIds.has(node.id));
    const selectedEdges = edges.filter((edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target));
    const incomingEdges = edges.filter((edge) => !selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target));
    const outgoingEdges = edges.filter((edge) => selectedNodeIds.has(edge.source) && !selectedNodeIds.has(edge.target));
    const title = window.prompt("Compound node title", "Compound Node")?.trim() || "Compound Node";
    const defaultInputs = mergeCompoundInputMappings(
      incomingEdges.map((edge) => {
        const source = nodes.find((node) => node.id === edge.source)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
        const target = selectedNodes.find((node) => node.id === edge.target)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
        const sourceKind = getNodePorts(source?.type ?? "", undefined, source).outputs.find((port) => port.id === edge.sourceHandle)?.kind;
        const targetKind = getNodePorts(target?.type ?? "", undefined, target).inputs.find((port) => port.id === edge.targetHandle)?.kind;
        const id = edge.sourceHandle ?? edge.source;
        return { id, label: id, kind: sourceKind ?? targetKind ?? "json", nodeId: edge.target, port: edge.targetHandle ?? "input" };
      }),
      (mapping, index) => `${incomingEdges[index]?.source ?? mapping.nodeId}:${incomingEdges[index]?.sourceHandle ?? "output"}`
    );
    const defaultOutputs = uniqueCompoundMappingsByKey(
      outgoingEdges.map((edge) => {
        const source = selectedNodes.find((node) => node.id === edge.source)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
        const kind = getNodePorts(source?.type ?? "", undefined, source).outputs.find((port) => port.id === edge.sourceHandle)?.kind ?? "json";
        return { id: edge.sourceHandle ?? edge.source, label: edge.sourceHandle ?? edge.source, kind, nodeId: edge.source, port: edge.sourceHandle ?? "output" };
      }),
      (mapping) => `${mapping.nodeId}:${mapping.port ?? "output"}`
    );
    const chosenInputs = chooseCompoundPorts("Exposed input ports (comma-separated)", defaultInputs);
    const chosenOutputs = chooseCompoundPorts("Exposed output ports (comma-separated)", defaultOutputs);
    if (!chosenInputs || !chosenOutputs) return;

    const compoundId = uniqueFlowId(`compound_${nodes.length + 1}`, new Set(nodes.map((node) => node.id)));
    const position = {
      x: selectedNodes.reduce((sum, node) => sum + node.position.x, 0) / selectedNodes.length,
      y: selectedNodes.reduce((sum, node) => sum + node.position.y, 0) / selectedNodes.length
    };
    const subroute = flowToRoute(selectedNodes, selectedEdges, {
      ...routeBase,
      route: { ...routeBase.route, id: `${routeBase.route.id}.${compoundId}`, title },
      economics: routeBase.economics,
      provenance: { tool: "snarkroute-studio", compoundOf: [...selectedNodeIds] }
    });
    const routeNode: RouteDoc["nodes"][number] = {
      id: compoundId,
      type: "compound.subroute",
      title,
      params: {},
      compound: { title, inputs: chosenInputs, outputs: chosenOutputs },
      subroute,
      ui: {}
    };
    const inputPortByTarget = new Map(chosenInputs.flatMap((port) => compoundMappingTargets(port).map((target) => [`${target.nodeId}:${target.port ?? "input"}`, port.id])));
    const outputPortBySource = new Map(chosenOutputs.map((port) => [`${port.nodeId}:${port.port ?? "output"}`, port.id]));
    const rewiredIncoming = incomingEdges
      .map((edge) => ({ ...edge, target: compoundId, targetHandle: inputPortByTarget.get(`${edge.target}:${edge.targetHandle ?? "input"}`) }))
      .filter((edge, index, allEdges) => Boolean(edge.targetHandle) && allEdges.findIndex((candidate) =>
        candidate.source === edge.source &&
        candidate.sourceHandle === edge.sourceHandle &&
        candidate.target === edge.target &&
        candidate.targetHandle === edge.targetHandle
      ) === index);
    const rewiredOutgoing = outgoingEdges
      .map((edge) => ({ ...edge, source: compoundId, sourceHandle: outputPortBySource.get(`${edge.source}:${edge.sourceHandle ?? "output"}`) }))
      .filter((edge) => Boolean(edge.sourceHandle));

    pushUndoSnapshot("Collapse nodes");
    setNodes((current) => {
      const nextNodes = [
        ...current.filter((node) => !selectedNodeIds.has(node.id)),
        { id: compoundId, type: "route", position, selected: false, data: { label: `${title}\ncompound.subroute`, routeNode } }
      ];
      nodesRef.current = nextNodes;
      return nextNodes;
    });
    setEdges((current) => {
      const nextEdges = [
        ...current.filter((edge) => !selectedNodeIds.has(edge.source) && !selectedNodeIds.has(edge.target)),
        ...rewiredIncoming,
        ...rewiredOutgoing
      ];
      edgesRef.current = nextEdges;
      return nextEdges;
    });
    setSelectedId(null);
    setRunResult(null);
    setOutputs(null);
    setLogs((current) => [`Collapsed ${selectedNodeIds.size} block(s) into ${compoundId}.`, ...current]);
  }

  function deleteNodeFromContext(nodeId: string) {
    pushUndoSnapshot(`Delete ${nodeId}`);
    setNodes((current) => {
      const nextNodes = current.filter((node) => node.id !== nodeId);
      nodesRef.current = nextNodes;
      return nextNodes;
    });
    setEdges((current) => {
      const nextEdges = current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
      edgesRef.current = nextEdges;
      return nextEdges;
    });
    setSelectedId(null);
    setContextMenu(null);
    clearNodeRunResult(nodeId);
    setLogs((current) => [`Deleted ${nodeId}.`, ...current]);
  }

  function renameNodeFromContext(nodeId: string) {
    const currentNode = nodes.find((node) => node.id === nodeId);
    const routeNode = currentNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (!currentNode || !routeNode) return;
    const title = window.prompt("Block title", routeNode.title ?? routeNode.id)?.trim();
    if (!title) {
      setContextMenu(null);
      return;
    }
    pushUndoSnapshot(`Rename ${nodeId}`);
    setNodes((current) => {
      const nextNodes = current.map((node) => {
        if (node.id !== nodeId) return node;
        const updatedRouteNode = { ...(node.data.routeNode as RouteDoc["nodes"][number]), title };
        return { ...node, data: { ...node.data, label: `${title}\n${updatedRouteNode.type}`, routeNode: updatedRouteNode } };
      });
      nodesRef.current = nextNodes;
      return nextNodes;
    });
    setContextMenu(null);
    setLogs((current) => [`Renamed ${nodeId} to "${title}".`, ...current]);
  }

  function duplicateNodeFromContext(nodeId: string) {
    const sourceNode = nodes.find((node) => node.id === nodeId);
    const sourceRouteNode = sourceNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (!sourceNode || !sourceRouteNode) return;
    let duplicatedId = "";
    pushUndoSnapshot(`Duplicate ${nodeId}`);
    setNodes((current) => {
      const usedIds = new Set(current.map((node) => node.id));
      const id = uniqueFlowId(`${sourceRouteNode.id}_copy`, usedIds);
      duplicatedId = id;
      const routeNode = structuredClone({ ...sourceRouteNode, id });
      const title = routeNode.title ?? sourceRouteNode.title ?? id;
      const nextNodes = [
        ...current,
        {
          ...sourceNode,
          id,
          selected: true,
          position: { x: sourceNode.position.x + 32, y: sourceNode.position.y + 32 },
          data: { ...sourceNode.data, label: `${title}\n${routeNode.type}`, routeNode }
        }
      ];
      nodesRef.current = nextNodes;
      return nextNodes;
    });
    if (duplicatedId) {
      setSelectedId(duplicatedId);
      setLogs((current) => [`Duplicated ${nodeId} as ${duplicatedId}.`, ...current]);
    }
    setContextMenu(null);
  }

  function openSubroute(nodeId: string) {
    const currentRoute = flowToRoute(nodes, edges, routeBase);
    const compound = currentRoute.nodes.find((node) => node.id === nodeId && node.type === "compound.subroute");
    if (!compound?.subroute) {
      setLogs((current) => [`${nodeId} has no editable subroute.`, ...current]);
      return;
    }
    const flow = routeToEditableSubrouteFlow(compound.subroute, compound);
    setRouteStack((current) => [...current, { compoundId: nodeId, parentRoute: currentRoute }]);
    setRouteBase(compound.subroute);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelectedId(null);
    setRunResult(null);
    setOutputs(null);
    setLogs((current) => [`Opened subroute ${nodeId}.`, ...current]);
  }

  function closeSubroute() {
    closeSubrouteTo(routeStack.length - 1);
  }

  function closeSubrouteTo(depth: number) {
    const frame = routeStack[routeStack.length - 1];
    if (!frame) return;
    const targetDepth = Math.max(0, Math.min(depth, routeStack.length - 1));
    let savedRoute = flowToRoute(nodes, edges, routeBase);
    const currentInterface = flowToCompoundInterface(nodes, edges, nodeCatalog);
    for (let index = routeStack.length - 1; index >= targetDepth; index -= 1) {
      const stackFrame = routeStack[index];
      savedRoute = {
        ...stackFrame.parentRoute,
        nodes: stackFrame.parentRoute.nodes.map((node) =>
          node.id === stackFrame.compoundId
            ? {
                ...node,
                subroute: savedRoute,
                compound: {
                  ...(node.compound ?? {}),
                  ...(index === routeStack.length - 1 ? currentInterface : {}),
                  title: node.compound?.title ?? savedRoute.route.title
                }
              }
            : node
        )
      };
    }
    const flow = routeToFlow(savedRoute);
    setRouteStack((current) => current.slice(0, targetDepth));
    setRouteBase(savedRoute);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelectedId(routeStack[targetDepth]?.compoundId ?? null);
    setRunResult(null);
    setOutputs(null);
    setLogs((current) => [`Saved subroute edits for ${frame.compoundId}.`, ...current]);
  }

  function buildRouteDocumentFrom(flowNodes: Node[], flowEdges: Edge[]): RouteDoc {
    let savedRoute = flowToRoute(flowNodes, flowEdges, routeBase);
    if (routeStack.length === 0) return savedRoute;

    const currentInterface = flowToCompoundInterface(flowNodes, flowEdges, nodeCatalog);
    for (let index = routeStack.length - 1; index >= 0; index -= 1) {
      const stackFrame = routeStack[index];
      savedRoute = {
        ...stackFrame.parentRoute,
        nodes: stackFrame.parentRoute.nodes.map((node) =>
          node.id === stackFrame.compoundId
            ? {
                ...node,
                subroute: savedRoute,
                compound: {
                  ...(node.compound ?? {}),
                  ...(index === routeStack.length - 1 ? currentInterface : {}),
                  title: node.compound?.title ?? savedRoute.route.title
                }
              }
            : node
        )
      };
    }

    return savedRoute;
  }

  function buildCurrentRouteDocument(): RouteDoc {
    return buildRouteDocumentFrom(nodes, edges);
  }

  function uncollapseCompoundNode(nodeId: string) {
    const compoundFlowNode = nodes.find((node) => node.id === nodeId);
    const compoundNode = compoundFlowNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (!compoundFlowNode || compoundNode?.type !== "compound.subroute" || !compoundNode.subroute) return;
    const subflow = routeToFlow(compoundNode.subroute);
    const inputMappings = new Map((compoundNode.compound?.inputs ?? []).map((port) => [port.id, port]));
    const outputMappings = new Map((compoundNode.compound?.outputs ?? []).map((port) => [port.id, port]));
    const usedEdgeIds = new Set([
      ...edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId).map((edge) => edge.id),
      ...subflow.edges.map((edge) => edge.id)
    ]);
    const incoming: Edge[] = edges
      .filter((edge) => edge.target === nodeId)
      .flatMap((edge) => {
        const port = inputMappings.get(edge.targetHandle ?? "");
        return port
          ? compoundMappingTargets(port).map((target) => ({
              ...edge,
              id: uniqueFlowId(`${edge.source}-${edge.sourceHandle ?? "output"}-${target.nodeId}-${target.port ?? "input"}`, usedEdgeIds),
              target: target.nodeId,
              targetHandle: target.port ?? null
            }))
          : [];
      });
    const outgoing: Edge[] = edges
      .filter((edge) => edge.source === nodeId)
      .flatMap((edge) => {
        const port = outputMappings.get(edge.sourceHandle ?? "");
        return port
          ? [{
              ...edge,
              id: uniqueFlowId(`${port.nodeId}-${port.port ?? "output"}-${edge.target}-${edge.targetHandle ?? "input"}`, usedEdgeIds),
              source: port.nodeId,
              sourceHandle: port.port ?? null
            }]
          : [];
      });

    pushUndoSnapshot(`Uncollapse ${nodeId}`);
    setNodes((current) => {
      const nextNodes = [...current.filter((node) => node.id !== nodeId), ...subflow.nodes.map((node) => ({ ...node, selected: true }))];
      nodesRef.current = nextNodes;
      return nextNodes;
    });
    setEdges((current) => {
      const nextEdges = [...current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId), ...subflow.edges, ...incoming, ...outgoing];
      edgesRef.current = nextEdges;
      return nextEdges;
    });
    setSelectedId(null);
    setRunResult(null);
    setOutputs(null);
    setLogs((current) => [`Uncollapsed ${nodeId} into ${subflow.nodes.length} block(s).`, ...current]);
  }

  function clearCanvas() {
    if (nodes.length === 0 && edges.length === 0) return;

    const nodeCount = nodes.length;
    const edgeCount = edges.length;
    if (!window.confirm(`Clear canvas and remove ${nodeCount} block(s), ${edgeCount} edge(s)?`)) return;

    pushUndoSnapshot("Clear canvas");
    nodesRef.current = [];
    edgesRef.current = [];
    setNodes([]);
    setEdges([]);
    setSelectedId(null);
    setParamsText("{}");
    setParamsError(null);
    setRunResult(null);
    setOutputs(null);
    setLogs((current) => [`Cleared canvas: removed ${nodeCount} block(s), ${edgeCount} edge(s).`, ...current]);
  }

  function isConnectionValid(connection: Connection | Edge): boolean {
    const sourceNode = nodes.find((node) => node.id === connection.source);
    const targetNode = nodes.find((node) => node.id === connection.target);
    if (!sourceNode || !targetNode || !connection.sourceHandle || !connection.targetHandle) return false;
    const sourceRouteNode = sourceNode.data.routeNode as RouteDoc["nodes"][number];
    const targetRouteNode = targetNode.data.routeNode as RouteDoc["nodes"][number];
    if (sourceRouteNode.type === "compound.output" || targetRouteNode.type === "compound.input") return false;
    const sourceManifest = nodeCatalog.find((item) => item.type === sourceRouteNode.type)?.manifest;
    const targetManifest = nodeCatalog.find((item) => item.type === targetRouteNode.type)?.manifest;
    const sourcePort = getNodePorts(sourceRouteNode.type, sourceManifest, sourceRouteNode).outputs.find((port) => port.id === connection.sourceHandle);
    const targetPort = getNodePorts(targetRouteNode.type, targetManifest, targetRouteNode).inputs.find((port) => port.id === connection.targetHandle);
    if (!sourcePort || !targetPort) return false;
    const existingCount = edges.filter((edge) => edge.target === connection.target && edge.targetHandle === connection.targetHandle).length;
    const maxConnections = targetPort.maxConnections ?? 1;
    if (existingCount >= maxConnections && maxConnections !== 1) return false;
    return arePortsCompatible(sourcePort.kind, targetPort.kind);
  }

  function connectNodes(connection: Connection) {
    setConnectionNodeMenu(null);
    setConnectionNodeSearch("");
    setPendingConnectionStart(null);
    if (!isConnectionValid(connection)) {
      setLogs((current) => [`Invalid connection: ${describeConnection(connection)}`, ...current]);
      return;
    }
    patchInterfaceNodeFromConnection(connection);
    const targetNode = nodes.find((node) => node.id === connection.target);
    const targetRouteNode = targetNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (targetRouteNode?.type === "compound.output" && connection.source && connection.sourceHandle) {
      exposeSubrouteOutput(connection.source, connection.sourceHandle, String(targetRouteNode.params?.portId ?? connection.sourceHandle));
    }
    pushUndoSnapshot(`Connect ${describeConnection(connection)}`);
    setEdges((current) => {
      const targetNode = nodesRef.current.find((node) => node.id === connection.target);
      const targetRouteNode = targetNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
      const targetManifest = targetRouteNode ? nodeCatalog.find((item) => item.type === targetRouteNode.type)?.manifest : undefined;
      const targetPort = targetRouteNode ? getNodePorts(targetRouteNode.type, targetManifest, targetRouteNode).inputs.find((port) => port.id === connection.targetHandle) : undefined;
      const baseEdges = (targetPort?.maxConnections ?? 1) === 1
        ? current.filter((edge) => edge.target !== connection.target || edge.targetHandle !== connection.targetHandle)
        : current;
      const nextEdges = addEdge(connection, baseEdges);
      edgesRef.current = nextEdges;
      return nextEdges;
    });
  }

  function patchInterfaceNodeFromConnection(connection: Connection) {
    const sourceNode = nodes.find((node) => node.id === connection.source);
    const targetNode = nodes.find((node) => node.id === connection.target);
    const sourceRouteNode = sourceNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    const targetRouteNode = targetNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (sourceRouteNode?.type === "compound.input" && targetNode && targetRouteNode && connection.targetHandle) {
      const targetManifest = nodeCatalog.find((item) => item.type === targetRouteNode.type)?.manifest;
      const targetPort = getNodePorts(targetRouteNode.type, targetManifest, targetRouteNode).inputs.find((port) => port.id === connection.targetHandle);
      updateInterfaceNodeMetadata(sourceRouteNode.id, connection.targetHandle, targetPort?.kind ?? "data", targetPort?.label ?? connection.targetHandle);
    }
    if (targetRouteNode?.type === "compound.output" && sourceNode && sourceRouteNode && connection.sourceHandle) {
      const sourceManifest = nodeCatalog.find((item) => item.type === sourceRouteNode.type)?.manifest;
      const sourcePort = getNodePorts(sourceRouteNode.type, sourceManifest, sourceRouteNode).outputs.find((port) => port.id === connection.sourceHandle);
      updateInterfaceNodeMetadata(targetRouteNode.id, connection.sourceHandle, sourcePort?.kind ?? "data", sourcePort?.label ?? connection.sourceHandle);
    }
  }

  function updateInterfaceNodeMetadata(nodeId: string, portId: string, kind: string, label: string) {
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== nodeId) return node;
        const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
        const updated = { ...routeNode, title: routeNode.title && routeNode.title !== "Compound Input" && routeNode.title !== "Compound Output" ? routeNode.title : label, params: { ...(routeNode.params ?? {}), portId, kind } };
        return { ...node, data: { ...node.data, label: `${updated.title ?? updated.id}\n${updated.type}`, routeNode: updated } };
      })
    );
  }

  function sourcePortForConnection(sourceNodeId: string, sourceHandle: string): PortSpec | null {
    const sourceNode = nodes.find((node) => node.id === sourceNodeId);
    if (!sourceNode) return null;
    const sourceRouteNode = sourceNode.data.routeNode as RouteDoc["nodes"][number];
    const sourceManifest = nodeCatalog.find((item) => item.type === sourceRouteNode.type)?.manifest;
    return getNodePorts(sourceRouteNode.type, sourceManifest, sourceRouteNode).outputs.find((port) => port.id === sourceHandle) ?? null;
  }

  function exposeSubrouteOutput(sourceNodeId: string, sourceHandle: string, preferredId?: string) {
    const frame = routeStack[routeStack.length - 1];
    const sourceNode = nodes.find((node) => node.id === sourceNodeId);
    const sourcePort = sourcePortForConnection(sourceNodeId, sourceHandle);
    if (!frame || !sourceNode || !sourcePort) return;
    const sourceRouteNode = sourceNode.data.routeNode as RouteDoc["nodes"][number];
    const sourceTitle = sourceRouteNode.title ?? sourceRouteNode.id;
    setRouteStack((current) => {
      if (current.length === 0) return current;
      const next = [...current];
      const last = next[next.length - 1];
      const parentRoute = {
        ...last.parentRoute,
        nodes: last.parentRoute.nodes.map((node) => {
          if (node.id !== last.compoundId || node.type !== "compound.subroute") return node;
          const outputs = node.compound?.outputs ?? [];
          if (outputs.some((port) => port.nodeId === sourceNodeId && (port.port ?? "output") === sourceHandle)) return node;
          const used = new Set(outputs.map((port) => port.id));
          const id = uniqueFlowId(String(preferredId ?? sourceHandle ?? sourceNodeId).replace(/\W+/g, "_") || "output", used);
          const mapping: CompoundPortMapping = {
            id,
            label: sourcePort.label ?? `${sourceTitle}.${sourceHandle}`,
            kind: sourcePort.kind,
            nodeId: sourceNodeId,
            port: sourceHandle
          };
          return { ...node, compound: { ...(node.compound ?? {}), outputs: [...outputs, mapping] } };
        })
      };
      next[next.length - 1] = { ...last, parentRoute };
      return next;
    });
    setLogs((current) => [`Exposed ${sourceNodeId}.${sourceHandle} on compound output.`, ...current]);
  }

  function addSubrouteInterfacePort(kind: "input" | "output") {
    if (kind === "input") {
      addSubrouteInputParameter();
      return;
    }
    const candidates = nodes.flatMap((node) => {
      const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
      const manifest = nodeCatalog.find((item) => item.type === routeNode.type)?.manifest;
      return getNodePorts(routeNode.type, manifest, routeNode).outputs.map((port) => ({ node, routeNode, port }));
    });
    if (candidates.length === 0) {
      setLogs((current) => ["No internal outputs available to expose.", ...current]);
      return;
    }
    const defaultValue = `${candidates[0].node.id}.${candidates[0].port.id}`;
    const value = window.prompt("Expose output as nodeId.port", defaultValue);
    if (!value) return;
    const [nodeId, portId] = value.trim().split(".");
    if (!nodeId || !portId) return;
    exposeSubrouteOutput(nodeId, portId);
  }

  function addSubrouteInputParameter() {
    const frame = routeStack[routeStack.length - 1];
    if (!frame) return;
    const compound = frame.parentRoute.nodes.find((node) => node.id === frame.compoundId && node.type === "compound.subroute");
    const existing = compound?.compound?.inputs ?? [];
    const candidates = nodes.flatMap((node) => {
      const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
      const manifest = nodeCatalog.find((item) => item.type === routeNode.type)?.manifest;
      return getNodePorts(routeNode.type, manifest, routeNode).inputs
        .filter((port) => !existing.some((mapping) => mapping.nodeId === node.id && (mapping.port ?? "input") === port.id))
        .map((port) => ({ node, routeNode, port }));
    });
    if (candidates.length === 0) {
      setLogs((current) => ["No internal inputs available to expose.", ...current]);
      return;
    }
    const defaultValue = `${candidates[0].node.id}.${candidates[0].port.id}`;
    const value = window.prompt("Expose input parameter as nodeId.port", defaultValue);
    if (!value) return;
    const [nodeId, portId] = value.trim().split(".");
    const candidate = candidates.find((entry) => entry.node.id === nodeId && entry.port.id === portId);
    if (!candidate) {
      setLogs((current) => [`Unknown internal input: ${value}.`, ...current]);
      return;
    }
    const used = new Set(existing.map((port) => port.id));
    const id = uniqueFlowId(String(portId || nodeId).replace(/\W+/g, "_") || "input", used);
    const mapping: CompoundPortMapping = {
      id,
      label: candidate.port.label ?? `${candidate.routeNode.title ?? candidate.node.id}.${candidate.port.id}`,
      kind: candidate.port.kind,
      nodeId: candidate.node.id,
      port: candidate.port.id
    };
    setRouteStack((current) => {
      if (current.length === 0) return current;
      const next = [...current];
      const last = next[next.length - 1];
      next[next.length - 1] = {
        ...last,
        parentRoute: {
          ...last.parentRoute,
          nodes: last.parentRoute.nodes.map((node) =>
            node.id === last.compoundId && node.type === "compound.subroute"
              ? { ...node, compound: { ...(node.compound ?? {}), inputs: [...(node.compound?.inputs ?? []), mapping] } }
              : node
          )
        }
      };
      return next;
    });
    setLogs((current) => [`Exposed ${candidate.node.id}.${candidate.port.id} as compound input.`, ...current]);
  }

  function compatibleInputForConnection(item: NodeCatalogItem, sourceNodeId: string, sourceHandle: string): PortSpec | null {
    const sourceNode = nodes.find((node) => node.id === sourceNodeId);
    if (!sourceNode) return null;
    const sourceRouteNode = sourceNode.data.routeNode as RouteDoc["nodes"][number];
    const sourceManifest = nodeCatalog.find((entry) => entry.type === sourceRouteNode.type)?.manifest;
    const sourcePort = getNodePorts(sourceRouteNode.type, sourceManifest, sourceRouteNode).outputs.find((port) => port.id === sourceHandle);
    if (!sourcePort) return null;
    return catalogItemPorts(item).inputs.find((targetPort) => arePortsCompatible(sourcePort.kind, targetPort.kind)) ?? null;
  }

  const possibleConnectionNodes = useMemo(() => {
    if (!connectionNodeMenu) return [];
    const catalogEntries = nodeCatalog
      .filter((item) => item.enabled !== false)
      .flatMap((item) => {
        const inputPort = compatibleInputForConnection(item, connectionNodeMenu.sourceNodeId, connectionNodeMenu.sourceHandle);
        return inputPort ? [{ kind: "catalog" as const, item, inputPort }] : [];
      });
    const sourcePort = sourcePortForConnection(connectionNodeMenu.sourceNodeId, connectionNodeMenu.sourceHandle);
    const outputEntry = routeStack.length > 0 && sourcePort
      ? [{ kind: "output" as const, inputPort: { id: "output", kind: sourcePort.kind, label: "Compound Output" } satisfies PortSpec }]
      : [];
    return [...outputEntry, ...catalogEntries] satisfies ConnectionNodeEntry[];
  }, [connectionNodeMenu, nodeCatalog, nodes, routeStack]);
  const connectionNodeSearchQuery = connectionNodeSearch.trim().toLowerCase();
  const filteredConnectionNodes = useMemo(
    () => possibleConnectionNodes.filter((entry) => connectionNodeEntryMatchesSearch(entry, connectionNodeSearchQuery)),
    [connectionNodeSearchQuery, possibleConnectionNodes]
  );

  const handleConnectStart: OnConnectStart = (_event, params) => {
    setConnectionNodeMenu(null);
    setConnectionNodeSearch("");
    if (!params.nodeId || !params.handleId || params.handleType !== "source") {
      setPendingConnectionStart(null);
      return;
    }
    setPendingConnectionStart({ nodeId: params.nodeId, handleId: params.handleId, handleType: params.handleType });
  };

  const handleConnectEnd: OnConnectEnd = (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
    const start = pendingConnectionStart;
    setPendingConnectionStart(null);
    if (!start || start.handleType !== "source" || connectionState.isValid) return;

    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".react-flow__pane")) return;

    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!point) return;
    setConnectionNodeMenu({
      clientX: point.clientX,
      clientY: point.clientY,
      flowPosition: flowPositionFromClientPoint(point.clientX, point.clientY),
      sourceNodeId: start.nodeId,
      sourceHandle: start.handleId
    });
    setConnectionNodeSearch("");
  };

  function addConnectedNode(item: NodeCatalogItem, targetHandle: string) {
    if (!connectionNodeMenu) return;
    const nodeId = addNodeFromCatalogItem(item, connectionNodeMenu.flowPosition);
    setEdges((current) => {
      const nextEdges = addEdge(
        {
          source: connectionNodeMenu.sourceNodeId,
          sourceHandle: connectionNodeMenu.sourceHandle,
          target: nodeId,
          targetHandle
        },
        current
      );
      edgesRef.current = nextEdges;
      return nextEdges;
    });
    setConnectionNodeMenu(null);
    setConnectionNodeSearch("");
  }

  function addConnectedOutput() {
    if (!connectionNodeMenu) return;
    const sourcePort = sourcePortForConnection(connectionNodeMenu.sourceNodeId, connectionNodeMenu.sourceHandle);
    const sourceNode = nodes.find((node) => node.id === connectionNodeMenu.sourceNodeId);
    const preferredId = String(sourcePort?.id ?? connectionNodeMenu.sourceHandle);
    const nodeId = addNodeFromCatalogItem(
      {
        type: "compound.output",
        label: "Compound Output",
        params: { portId: preferredId, kind: sourcePort?.kind ?? "data" }
      },
      positionRightOfAllNodes(sourceNode?.position.y ?? connectionNodeMenu.flowPosition.y)
    );
    exposeSubrouteOutput(connectionNodeMenu.sourceNodeId, connectionNodeMenu.sourceHandle, preferredId);
    setEdges((current) => {
      const nextEdges = addEdge(
        {
          source: connectionNodeMenu.sourceNodeId,
          sourceHandle: connectionNodeMenu.sourceHandle,
          target: nodeId,
          targetHandle: "value"
        },
        current
      );
      edgesRef.current = nextEdges;
      return nextEdges;
    });
    setConnectionNodeMenu(null);
    setConnectionNodeSearch("");
  }

  function selectNode(node: Node | null) {
    setSelectedId(node?.id ?? null);
    setParamsText(JSON.stringify((node?.data.routeNode as RouteDoc["nodes"][number] | undefined)?.params ?? {}, null, 2));
    setParamsError(null);
  }

  function saveParams() {
    if (!selectedId) return;
    try {
      const params = JSON.parse(paramsText);
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new Error("Params must be a JSON object.");
      }
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== selectedId) return node;
          const routeNode = { ...(node.data.routeNode as RouteDoc["nodes"][number]), params };
          return { ...node, data: { ...node.data, routeNode } };
        })
      );
      setParamsError(null);
      setLogs((current) => [`Saved params for ${selectedId}.`, ...current]);
    } catch (error) {
      const message = `Invalid params JSON: ${error instanceof Error ? error.message : String(error)}`;
      setParamsError(message);
      setLogs((current) => [message, ...current]);
    }
  }

  async function validate() {
    const route = flowToRoute(nodes, edges, routeBase);
    const response = await fetch(`${apiBase}/api/routes/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(route) });
    const result = await response.json();
    setOutputs(result);
    setRunResult(null);
    const validationMessages = result.ok
      ? ["Validation passed."]
      : [`Validation failed with ${result.issues?.length ?? 0} issue(s).`, ...((result.issues ?? []).map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`))];
    setLogs((current) => [...validationMessages, ...current]);
  }

  async function runRouteWithProgress(route: RouteDoc, initialNodeOutputs?: Record<string, unknown>) {
    try {
      const response = await apiFetch(`${apiBase}/api/routes/run/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initialNodeOutputs ? { route, initialNodeOutputs } : route)
      });
      if (!response.ok || !response.body) throw new Error(`Run request failed: ${response.status} ${response.statusText}`.trim());

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = "";
      let completedResult: RunDisplayResult | null = null;

      const handleEvent = (event: RunStreamEvent) => {
        if (event.type === "runStarted") {
          if (event.estimate) setRunCostEstimate(event.estimate);
          setRunResult((current) => ({ ...(current ?? {}), status: "running", runId: event.runId, startedAt: event.startedAt }));
          return;
        }
        if (event.type === "nodeResult" && event.nodeResult?.nodeId) {
          const { nodeId, ...nodeResult } = event.nodeResult;
          markNodeResultsFresh([nodeId]);
          setRunResult((current) => ({
            ...(current ?? { status: "running" }),
            nodeResults: {
              ...(current?.nodeResults ?? {}),
              [nodeId]: nodeResult
            }
          }));
          return;
        }
        if (event.type === "runCompleted" && event.result) {
          completedResult = event.result;
          return;
        }
        if (event.type === "runFailed") {
          throw new Error(event.error ?? "Run failed.");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          handleEvent(JSON.parse(line) as RunStreamEvent);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) handleEvent(JSON.parse(buffer) as RunStreamEvent);
      if (!completedResult) throw new Error("Run stream ended without a result.");
      const finalResult = completedResult as RunDisplayResult;

      setOutputs(finalResult);
      setRunResult((current) => ({
        ...finalResult,
        nodeResults: {
          ...(current?.nodeResults ?? {}),
          ...(finalResult.nodeResults ?? {})
        }
      }));
      markNodeResultsFresh(Object.keys(finalResult.nodeResults ?? {}));
      void loadLedgerSummary();
      void loadCreditBalance();
      void loadCreditTransactions();
      const runLogs = Array.isArray(finalResult.logs) ? finalResult.logs.map((entry: { message: string }) => entry.message) : [finalResult.error ?? "Run failed."];
      setLogs((current) => [...runLogs.reverse(), ...current]);
      return finalResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isFetchNetworkError(message)) {
        setLogs((current) => [`Progress stream unavailable: ${message}. Retrying without live progress.`, ...current]);
        return runRouteWithoutProgress(route, initialNodeOutputs);
      }
      const failedResult = failCurrentRun(message);
      setOutputs(failedResult);
      setLogs((current) => [message, ...current]);
      return failedResult;
    }
  }

  async function runRouteWithoutProgress(route: RouteDoc, initialNodeOutputs?: Record<string, unknown>) {
    try {
      const response = await apiFetch(`${apiBase}/api/routes/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initialNodeOutputs ? { route, initialNodeOutputs } : route)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(String(result.error ?? `Run request failed: ${response.status} ${response.statusText}`.trim()));
      setOutputs(result);
      setRunResult((current) => ({
        ...result,
        nodeResults: {
          ...(current?.nodeResults ?? {}),
          ...(result.nodeResults ?? {})
        }
      }));
      markNodeResultsFresh(Object.keys(result.nodeResults ?? {}));
      void loadLedgerSummary();
      void loadCreditBalance();
      void loadCreditTransactions();
      const runLogs = Array.isArray(result.logs) ? result.logs.map((entry: { message: string }) => entry.message) : [result.error ?? "Run failed."];
      setLogs((current) => [...runLogs.reverse(), ...current]);
      return result as RunDisplayResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedResult = failCurrentRun(message);
      setOutputs(failedResult);
      setLogs((current) => [message, ...current]);
      return failedResult;
    }
  }

  function failCurrentRun(message: string): RunDisplayResult {
    const completedAt = new Date().toISOString();
    let failedResult: RunDisplayResult = { status: "failed", error: message, completedAt };
    setRunResult((current) => {
      const nodeResults = Object.fromEntries(
        Object.entries(current?.nodeResults ?? {}).map(([nodeId, result]) => [
          nodeId,
          result.status === "pending" || result.status === "running"
            ? { ...result, status: "failed", error: result.error ?? message, completedAt }
            : result
        ])
      );
      failedResult = { ...(current ?? {}), status: "failed", error: message, completedAt, nodeResults };
      return failedResult;
    });
    return failedResult;
  }

  function isFetchNetworkError(message: string): boolean {
    return /failed to fetch|networkerror|load failed/i.test(message);
  }

  async function run() {
    if (runDisabledReason) {
      setLogs((current) => [runDisabledReason, ...current]);
      return;
    }
    const route = routeWithOnlyActiveEdges(flowToRoute(nodes, edges, routeBase), nodeCatalog);
    await refreshRunCostEstimate(route);
    await loadCreditBalance();
    markNodeResultsFresh(nodes.map((node) => node.id));
    setRunResult({
      status: "running",
      nodeResults: Object.fromEntries(nodes.map((node) => [node.id, { status: "pending" }]))
    });
    await runRouteWithProgress(route, pinnedInitialNodeOutputs(route.nodes));
    void loadCreditBalance();
  }

  async function runNodeWithDependencies(nodeId: string) {
    const target = nodes.find((node) => node.id === nodeId);
    if (!target) return;
    const route = routeWithOnlyActiveEdges(flowToNodeRoute(nodes, edges, routeBase, nodeId), nodeCatalog);
    markNodeResultsFresh(route.nodes.map((node) => node.id));
    setRunResult({
      status: "running",
      nodeResults: Object.fromEntries(route.nodes.map((node) => [node.id, { status: "pending" }]))
    });
    setLogs((current) => [`Running ${nodeId} and ${Math.max(route.nodes.length - 1, 0)} upstream dependency block(s).`, ...current]);
    await runRouteWithProgress(route, pinnedInitialNodeOutputs(route.nodes));
  }

  function fixNodeOutput(nodeId: string, output: unknown, options: FixNodeOutputOptions = {}) {
    const now = new Date().toISOString();
    const shouldPersist = options.persist ?? true;
    const currentNode = nodesRef.current.find((node) => node.id === nodeId);
    const currentRouteNode = currentNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (shouldPersist && pinnedOutputFromParams(currentRouteNode?.params) !== undefined) {
      const nextNodes = nodesRef.current.map((node) => {
        if (node.id !== nodeId) return node;
        const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
        return { ...node, data: { ...node.data, routeNode: { ...routeNode, params: unpinParams(routeNode.params) } } };
      });
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      if (selectedId === nodeId) {
        const selectedRouteNode = nextNodes.find((node) => node.id === nodeId)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
        setParamsText(JSON.stringify(selectedRouteNode?.params ?? {}, null, 2));
      }
      saveRouteDocument(buildRouteDocumentFrom(nextNodes, edgesRef.current), { saveStartup: true, logMessage: options.logMessage ?? `Unpinned output for ${nodeId}.` });
      return;
    }
    const nextNodes = shouldPersist
      ? nodesRef.current.map((node) => {
          if (node.id !== nodeId) return node;
          const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
          const params = { ...(routeNode.params ?? {}), pinnedOutput: output, pinnedOutputAt: now };
          return { ...node, data: { ...node.data, routeNode: { ...routeNode, params } } };
        })
      : nodes;
    if (shouldPersist) {
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
    }
    markNodeResultsFresh([nodeId]);
    setRunResult((current) => ({
      ...(current ?? { status: "succeeded" }),
      nodeResults: {
        ...(current?.nodeResults ?? {}),
        [nodeId]: {
          ...(current?.nodeResults?.[nodeId] ?? {}),
          status: "succeeded",
          output,
          completedAt: now,
          startedAt: current?.nodeResults?.[nodeId]?.startedAt ?? now
        }
      }
    }));
    if (shouldPersist && selectedId === nodeId) {
      const selectedRouteNode = nextNodes.find((node) => node.id === nodeId)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
      setParamsText(JSON.stringify(selectedRouteNode?.params ?? {}, null, 2));
    }
    if (shouldPersist) {
      saveRouteDocument(buildRouteDocumentFrom(nextNodes, edgesRef.current), { saveStartup: true, logMessage: options.logMessage ?? `Pinned output for ${nodeId}.` });
    } else if (options.logMessage) {
      setLogs((current) => [options.logMessage!, ...current]);
    }
  }

  function canRunNodeOnly(nodeId: string): boolean {
    const target = nodes.find((node) => node.id === nodeId);
    if (!target) return false;
    const targetNode = target.data.routeNode as RouteDoc["nodes"][number];
    const incomingEdges = edges.filter((edge) => edge.target === nodeId && activeEdgeIds.has(edge.id));
    const connectedInputsReady = incomingEdges.every((edge) => isReadySourceForNodeOnlyRun(edge.source));
    return connectedInputsReady && hasRequiredNodeOnlyInputs(targetNode, incomingEdges);
  }

  async function runNodeOnly(nodeId: string) {
    const target = nodes.find((node) => node.id === nodeId);
    if (!target) return;
    const routeNode = target.data.routeNode as RouteDoc["nodes"][number];
    const incomingEdges = edges.filter((edge) => edge.target === nodeId && activeEdgeIds.has(edge.id));
    const initialNodeOutputs: Record<string, unknown> = {};
    const missing = new Set<string>();

    for (const edge of incomingEdges) {
      const previous = nodeOnlySourceResult(edge.source);
      if (previous?.status !== "succeeded" || previous.output === undefined) {
        if (!isImmediateInputSource(edge.source)) missing.add(edge.source);
      } else {
        initialNodeOutputs[edge.source] = previous.output;
      }
    }

    if (missing.size > 0) {
      const message = `Cannot run ${nodeId} only: missing ready upstream output(s): ${[...missing].join(", ")}. Run dependencies first.`;
      setRunResult((current) => ({
        ...(current ?? {}),
        status: "failed",
        nodeResults: {
          ...(current?.nodeResults ?? {}),
          [nodeId]: { status: "failed", error: message }
        }
      }));
      setLogs((current) => [message, ...current]);
      return;
    }

    const sourceNodeIds = new Set(incomingEdges.map((edge) => edge.source));
    const routeNodes = nodes.filter((node) => node.id === nodeId || sourceNodeIds.has(node.id));
    const route = flowToRoute(routeNodes, incomingEdges, {
      ...routeBase,
      route: { ...routeBase.route, id: `${routeBase.route.id}-${nodeId}-only`, title: `${routeBase.route.title}: ${nodeId} only` }
    });
    Object.assign(initialNodeOutputs, { ...pinnedInitialNodeOutputs(route.nodes), ...initialNodeOutputs });
    markNodeResultsFresh([nodeId]);
    setRunResult((current) => ({
      ...(current ?? {}),
      status: "running",
      nodeResults: {
        ...(current?.nodeResults ?? {}),
        [nodeId]: { status: "pending" }
      }
    }));
    setLogs((current) => [`Running ${routeNode.id} only.`, ...current]);
    await runRouteWithProgress(route, initialNodeOutputs);
  }

  function isReadySourceForNodeOnlyRun(sourceNodeId: string): boolean {
    const previous = nodeOnlySourceResult(sourceNodeId);
    const routeNode = nodes.find((node) => node.id === sourceNodeId)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    return Boolean(routeNode && pinnedOutputFromParams(routeNode.params) !== undefined) || (previous?.status === "succeeded" && previous.output !== undefined) || isImmediateInputSource(sourceNodeId);
  }

  function nodeOnlySourceResult(sourceNodeId: string): NodeRunResult | undefined {
    const sourceNode = nodes.find((node) => node.id === sourceNodeId);
    const routeNode = sourceNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (!routeNode) return undefined;
    return readyNodeResult(routeNode, runResult?.nodeResults?.[sourceNodeId], nodes, edges, runResult);
  }

  function isImmediateInputSource(sourceNodeId: string): boolean {
    const source = nodes.find((node) => node.id === sourceNodeId);
    const routeNode = source?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (!routeNode) return false;
    if (routeNode.type === "input.text") return true;
    if (routeNode.type === "library.prompt") return true;
    if (routeNode.type === "input.file" || routeNode.type === "input.image" || routeNode.type === "input.video") {
      return Boolean(String(routeNode.params?.path ?? "").trim());
    }
    return false;
  }

  function exportRoute() {
    const route = buildCurrentRouteDocument();
    const filename = normalizeRouteExportFilename(`${route.route.id || "studio-route"}`);
    const blob = new Blob([exportRouteToText(route as OpenRoute, filename)], { type: "application/json" });
    downloadBlob(blob, filename);
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadImageSrc(src: string, filename: string) {
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      downloadBlob(blob, filename || "snarkroute-image.png");
    } catch (error) {
      setLogs((current) => [`Could not download image: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  function makeNodePackageId(title: string): string {
    return title.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^[._-]+|[._-]+$/g, "") || "custom.compound";
  }

  function nodeManifestFromCompoundNode(compoundNode: RouteDoc["nodes"][number], id: string, title: string): NodeManifest {
    const compound = compoundNode.compound ?? {};
    return {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id,
      title,
      version: "0.1.0",
      author: { name: "SnarkRoute Studio" },
      license: "UNLICENSED",
      origin: "generated",
      source: "snarkroute-studio",
      category: "Compound",
      description: `Generated from compound route "${compound.title ?? compoundNode.title ?? compoundNode.id}".`,
      permissions: { network: false, networkHosts: [], readFiles: false, writeOutputs: false, shell: false, env: [] },
      executor: { type: "declarative" },
      inputs: (compound.inputs ?? []).map((port) => ({ id: port.id, type: String(port.kind ?? "json"), label: port.label ?? port.id })),
      outputs: (compound.outputs ?? []).map((port) => ({ id: port.id, type: String(port.kind ?? "json"), label: port.label ?? port.id })),
      generatedWith: {
        tool: "snarkroute-studio",
        kind: "compound.subroute",
        compound: { ...compound, title },
        subroute: compoundNode.subroute
      }
    };
  }

  async function saveCompoundNodeAsPackage(nodeId: string) {
    setContextMenu(null);
    const flowNode = nodes.find((node) => node.id === nodeId);
    const compoundNode = flowNode?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (!compoundNode || compoundNode.type !== "compound.subroute" || !compoundNode.subroute) return;
    const title = window.prompt("Node package title", compoundNode.compound?.title ?? compoundNode.title ?? "Compound Node")?.trim();
    if (!title) return;
    const id = window.prompt("Node package id", makeNodePackageId(title))?.trim();
    if (!id) return;
    const manifest = nodeManifestFromCompoundNode(compoundNode, id, title);
    try {
      const response = await fetch(`${apiBase}/api/node-packages/install-generated`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? formatApiIssues(result));
      await loadNodeCatalog();
      downloadBlob(new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: "application/json" }), `${id}.node.json`);
      setLogs((current) => [`Saved compound as node package ${id}.`, ...current]);
    } catch (error) {
      setLogs((current) => [`Save node package failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  async function exportNodePackageFile(type: string) {
    setContextMenu(null);
    setLibraryItemMenu(null);
    try {
      const response = await fetch(`${apiBase}/api/node-packages/${encodeURIComponent(type)}/export`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? formatApiIssues(result));
      const bytes = result.dataBase64 ? Uint8Array.from(atob(String(result.dataBase64)), (char) => char.charCodeAt(0)) : String(result.text ?? "");
      downloadBlob(new Blob([bytes], { type: String(result.contentType ?? "application/json") }), String(result.filename ?? `${type}.node.json`));
      setLogs((current) => [`Exported block package ${type}.`, ...current]);
    } catch (error) {
      setLogs((current) => [`Export block package failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  function applyRoute(route: RouteDoc, logMessage: string) {
    const flow = routeToFlow(route);
    setRouteStack([]);
    setRouteBase(route);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setLoadedRouteSnapshot(routeSnapshot(route));
    setRunResult(null);
    setOutputs(null);
    setLogs((current) => [logMessage, ...current]);
  }

  function saveProject() {
    saveRouteDocument(buildCurrentRouteDocument(), { saveStartup: true, logMessage: supportsLocalFilesystem ? "Saved current project locally and as startup route." : "Saved current project to cloud storage." });
  }

  function saveRouteDocument(route: RouteDoc, options: { saveStartup?: boolean; logMessage?: string } = {}) {
    try {
      const filename = normalizeRouteExportFilename(`${route.route.id || "studio-route"}`);
      const text = exportRouteToText(route as OpenRoute, filename);
      localStorage.setItem(SAVED_PROJECT_STORAGE_KEY, text);
      setLoadedRouteSnapshot(routeSnapshot(loadRouteFromText(text, filename) as RouteDoc));
      setLogs((current) => [options.logMessage ?? "Saved current project locally.", ...current]);
      if (options.saveStartup) void saveStartupRoute(text, filename);
    } catch (error) {
      setLogs((current) => [`Save failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  async function saveStartupRoute(text: string, filename: string) {
    try {
      const response = await apiFetch(`${apiBase}/api/routes/startup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, filename })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(result.error ?? "Failed to save startup route."));
      setLogs((current) => [supportsLocalFilesystem ? "Saved startup route to repository default." : "Saved route to Postgres cloud storage.", ...current]);
    } catch (error) {
      setLogs((current) => [`Startup route file save skipped: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  function loadSavedProject() {
    try {
      const text = localStorage.getItem(SAVED_PROJECT_STORAGE_KEY);
      if (!text) {
        setLogs((current) => ["No saved project found.", ...current]);
        return;
      }
      applyRoute(loadRouteFromText(text, "saved-project.orp.json") as RouteDoc, "Loaded saved project.");
    } catch (error) {
      setLogs((current) => [`Load failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  async function importRoute(file: File | null) {
    if (!file) return;
    try {
      const route = loadRouteFromText(await file.text(), file.name) as RouteDoc;
      applyRoute(route, `Imported ${file.name}.`);
    } catch (error) {
      setLogs((current) => [`Import failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  function hasUnsavedRouteChanges(): boolean {
    return routeSnapshot(buildCurrentRouteDocument()) !== loadedRouteSnapshot;
  }

  function openExample(example: StudioExample) {
    if (hasUnsavedRouteChanges() && !window.confirm("Open this example? Unsaved changes may be lost.")) return;
    applyRoute(example.route, `Loaded example: ${example.title}.`);
    setExampleMenuOpen(false);
  }

  function openDoc(doc: StudioDocEntry) {
    setActiveDoc(doc);
    setDocsMenuOpen(false);
  }

  return (
    <div className={`app ${leftCollapsed ? "leftCollapsed" : ""} ${rightCollapsed ? "rightCollapsed" : ""} ${bottomCollapsed ? "bottomCollapsed" : ""}`}>
      <aside className="sidebar left nowheel">
        <div className="sidebarHeader">
          {!leftCollapsed ? (
            <h1 className="appBrand">
              <img className="appBrandIcon" src="/boojumroute-icon.png" alt="" />
              <span className="appBrandText">
                <span>BoojumRoute</span>
                <span>Lab</span>
              </span>
            </h1>
          ) : null}
          <button className="iconButton" title={leftCollapsed ? "Expand left panel" : "Collapse left panel"} onClick={() => setLeftCollapsed((value) => !value)}>
            {leftCollapsed ? <ChevronRight size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        {!leftCollapsed ? (
        <>
        <div className="toolbar">
          <button className="openExampleButton" onClick={() => setExampleMenuOpen((value) => !value)} title="Open example route"><Wand2 size={16} /> Open Example</button>
          {exampleMenuOpen ? (
            <div className="exampleMenu" role="menu" aria-label="Example routes">
              {exampleCategories.map((category) => {
                const examples = studioExamples.filter((example) => example.category === category);
                if (examples.length === 0) return null;
                return (
                  <section className="exampleGroup" key={category}>
                    <h3>{category}</h3>
                    {examples.map((example) => (
                      <button className="exampleItem" key={example.route.route.id} onClick={() => openExample(example)} role="menuitem">
                        <span className="exampleItemText">
                          <strong>{example.title}</strong>
                          <span>{example.description}</span>
                        </span>
                        <span className={`providerBadge ${example.provider.toLowerCase()}`}>{example.provider}</span>
                      </button>
                    ))}
                  </section>
                );
              })}
            </div>
          ) : null}
          <button className="docsButton" onClick={() => setDocsMenuOpen((value) => !value)} title="Open project documentation"><BookOpen size={16} /> Docs</button>
          {docsMenuOpen ? (
            <div className="docsMenu" role="menu" aria-label="Project documentation">
              {studioDocs.map((doc) => (
                <button className="docsMenuItem" key={doc.id} onClick={() => openDoc(doc)} role="menuitem">
                  <span>{doc.title}</span>
                  <small>{studioDocKindLabel(doc.kind)} · {doc.language.toUpperCase()}</small>
                </button>
              ))}
            </div>
          ) : null}
          {supportsLocalFilesystem ? (
            <>
              <button onClick={exportRoute} title="Export route"><Download size={16} /> Export</button>
              <label className="fileButton" title="Import route"><Upload size={16} /> Import<input type="file" accept={ROUTE_FILE_ACCEPT} onChange={(event) => void importRoute(event.target.files?.[0] ?? null)} /></label>
              <label className="fileButton" title="Import block package"><Plus size={16} /> Block<input type="file" accept=".snarknode,.json,.node.json,application/json" onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                if (file) void importNodePackageFile(file);
              }} /></label>
              <button onClick={loadSavedProject} title="Load saved project"><FolderOpen size={16} /> Load</button>
            </>
          ) : null}
          <button type="button" onClick={saveProject} title="Save current project"><Save size={16} /> Save</button>
        </div>
        <div className="nodesHeading">
          <h2>Blocks</h2>
          <div className="nodesHeadingActions">
            <button
              className={`nodeSmallButton ${showHiddenNodes ? "active" : ""}`}
              title="Show hidden blocks"
              onClick={() => setShowHiddenNodes((value) => !value)}
              disabled={hiddenNodeCount === 0}
            >
              <Eye size={14} /> Hidden{hiddenNodeCount ? ` ${hiddenNodeCount}` : ""}
            </button>
            <button className="nodeSmallButton iconOnly" title="Create group" onClick={createLibraryGroup}><Plus size={14} /></button>
          </div>
        </div>
        <label className="nodeSearch">
          <Search size={14} />
          <input value={nodeSearch} placeholder="Search blocks" onChange={(event) => setNodeSearch(event.target.value)} />
          {nodeSearch ? (
            <button className="nodeSearchClear" title="Clear search" onClick={() => setNodeSearch("")} type="button"><X size={13} /></button>
          ) : null}
        </label>
        <div className="portLegend">
          <span><i className="legendDot text" />Text</span>
          <span><i className="legendDot image" />Image</span>
          <span><i className="legendDot json" />JSON</span>
          <span><i className="legendDot video" />Video</span>
          <span><i className="legendDot file" />File</span>
        </div>
        <div className="librarySections nowheel">
          {visibleCatalogSections.map((section) => {
            const collapsed = nodeSearchQuery ? false : collapsedLibrarySections[section.id] ?? true;
            const items = section.items;
            return (
              <section className="librarySection" key={section.id}>
                <div
                  className="librarySectionHeader"
                  onContextMenu={(event) => openLibrarySectionMenu(event, section)}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes(NODE_DRAG_MIME)) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }
                  }}
                  onDrop={(event) => handleLibrarySectionDrop(event, section.id, section.title)}
                >
                  <button className="librarySectionToggle" onClick={() => toggleLibrarySection(section.id)}>
                    {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span>{section.title}</span>
                    <small>{items.length}</small>
                  </button>
                </div>
                {!collapsed ? <div className="librarySectionItems">{items.map((item) => renderLibraryItem(item, section))}</div> : null}
              </section>
            );
          })}
          {nodeSearchQuery && visibleCatalogItemCount === 0 ? <p className="muted nodeSearchEmpty">No blocks match "{nodeSearch.trim()}".</p> : null}
        </div>
        </>
        ) : null}
      </aside>

      <main
        ref={canvasRef}
        className="canvas"
        data-canvas-theme={canvasBackgroundTheme}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = event.dataTransfer.types.includes(NODE_DRAG_MIME) || event.dataTransfer.types.includes("Files") ? "copy" : "none";
        }}
        onDrop={handleCanvasDrop}
      >
        <div className="topbar">
          {routeStack.length > 0 ? (
            <div className="routeBreadcrumbs" aria-label="Internal tool route breadcrumbs">
              <button className="breadcrumbBack" title="Back to parent internal tool route" onClick={closeSubroute}><ChevronLeft size={16} /></button>
              <button className="breadcrumbRoot" title="Back to root route" onClick={() => closeSubrouteTo(0)}>Root</button>
              {routeBreadcrumbs.map((crumb, index) => {
                const isCurrent = index === routeBreadcrumbs.length - 1;
                const isParent = index === routeBreadcrumbs.length - 2;
                const isCompactAncestor = !isCurrent && !isParent;

                return (
                  <React.Fragment key={`${crumb.id}-${index}`}>
                    <span className="breadcrumbSeparator">/</span>
                    <button
                      className={`breadcrumbCrumb ${isCurrent ? "current" : isParent ? "parent" : "compactAncestor"}`}
                      title={`Back to ${crumb.title}`}
                      disabled={isCurrent}
                      onClick={() => closeSubrouteTo(index + 1)}
                    >
                      {isCompactAncestor ? (
                        "..."
                      ) : isParent ? (
                        <>
                          <span className="breadcrumbEllipsis">...</span>
                          <span className="breadcrumbTail">{compactBreadcrumbTitle(crumb.title)}</span>
                        </>
                      ) : (
                        crumb.title
                      )}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          ) : null}
          {routeStack.length > 0 ? (
            <>
              <button onClick={() => addNode("compound.input")}><ChevronRight size={16} /> Tool Input</button>
              <button onClick={() => addNode("compound.output", positionRightOfAllNodes())}>Tool Output <ChevronRight size={16} /></button>
            </>
          ) : null}
          <button
            className={`primary ${runDisabledReason ? "runIconOnly" : ""}`.trim()}
            onClick={() => void run()}
            disabled={Boolean(runDisabledReason)}
            title={runDisabledReason || "Run current route"}
            aria-label={runDisabledReason || "Run current route"}
          >
            <Play size={16} />
            {runDisabledReason ? null : "Run"}
          </button>
          {isCloudMode && capabilities.supportsCredits ? (
            <div className={`topbarCreditBadge ${currentUser ? "" : "guest"} ${runDisabledReason ? "warning" : ""}`.trim()}>
              {currentUser ? (
                <>
                  <strong>Credits: {creditBalance ? formatCredits(creditBalance.balance) : "unknown"}</strong>
                  {routeHasPaidEstimate ? (
                    <span>{runDisabledReason ? `Need ${formatCredits(routeEstimatedCredits)}, balance ${creditBalance ? formatCredits(creditBalance.balance) : "unknown"}` : `This run: ≈${formatCredits(routeEstimatedCredits)} credits`}</span>
                  ) : <span>This run: Free</span>}
                </>
              ) : (
                <>
                  <strong>Guest demo</strong>
                  <span>{capabilities.supportsGuestDemo ? "Demo routes only" : "Login required"}</span>
                </>
              )}
            </div>
          ) : null}
          {isCloudMode && currentUser && capabilities.supportsCredits && routeHasPaidEstimate ? (
            <div className={`topbarRunEstimate ${runDisabledReason ? "warning" : ""}`.trim()}>
              <span>This run: ≈{formatCredits(routeEstimatedCredits)} credits</span>
              <strong>
                {routeBalanceAfter === null
                  ? "After run: unknown"
                  : routeBalanceAfter < 0
                    ? `${formatCredits(creditBalance?.balance ?? 0)} -> ${formatCredits(routeBalanceAfter)} impossible`
                    : `After run: ${formatCredits(routeBalanceAfter)} credits`}
              </strong>
            </div>
          ) : null}
          {isCloudMode ? (
            <>
              <button onClick={() => { setRightCollapsed(false); void login(); }}><KeyRound size={16} /> {currentUser ? "User" : "Login"}</button>
              {capabilities.supportsCredits ? (
                <button onClick={() => {
                  setRightCollapsed(false);
                  setCreditHistoryOpen(true);
                  void loadCreditTransactions(25);
                }}><Sparkles size={16} /> Credit history</button>
              ) : null}
            </>
          ) : null}
          {(!isCloudMode || showDeveloperDiagnostics) ? (
            <>
              <button onClick={collapseSelectedNodes} disabled={selectedNodeCount < 2}><Braces size={16} /> Collapse</button>
              <button className="danger" onClick={deleteSelection} disabled={selectedNodeCount === 0 && selectedEdgeCount === 0 && !selectedId}><Trash2 size={16} /> Delete</button>
              <button className="danger" onClick={clearCanvas} disabled={nodes.length === 0 && edges.length === 0}><Eraser size={16} /> Clear</button>
            </>
          ) : null}
          {supportsLocalFilesystem ? <button className="danger" onClick={() => void shutdownServices()} disabled={!apiConnected || shuttingDown} title="Close BoojumRoute Lab and stop local services"><Power size={16} /> {shuttingDown ? "Closing" : "Close"}</button> : null}
          {capabilities.supportsDeveloperDiagnostics && !isProductionBuild ? (
            <div className="devIdentitySwitcher" title="Dev identity is stored per browser in a cookie.">
              <span>Dev identity</span>
              {(["guest", "user", "admin"] as const).map((identity) => (
                <button
                  key={identity}
                  className={devIdentity === identity ? "active" : ""}
                  type="button"
                  onClick={() => void switchDevIdentity(identity)}
                >
                  {identity[0].toUpperCase() + identity.slice(1)}
                </button>
              ))}
            </div>
          ) : null}
          {isAdmin ? <button type="button" onClick={() => navigate("/admin")}><Lock size={16} /> Admin</button> : null}
          {showDeveloperDiagnostics ? <div className={`apiStatus ${apiConnected ? "connected" : "disconnected"}`} title={apiError || `API: ${apiBase}`}>
            <span>API: {apiBase}</span>
            <strong>{apiConnected ? "connected" : "disconnected"}</strong>
            <em>{productLabel}: {capabilities.mode}</em>
            <em>user: {currentUserLabel}</em>
            {isCloudMode ? <em>credits: {creditBalance ? formatCredits(creditBalance.balance) : "unknown"}</em> : null}
            <em>{apiConnected ? (replicateConfigured ? "replicate: configured" : "replicate: missing") : "replicate: unknown"}</em>
            <em>{apiConnected ? (geminiConfigured ? "gemini: configured" : "gemini: missing") : "gemini: unknown"}</em>
            <em>{apiConnected ? (openAiConfigured ? "openai: configured" : "openai: missing") : "openai: unknown"}</em>
            <em>{apiConnected ? (seedanceConfigured ? "seedance: configured" : `seedance: ${seedanceSettings.statusText ?? "missing"}`) : "seedance: unknown"}</em>
            <em>{apiConnected ? (polzaConfigured ? "polza: configured" : "polza: missing") : "polza: unknown"}</em>
          </div> : null}
        </div>
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={connectNodes}
          onConnectStart={handleConnectStart}
          onConnectEnd={handleConnectEnd}
          onInit={setReactFlowInstance}
          isValidConnection={isConnectionValid}
          onNodeClick={(_event, node) => {
            if (isSubrouteInterfaceId(node.id)) return;
            setContextMenu(null);
            setLibraryItemMenu(null);
            setLibrarySectionMenu(null);
            setPromptAssetMenu(null);
            selectNode(node);
          }}
          onNodeContextMenu={(event, node) => {
            if (isSubrouteInterfaceId(node.id)) return;
            event.preventDefault();
            setPromptAssetMenu(null);
            setPromptLibraryMenu(null);
            setLibraryItemMenu(null);
            setLibrarySectionMenu(null);
            setSelectedId(node.id);
            setContextMenu({ clientX: event.clientX, clientY: event.clientY, nodeId: node.id });
          }}
          onSelectionContextMenu={(event) => {
            event.preventDefault();
            setPromptAssetMenu(null);
            setPromptLibraryMenu(null);
            setLibraryItemMenu(null);
            setLibrarySectionMenu(null);
            setContextMenu({ clientX: event.clientX, clientY: event.clientY });
          }}
          onPaneContextMenu={(event) => {
            event.preventDefault();
            setPromptAssetMenu(null);
            setPromptLibraryMenu(null);
            setLibraryItemMenu(null);
            setLibrarySectionMenu(null);
            setSelectedId(null);
            setContextMenu({ clientX: event.clientX, clientY: event.clientY });
          }}
          onEdgeClick={() => {
            setContextMenu(null);
            setLibraryItemMenu(null);
            setLibrarySectionMenu(null);
            setPromptAssetMenu(null);
            setPromptLibraryMenu(null);
            setSelectedId(null);
          }}
          onPaneClick={() => {
            selectNode(null);
            setConnectionNodeMenu(null);
            setConnectionNodeSearch("");
            setContextMenu(null);
            setLibraryItemMenu(null);
            setLibrarySectionMenu(null);
            setPromptAssetMenu(null);
            setPromptLibraryMenu(null);
          }}
          onKeyDown={(event) => {
            if ((event.key === "Delete" || event.key === "Backspace") && !isTextEditingTarget(event.target)) {
              deleteSelection();
            }
          }}
          multiSelectionKeyCode={["Shift", "Meta", "Control"]}
          selectionOnDrag
          panOnDrag={[1, 2]}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          fitView
        >
          {canvasThemeConfig.reactFlowBackground === "lines" ? (
            <Background id="canvas-grid" variant={BackgroundVariant.Lines} color="rgba(124, 139, 162, 0.2)" bgColor="transparent" gap={32} lineWidth={1} />
          ) : null}
          {canvasThemeConfig.reactFlowBackground === "dots" ? (
            <Background id="canvas-dots" variant={BackgroundVariant.Dots} color="rgba(130, 146, 170, 0.34)" bgColor="transparent" gap={24} size={2.5} />
          ) : null}
        </ReactFlow>
        {activeDialogueRouteNode?.type === "dialogue.workbench" ? (
          <DialogueWorkbenchEditor
            routeNode={activeDialogueRouteNode}
            inputs={activeDialogueInputs}
            modelProfiles={modelProfiles}
            agentPresets={agentPresets}
            onClose={() => setActiveDialogueWorkbenchId(null)}
            onSave={(state, patch) => updateDialogueWorkbenchState(activeDialogueRouteNode.id, state, patch)}
          />
        ) : null}
        {contextMenu ? (
          <div className="contextMenu" style={{ left: contextMenu.clientX, top: contextMenu.clientY }} onClick={(event) => event.stopPropagation()}>
            {contextMenu.nodeId ? (
              <>
                {contextRouteNode && shouldShowNodeRunButton(contextRouteNode.type) ? (
                  <>
                    <button
                      disabled={!canRunNodeOnly(contextMenu.nodeId)}
                      title={canRunNodeOnly(contextMenu.nodeId) ? "Run this block only" : "Run dependencies first to prepare upstream outputs"}
                      onClick={() => { void runNodeOnly(contextMenu.nodeId!); setContextMenu(null); }}
                    >
                      Run Block Only
                    </button>
                    <button onClick={() => { void runNodeWithDependencies(contextMenu.nodeId!); setContextMenu(null); }}>
                      Run With Dependencies
                    </button>
                  </>
                ) : null}
                <button onClick={() => renameNodeFromContext(contextMenu.nodeId!)}>Rename Block</button>
                <button onClick={() => duplicateNodeFromContext(contextMenu.nodeId!)}>Duplicate Block</button>
                {contextRouteNode ? (
                  <button onClick={() => void exportNodePackageFile(contextRouteNode.type)}>Export Block Package</button>
                ) : null}
                {contextRouteNode?.type === "compound.subroute" ? (
                  <>
                    <button onClick={() => { openSubroute(contextMenu.nodeId!); setContextMenu(null); }}>Open Internal Tool Route</button>
                    <button onClick={() => { uncollapseCompoundNode(contextMenu.nodeId!); setContextMenu(null); }}>Uncollapse</button>
                    <button onClick={() => void saveCompoundNodeAsPackage(contextMenu.nodeId!)}>Save as Block Package</button>
                  </>
                ) : null}
                {contextRouteNode?.type === "dialogue.workbench" ? (
                  <button onClick={() => { openDialogueWorkbench(contextMenu.nodeId!); setContextMenu(null); }}>Open Workbench</button>
                ) : null}
                <button onClick={() => deleteNodeFromContext(contextMenu.nodeId!)}>Delete Block</button>
              </>
            ) : (
              <>
                <button disabled={selectedNodeCount < 2} onClick={() => { collapseSelectedNodes(); setContextMenu(null); }}>Collapse Selection</button>
                {routeStack.length > 0 ? <button onClick={() => { closeSubroute(); setContextMenu(null); }}>Back to Parent</button> : null}
                <button disabled={nodes.length === 0 && edges.length === 0} onClick={() => { clearCanvas(); setContextMenu(null); }}>Clear Canvas</button>
              </>
            )}
          </div>
        ) : null}
        {libraryItemMenu ? (
          <div className="contextMenu" style={{ left: libraryItemMenu.clientX, top: libraryItemMenu.clientY }} onClick={(event) => event.stopPropagation()}>
            {(() => {
              const item = nodeCatalog.find((candidate) => candidate.type === libraryItemMenu.type);
              const isHidden = hiddenNodeTypes.has(libraryItemMenu.type);
              const canDelete = Boolean(item?.manifest && canUninstallNodePackage(item.manifest));
              return (
                <>
                  <strong>{item ? catalogItemTitle(item) : libraryItemMenu.type}</strong>
                  <span className="contextMenuHint">{libraryItemMenu.type}</span>
                  <button onClick={() => moveLibraryItem(libraryItemMenu.type, libraryItemMenu.sectionId, libraryItemMenu.sectionTitle, libraryItemMenu.sectionTypes, -1)}>Move Up</button>
                  <button onClick={() => moveLibraryItem(libraryItemMenu.type, libraryItemMenu.sectionId, libraryItemMenu.sectionTitle, libraryItemMenu.sectionTypes, 1)}>Move Down</button>
                  {isHidden ? (
                    <button onClick={() => showLibraryItem(libraryItemMenu.type)}>Show in Blocks</button>
                  ) : (
                    <button onClick={() => hideLibraryItem(libraryItemMenu.type)}>Hide from Blocks</button>
                  )}
                  <button onClick={() => setShowHiddenNodes((value) => !value)}>
                    {showHiddenNodes ? "Hide Hidden Blocks" : "Show Hidden Blocks"}
                  </button>
                  {supportsLocalFilesystem ? <button onClick={() => void exportNodePackageFile(libraryItemMenu.type)}>Export Block Package</button> : null}
                  {supportsLocalFilesystem ? (
                    <>
                      <button className="danger" disabled={!canDelete} title={canDelete ? "Delete installed block package" : "Bundled blocks cannot be deleted"} onClick={() => void deleteLibraryItem(libraryItemMenu.type)}>
                        Delete Block Package
                      </button>
                      {!canDelete ? <span className="contextMenuHint">Bundled blocks can be hidden, but not deleted.</span> : null}
                    </>
                  ) : null}
                </>
              );
            })()}
          </div>
        ) : null}
        {librarySectionMenu ? (
          <div className="contextMenu" style={{ left: librarySectionMenu.clientX, top: librarySectionMenu.clientY }} onClick={(event) => event.stopPropagation()}>
            {(() => {
              const hiddenInSection = librarySectionMenu.sectionTypes.filter((type) => hiddenNodeTypes.has(type));
              const allHidden = librarySectionMenu.sectionTypes.length > 0 && hiddenInSection.length === librarySectionMenu.sectionTypes.length;
              return (
                <>
                  <strong>{librarySectionMenu.sectionTitle}</strong>
                  <span className="contextMenuHint">{librarySectionMenu.sectionTypes.length} block(s)</span>
                  <button onClick={() => moveLibrarySection(librarySectionMenu.sectionId, librarySectionMenu.sectionTitle, librarySectionMenu.sectionTypes, -1)}>Move Section Up</button>
                  <button onClick={() => moveLibrarySection(librarySectionMenu.sectionId, librarySectionMenu.sectionTitle, librarySectionMenu.sectionTypes, 1)}>Move Section Down</button>
                  {allHidden ? (
                    <button onClick={() => showLibrarySection(librarySectionMenu.sectionTypes)}>Show Section</button>
                  ) : (
                    <button onClick={() => hideLibrarySection(librarySectionMenu.sectionTypes)}>Hide Section</button>
                  )}
                  <button onClick={() => setShowHiddenNodes((value) => !value)}>
                    {showHiddenNodes ? "Hide Hidden Blocks" : "Show Hidden Blocks"}
                  </button>
                  <button className="danger" onClick={() => deleteLibraryGroup(librarySectionMenu.sectionId, librarySectionMenu.sectionTitle, librarySectionMenu.sectionTypes)}>Delete Group</button>
                </>
              );
            })()}
          </div>
        ) : null}
        {promptAssetMenu && supportsLocalFilesystem ? (
          <div
            ref={promptAssetMenuRef}
            className="contextMenu"
            style={{ left: promptAssetMenu.clientX, top: promptAssetMenu.clientY }}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            {(() => {
              const warning = promptAssetMenuWarning(promptAssetMenu);
              return (
                <>
                  <button
                    disabled={Boolean(warning)}
                    title={warning || "Save as Prompt Asset"}
                    onClick={() => { openPromptAssetDialog(promptAssetMenu.nodeId, promptAssetMenu.result); setPromptAssetMenu(null); }}
                  >
                    Save as Prompt Asset
                  </button>
                  {warning ? <span className="contextMenuHint">{warning}</span> : null}
                </>
              );
            })()}
          </div>
        ) : null}
        {promptLibraryMenu ? (
          <div className="contextMenu promptLibraryContextMenu" style={{ left: promptLibraryMenu.clientX, top: promptLibraryMenu.clientY }} onClick={(event) => event.stopPropagation()}>
            <strong>Prompt actions</strong>
            <span className="contextMenuHint">{promptLibraryMenu.prompt.category}/{promptLibraryMenu.prompt.id}</span>
            <button onClick={() => { movePromptLibraryPrompt(promptLibraryMenu.prompt); setPromptLibraryMenu(null); }}>Move to Category...</button>
            <button onClick={() => { void updatePromptLibraryPrompt(promptLibraryMenu.prompt, { status: "draft" }); setPromptLibraryMenu(null); }}>Mark Draft</button>
            <button onClick={() => { void updatePromptLibraryPrompt(promptLibraryMenu.prompt, { status: "candidate" }); setPromptLibraryMenu(null); }}>Mark Candidate</button>
            <button onClick={() => { void updatePromptLibraryPrompt(promptLibraryMenu.prompt, { status: "approved" }); setPromptLibraryMenu(null); }}>Mark Approved</button>
            <button onClick={() => { void updatePromptLibraryPrompt(promptLibraryMenu.prompt, { status: "published" }); setPromptLibraryMenu(null); }}>Mark Published</button>
            <button onClick={() => { void updatePromptLibraryPrompt(promptLibraryMenu.prompt, { status: "archived" }); setPromptLibraryMenu(null); }}>Archive</button>
            <button className="danger" onClick={() => { void deletePromptLibraryPrompt(promptLibraryMenu.prompt); setPromptLibraryMenu(null); }}>Delete Prompt Asset</button>
          </div>
        ) : null}
        {connectionNodeMenu ? (
          <div
            className="connectionNodeMenu nowheel"
            style={{ left: connectionNodeMenu.clientX, top: connectionNodeMenu.clientY }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="connectionNodeMenuHeader">
              <strong>Add connected node</strong>
              <button className="iconButton" title="Close" onClick={() => { setConnectionNodeMenu(null); setConnectionNodeSearch(""); }}><X size={14} /></button>
            </div>
            <label className="connectionNodeSearch">
              <Search size={14} />
              <input
                value={connectionNodeSearch}
                placeholder="Search compatible blocks"
                onChange={(event) => setConnectionNodeSearch(event.target.value)}
                autoFocus
              />
              {connectionNodeSearch ? (
                <button className="nodeSearchClear" title="Clear search" onClick={() => setConnectionNodeSearch("")} type="button"><X size={13} /></button>
              ) : null}
            </label>
            {filteredConnectionNodes.length ? (
              <div className="connectionNodeMenuItems">
                {filteredConnectionNodes.map((entry) => (
                  <button
                    key={entry.kind === "output" ? "compound-output" : `${entry.item.type}:${entry.inputPort.id}`}
                    className="connectionNodeMenuItem"
                    onClick={() => entry.kind === "output" ? addConnectedOutput() : addConnectedNode(entry.item, entry.inputPort.id)}
                  >
                    <span className={`libraryNodeIcon ${entry.kind === "output" ? "output" : nodeIconClass(entry.item.type)}`}>
                      {entry.kind === "output" ? <Save size={15} /> : nodeIcon(entry.item.type)}
                    </span>
                    <strong>{entry.kind === "output" ? "Output" : catalogItemTitle(entry.item)}</strong>
                    <span>{entry.kind === "output" ? "Expose on compound node" : `${entry.item.type} / ${entry.inputPort.label ?? entry.inputPort.id}`}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p>{possibleConnectionNodes.length ? `No compatible blocks match "${connectionNodeSearch.trim()}".` : "No compatible blocks."}</p>
            )}
          </div>
        ) : null}
        <input
          id="asset-file-picker"
          className="hiddenFileInput"
          type="file"
          accept={pendingBrowse?.kind === "image" ? "image/png,image/jpeg,image/webp" : pendingBrowse?.kind === "video" ? "video/*" : undefined}
          onChange={(event) => {
            void handleFallbackFile(event.target.files?.[0] ?? null);
            event.currentTarget.value = "";
          }}
        />
      </main>

      <aside className="sidebar right">
        <div className="sidebarHeader">
          {!rightCollapsed ? <h2>Settings</h2> : null}
          <button className="iconButton" title={rightCollapsed ? "Expand right panel" : "Collapse right panel"} onClick={() => setRightCollapsed((value) => !value)}>
            {rightCollapsed ? <ChevronLeft size={17} /> : <PanelRightClose size={17} />}
          </button>
        </div>
        {!rightCollapsed ? (
        <>
        <div className="settingsPanel">
          {showDeveloperDiagnostics ? <div className={`apiStatusPanel ${apiConnected ? "connected" : "disconnected"}`}>
            <span>API</span>
            <strong>{apiBase}</strong>
            <em>{apiConnected ? "connected" : "disconnected"}</em>
            <em>{productLabel}: {capabilities.mode}</em>
            <em>User: {currentUserLabel}</em>
            {apiError ? <p>{apiError}</p> : null}
          </div> : null}
          {isCloudMode ? (
            <div className="providerCard cloudPlaceholderCard">
              <div className="providerHeader">
                <h4>{productLabel} Cloud</h4>
                <span>{currentUser ? "Signed in" : "Guest session"}</span>
              </div>
              <div className="settingsActions">
                {currentUser ? <button onClick={() => void login()}><KeyRound size={16} /> Refresh User</button> : null}
                {!currentUser ? <button onClick={() => startProviderLogin("google")}><KeyRound size={16} /> Войти через Google</button> : null}
                {!currentUser ? <button onClick={() => startProviderLogin("yandex")}><KeyRound size={16} /> Войти через Яндекс</button> : null}
                {currentUser ? <button onClick={() => void logout()}><Lock size={16} /> Logout</button> : null}
                {capabilities.supportsCredits ? <button onClick={() => { setCreditHistoryOpen((value) => !value); void loadCreditTransactions(25); }}><Clock3 size={16} /> Credit history</button> : null}
              </div>
              <div className="providerStatus">
                <span>{currentUser ? `User: ${currentUserLabel}` : "Sign in to save routes and keep generated results."}</span>
                <span>Balance: {creditBalance ? `${formatCredits(creditBalance.balance)} credits` : "unknown"}</span>
                {capabilities.supportsCredits && currentUser ? <CreditTransactionMiniList transactions={creditTransactions.slice(0, 5)} /> : null}
                {showDeveloperDiagnostics ? <span>User ID: {currentUser?.id ?? "none"}</span> : null}
                {showDeveloperDiagnostics ? <span>Guest demo: {capabilities.supportsGuestDemo ? "available" : "disabled"}</span> : null}
                {showDeveloperDiagnostics ? <span>Save: {capabilities.authRequiredForSave && !currentUser ? "login required" : "available"}</span> : null}
                {showDeveloperDiagnostics ? <span>Local filesystem: {capabilities.supportsLocalFilesystem ? "available" : "hidden"}</span> : null}
                {showDeveloperDiagnostics ? <span>Public sharing: {capabilities.supportsPublicSharing ? "available" : "not wired"}</span> : null}
              </div>
              {creditHistoryOpen && currentUser ? <CreditHistoryPanel transactions={creditTransactions} onRefresh={() => void loadCreditTransactions(25)} /> : null}
            </div>
          ) : null}
          <div className="providerCard">
            <div className="providerHeader">
              <h4>Appearance</h4>
              <span>Canvas background</span>
            </div>
            <label className="settingsField">
              <span>Canvas Background</span>
              <select value={canvasBackgroundTheme} onChange={(event) => setCanvasBackgroundTheme(event.target.value as CanvasBackgroundTheme)}>
                {availableCanvasThemes.map((theme) => (
                  <option key={theme.id} value={theme.id}>{theme.label}</option>
                ))}
              </select>
              <small className="settingsHint">{canvasThemeConfig.description}</small>
            </label>
          </div>
          {supportsLocalFilesystem ? <div className="providerCard">
            <div className="providerHeader">
              <h4>App Update</h4>
              <span>Pull the latest version from GitHub</span>
            </div>
            <div className={`settingsStatus ${systemUpdateStatus?.dirty ? "" : "configured"}`}>
              <RefreshCw size={14} />
              {systemUpdateStatus?.error
                ? `Update status unavailable: ${systemUpdateStatus.error}`
                : `${systemUpdateStatus?.branch ?? "unknown branch"} @ ${systemUpdateStatus?.commit ?? "unknown commit"}`}
            </div>
            <div className="providerStatus">
              <span>Remote: {systemUpdateStatus?.remote ?? "not configured"}</span>
              <span>Upstream: {systemUpdateStatus?.upstream ?? "current branch on origin"}</span>
              <span>{systemUpdateComparisonText(systemUpdateStatus)}</span>
              <span>Local changes: {systemUpdateStatus?.dirty ? `${systemUpdateStatus.changes?.length ?? 0} pending` : "clean"}</span>
            </div>
            <div className="settingsActions">
              <a className="githubLink settingsActionLink" href="https://github.com/Snark-s/snarkroute" target="_blank" rel="noreferrer" title="Open SnarkRoute on GitHub">
                <Github size={16} /> GitHub
              </a>
              <button
                onClick={() => void updateAppFromGitHub()}
                disabled={systemUpdating || !apiConnected || Boolean(systemUpdateStatus?.dirty) || Boolean(systemUpdateStatus?.error) || !systemUpdateStatus?.remote}
              >
                <RefreshCw size={16} /> {systemUpdating ? "Updating..." : "Update from GitHub"}
              </button>
              <button onClick={() => void loadSystemUpdateStatus()} disabled={systemUpdating || !apiConnected}><Globe size={16} /> Check Status</button>
            </div>
            {systemUpdateStatus?.dirty ? <small className="nodeWarning">Update is disabled because these are uncommitted local files. It will not reset or overwrite them.</small> : null}
            <small className="settingsHint">Uses a fast-forward-only git pull. Restart BoojumRoute after a successful update.</small>
          </div> : null}
          {capabilities.supportsUserApiKeys ? (
          <>
          <h3>AI Providers</h3>
          <div className="providerCard">
            <div className="providerHeader">
              <h4>Polza.ai</h4>
              <span>Text and image models through Polza.ai</span>
            </div>
            <div className={`settingsStatus ${polzaConfigured ? "configured" : ""}`}>
              <KeyRound size={14} />
              Polza.ai: {polzaConfigured ? `key configured (${polzaMaskedKey || "********"})` : "not configured"}
            </div>
            <p className="providerSupportNote">
              Want to make Snark happy?<br />
              If you plan to use Polza.ai, you can sign up through Snark&apos;s referral link:{" "}
              <a href="https://polza.ai/?referral=TnNw99j1MP" target="_blank" rel="noreferrer noopener">https://polza.ai/?referral=TnNw99j1MP</a>
              <br />
              It costs you nothing extra and helps support the project.
            </p>
            <div className="settingsLinks">
              <a className="settingsLink" href={providerLinks.polza?.apiKeysUrl ?? "https://polza.ai/dashboard"} target="_blank" rel="noreferrer">Get API Key</a>
              <a className="settingsLink" href={providerLinks.polza?.modelsUrl ?? "https://polza.ai/models"} target="_blank" rel="noreferrer">Browse Models</a>
              <a className="settingsLink" href={providerLinks.polza?.docsUrl ?? "https://polza.ai/docs"} target="_blank" rel="noreferrer">Docs</a>
              <a className="settingsLink" href={providerLinks.polza?.pricingUrl ?? "https://polza.ai/models"} target="_blank" rel="noreferrer">Pricing</a>
            </div>
            <label className="settingsField">
              <span>POLZA_AI_API_KEY</span>
              <input
                id="polza-api-key-input"
                type="password"
                value={polzaToken}
                placeholder={polzaConfigured ? "***************" : "Paste key"}
                onChange={(event) => setPolzaToken(event.target.value)}
                autoComplete="off"
              />
            </label>
            <div className="settingsActions">
              <button onClick={() => void savePolzaToken()}><Save size={16} /> Save Key</button>
              <button onClick={() => void loadPolzaModels()}><Globe size={16} /> Refresh Models</button>
            </div>
            <div className="providerStatus">
              <span>Text models: {polzaTextModels.length}</span>
              <span>Image models: {polzaImageModels.length}</span>
              <span>Video models: {polzaVideoModels.length}</span>
            </div>
          </div>
          <div className="providerCard">
            <div className="providerHeader">
              <h4>OpenRouter</h4>
              <span>Primary Remote Provider: OpenRouter</span>
            </div>
            <p className="muted">OpenRouter lets BoojumRoute blocks use many remote AI models through one API key. Use this as the default setup. Direct provider keys are optional and hidden in Advanced settings.</p>
            <p className="muted">OpenRouter позволяет блокам BoojumRoute использовать множество удалённых AI-моделей через один API-ключ. Это основной рекомендуемый способ подключения. Прямые ключи провайдеров необязательны и находятся в Advanced.</p>
            <div className={`settingsStatus ${openRouterSettings.configured ? "configured" : ""}`}>
              <KeyRound size={14} />
              OpenRouter: {openRouterSettings.configured ? `key configured (${openRouterSettings.maskedApiKey ?? "********"})` : "not configured"}
            </div>
            <div className="settingsLinks">
              <a className="settingsLink" href={providerLinks.openrouter?.apiKeysUrl ?? "https://openrouter.ai/settings/keys"} target="_blank" rel="noreferrer">Get API Key</a>
              <a className="settingsLink" href={providerLinks.openrouter?.creditsUrl ?? "https://openrouter.ai/settings/credits"} target="_blank" rel="noreferrer">Add Credits</a>
              <a className="settingsLink" href={providerLinks.openrouter?.modelsUrl ?? "https://openrouter.ai/models"} target="_blank" rel="noreferrer">Browse Models</a>
              <a className="settingsLink" href={providerLinks.openrouter?.docsUrl ?? "https://openrouter.ai/docs/quickstart"} target="_blank" rel="noreferrer">Docs</a>
              <a className="settingsLink" href={providerLinks.openrouter?.pricingUrl ?? "https://openrouter.ai/pricing"} target="_blank" rel="noreferrer">Pricing</a>
            </div>
            <label className="settingsField">
              <span>OpenRouter API Key</span>
              <input id="openrouter-api-key-input" type="password" value={openRouterToken} placeholder={openRouterSettings.configured ? "***************" : "Paste key"} onChange={(event) => setOpenRouterToken(event.target.value)} autoComplete="off" />
            </label>
            <label className="settingsField">
              <span>Default Model</span>
              <select value={openRouterDefaultModel} onChange={(event) => setOpenRouterDefaultModel(event.target.value)}>
                <option value="text.default">Auto (default text model)</option>
                {openRouterModels.filter((model) => modelSupportsText(model)).map((model) => (
                  <option key={model.id} value={model.id}>{model.name ? `${model.name} (${model.id})` : model.id}</option>
                ))}
                {openRouterDefaultModel && openRouterDefaultModel !== "text.default" && !openRouterModels.some((model) => model.id === openRouterDefaultModel) ? (
                  <option value={openRouterDefaultModel}>{openRouterDefaultModel}</option>
                ) : null}
              </select>
              <small className="settingsHint">Auto uses BoojumRoute's default Text AI mapping. Today that maps to OpenRouter when available.</small>
            </label>
            <label className="settingsField">
              <span>Budget Warning USD</span>
              <input inputMode="decimal" value={openRouterBudgetWarningUsd} placeholder="optional" onChange={(event) => setOpenRouterBudgetWarningUsd(event.target.value)} />
            </label>
            <div className="settingsActions">
              <button onClick={() => void saveOpenRouterSettings()}><Save size={16} /> Save</button>
              <button onClick={() => void testOpenRouterConnection()}><KeyRound size={16} /> Test Connection</button>
              <button onClick={() => void refreshOpenRouterCatalog()}><Globe size={16} /> Refresh Model Catalog</button>
            </div>
            <div className="providerStatus">
              <span>Status: {openRouterSettings.configured ? "Key configured; use Test connection to verify network access" : "Not configured"}</span>
              <span>Catalog last refreshed: {openRouterSettings.catalog?.refreshedAt ?? "never"}</span>
              <span>Cached models: {openRouterSettings.catalog?.modelCount ?? openRouterModels.length}</span>
              <span>Default model status: {openRouterSettings.defaultModelStatus ?? "unknown"}</span>
            </div>
            <small className="nodeWarning">Do not commit API keys to git.</small>
          </div>
          <h3>Advanced / Direct Secrets</h3>
          <h4>Replicate</h4>
          <div className={`settingsStatus ${replicateConfigured ? "configured" : ""}`}>
            <KeyRound size={14} />
            {replicateTokenStatusText(replicateConfigured)}
          </div>
          <div className="settingsLinks">
            <a className="settingsLink" href={providerLinks.replicate?.apiKeysUrl ?? "https://replicate.com/account/api-tokens"} target="_blank" rel="noreferrer">Get Replicate token</a>
            <a className="settingsLink" href={providerLinks.replicate?.docsUrl ?? "https://replicate.com/docs/topics/security/api-tokens"} target="_blank" rel="noreferrer">Token docs</a>
            <a className="settingsLink" href={providerLinks.replicate?.apiReferenceUrl ?? "https://replicate.com/docs/reference/http"} target="_blank" rel="noreferrer">API reference</a>
          </div>
          <label className="settingsField">
            <span>REPLICATE_API_TOKEN</span>
            <input
              id="replicate-api-token-input"
              type="password"
              value={replicateToken}
              placeholder="Paste token"
              onChange={(event) => setReplicateToken(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button onClick={() => void saveReplicateToken()}><Save size={16} /> Save Token</button>
          <h4>Gemini</h4>
          <div className={`settingsStatus ${geminiConfigured ? "configured" : ""}`}>
            <KeyRound size={14} />
            {geminiTokenStatusText(geminiConfigured)}
          </div>
          <div className="settingsLinks">
            <a className="settingsLink" href={providerLinks.gemini?.apiKeysUrl ?? GEMINI_API_KEY_URL} target="_blank" rel="noreferrer">Get Gemini API key</a>
            <a className="settingsLink" href={providerLinks.gemini?.docsUrl ?? "https://ai.google.dev/gemini-api/docs/api-key"} target="_blank" rel="noreferrer">API key docs</a>
            <a className="settingsLink" href={providerLinks.gemini?.modelsUrl ?? "https://ai.google.dev/gemini-api/docs/models"} target="_blank" rel="noreferrer">Gemini models</a>
          </div>
          <label className="settingsField">
            <span>GEMINI_API_KEY</span>
            <input
              id="gemini-api-key-input"
              type="password"
              value={geminiToken}
              placeholder="Paste key"
              onChange={(event) => setGeminiToken(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button onClick={() => void saveGeminiToken()}><Save size={16} /> Save Key</button>
          <h4>OpenAI</h4>
          <div className={`settingsStatus ${openAiConfigured ? "configured" : ""}`}>
            <KeyRound size={14} />
            OpenAI: {openAiConfigured ? `key configured (${openAiMaskedKey || "********"})` : "not configured"}
          </div>
          <div className="settingsLinks">
            <a className="settingsLink" href={providerLinks.openai?.apiKeysUrl ?? "https://platform.openai.com/api-keys"} target="_blank" rel="noreferrer">Get OpenAI API key</a>
            <a className="settingsLink" href={providerLinks.openai?.docsUrl ?? "https://platform.openai.com/docs"} target="_blank" rel="noreferrer">Docs</a>
            <a className="settingsLink" href={providerLinks.openai?.apiReferenceUrl ?? "https://platform.openai.com/docs/api-reference"} target="_blank" rel="noreferrer">API reference</a>
            <a className="settingsLink" href={providerLinks.openai?.pricingUrl ?? "https://openai.com/api/pricing/"} target="_blank" rel="noreferrer">Pricing</a>
          </div>
          <label className="settingsField">
            <span>OPENAI_API_KEY</span>
            <input
              id="openai-api-key-input"
              type="password"
              value={openAiToken}
              placeholder={openAiConfigured ? "***************" : "Paste key"}
              onChange={(event) => setOpenAiToken(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button onClick={() => void saveOpenAiToken()}><Save size={16} /> Save Key</button>
          <h4>World Labs</h4>
          <div className={`settingsStatus ${worldLabsConfigured ? "configured" : ""}`}>
            <KeyRound size={14} />
            World Labs: {worldLabsConfigured ? `key configured (${worldLabsMaskedKey || "********"})` : "not configured"}
          </div>
          <div className="settingsLinks">
            <a className="settingsLink" href={providerLinks.worldlabs?.apiKeysUrl ?? "https://worldlabs.ai"} target="_blank" rel="noreferrer">World Labs</a>
          </div>
          <label className="settingsField">
            <span>WORLDS_API_KEY</span>
            <input
              id="worldlabs-api-key-input"
              type="password"
              value={worldLabsToken}
              placeholder={worldLabsConfigured ? "***************" : "Paste key"}
              onChange={(event) => setWorldLabsToken(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button onClick={() => void saveWorldLabsToken()}><Save size={16} /> Save Key</button>
          <h4>Seedance</h4>
          <div className={`settingsStatus ${seedanceConfigured ? "configured" : ""}`}>
            <KeyRound size={14} />
            Seedance: {seedanceConfigured ? `configured (${seedanceMaskedKey || "********"})` : (seedanceSettings.statusText ?? "not configured")}
          </div>
          <div className="settingsLinks">
            <a className="settingsLink" href={providerLinks.seedance?.byteplusApiKeysUrl ?? "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey"} target="_blank" rel="noreferrer">BytePlus key</a>
            <a className="settingsLink" href={providerLinks.seedance?.byteplusProductUrl ?? "https://www.byteplus.com/product/modelark"} target="_blank" rel="noreferrer">ModelArk</a>
            <a className="settingsLink" href={providerLinks.seedance?.volcengineApiKeysUrl ?? "https://www.volcengine.com/docs/6492/1799875"} target="_blank" rel="noreferrer">Volcengine key docs</a>
            <a className="settingsLink" href={providerLinks.seedance?.volcengineDocsUrl ?? "https://www.volcengine.com/docs/6492/2165104"} target="_blank" rel="noreferrer">LAS Seedance docs</a>
          </div>
          <label className="settingsField">
            <span>Provider backend</span>
            <select value={seedanceBackend} onChange={(event) => setSeedanceBackend(event.target.value)}>
              <option value="">Select backend</option>
              <option value="byteplus-modelark">BytePlus ModelArk</option>
              <option value="volcengine-las">Volcengine LAS</option>
              <option value="seedance-compatible">Custom Seedance-compatible endpoint</option>
            </select>
          </label>
          <div className={`settingsDetails ${seedanceConfigured ? "configured" : ""}`}>
            <span>Backend: {seedanceSettings.backendLabel ?? "Not selected"}</span>
            <span>Base URL: {seedanceSettings.baseUrlSource === "default" ? `${seedanceSettings.baseUrl} (default)` : seedanceSettings.baseUrlSource === "custom" ? `${seedanceSettings.baseUrl} (custom)` : "missing"}</span>
          </div>
          <label className="settingsField">
            <span>{seedanceSettings.apiKeyEnvKey ?? "SEEDANCE_API_KEY"}</span>
            <input
              id="seedance-api-key-input"
              type="password"
              value={seedanceToken}
              placeholder={seedanceMaskedKey || (seedanceConfigured ? "***************" : "Paste key")}
              onChange={(event) => setSeedanceToken(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="settingsField">
            <span>Advanced: Custom API Base URL</span>
            <input
              value={seedanceBaseUrl}
              placeholder="Required if using a custom Seedance-compatible endpoint"
              onChange={(event) => setSeedanceBaseUrl(event.target.value)}
            />
            <small>Required if using a custom Seedance-compatible endpoint</small>
          </label>
          <div className="settingsActions">
            <button onClick={() => void saveSeedanceToken()}><Save size={16} /> Save Settings</button>
            <button onClick={() => void testSeedanceConfiguration()}><RefreshCw size={16} /> Check Config</button>
          </div>
          <p className="muted">Official Seedance access uses ByteDance cloud products: BytePlus ModelArk for international access, or Volcengine LAS for China-region access. Third-party aggregators are not official API key sources.</p>
          </>
          ) : showDeveloperDiagnostics ? (
            <div className="providerCard">
              <div className="providerHeader">
                <h4>Provider Keys</h4>
                <span>Cloud account storage is not wired yet</span>
              </div>
              <p className="muted">Cloud dev mode hides local `.env` key entry. Provider credentials will move behind login and account-scoped storage when that capability is implemented.</p>
            </div>
          ) : null}
          {settingsMessage ? <p className={settingsMessage.includes("error") || settingsMessage.includes("Failed") || settingsMessage.includes("empty") ? "errorText" : "muted"}>{settingsMessage}</p> : null}
        </div>

        {supportsLocalFilesystem ? <div className="settingsPanel nodePackagePanel">
          <h3>Block / Tool Packages</h3>
          <label className="settingsField">
            <span>Install local .snarknode folder or block manifest path</span>
            <input value={nodePackagePath} placeholder="Y:\\path\\my-node.snarknode" onChange={(event) => setNodePackagePath(event.target.value)} />
          </label>
          <button onClick={() => void installNodeFromPath()}><FolderOpen size={16} /> Install Local Path</button>
          <label className="settingsField">
            <span>Add block from URL</span>
            <input value={nodeUrl} placeholder="https://example.com/node.snarknode" onChange={(event) => setNodeUrl(event.target.value)} />
          </label>
          <button onClick={() => void installNodeFromUrl()}><Plus size={16} /> Add Block URL</button>
          <label className="settingsField">
            <span>Add block library</span>
            <input value={libraryUrl} placeholder="https://example.com/library.json" onChange={(event) => setLibraryUrl(event.target.value)} />
          </label>
          <button onClick={() => void previewLibraryFromUrl()}><BookOpen size={16} /> Preview Library</button>
          {libraryPreview ? (
            <div className="nodeLibraryPreview">
              <div className="nodeLibraryHeader">
                <div>
                  <strong>{libraryPreview.title}</strong>
                  <span>{libraryPreview.author.name} · {libraryPreview.version}</span>
                </div>
                <span className="nodeLibraryCount">{librarySelectedCount}/{libraryPreview.nodes.length}</span>
              </div>
              <div className="nodeLibraryActions">
                <button className="nodeSmallButton" onClick={() => selectLibraryPreviewNodes(true)}><CheckSquare size={14} /> All</button>
                <button className="nodeSmallButton" onClick={() => selectLibraryPreviewNodes(false)}><X size={14} /> None</button>
                <select value={libraryInstallStatus} onChange={(event) => setLibraryInstallStatus(event.target.value as LibraryNodeStatus)} title="Status for installed library blocks">
                  {libraryNodeStatuses.map((status) => <option key={status.id} value={status.id}>{status.label}</option>)}
                </select>
              </div>
              <div className="nodeLibraryPreviewList">
                {libraryPreview.nodes.map((node) => (
                  <label key={node.id}>
                    <input type="checkbox" checked={Boolean(selectedLibraryNodeIds[node.id])} onChange={(event) => setSelectedLibraryNodeIds((current) => ({ ...current, [node.id]: event.target.checked }))} />
                    <span>
                      <strong>{node.title}</strong>
                      <small>{node.id}{node.version ? ` · ${node.version}` : ""}{node.status ? ` · ${node.status}` : ""}</small>
                    </span>
                  </label>
                ))}
              </div>
              <button onClick={() => void installSelectedLibraryNodes()} disabled={librarySelectedCount === 0}><Plus size={16} /> Install Selected</button>
            </div>
          ) : null}
          <h4>Manage Installed Blocks</h4>
          <div className="nodeLibraryToolbar">
            <label className="nodeLibrarySearch">
              <Search size={14} />
              <input value={librarySearch} placeholder="Search installed blocks" onChange={(event) => setLibrarySearch(event.target.value)} />
            </label>
            <select value={librarySortMode} onChange={(event) => setLibrarySortMode(event.target.value as LibrarySortMode)} title="Sort installed blocks">
              <option value="status">Status order</option>
              <option value="manual">Manual order</option>
              <option value="title">Title</option>
            </select>
          </div>
          <div className="nodeStatusFilters">
            <button className={libraryStatusFilter === "all" ? "active" : ""} onClick={() => setLibraryStatusFilter("all")}>All <span>{installedNodes.length}</span></button>
            {libraryNodeStatuses.map((status) => (
              <button key={status.id} className={libraryStatusFilter === status.id ? "active" : ""} onClick={() => setLibraryStatusFilter(status.id)}>
                {status.label} <span>{libraryStatusCounts[status.id]}</span>
              </button>
            ))}
          </div>
          <div className="installedNodeList">
            {installedNodes.length === 0 ? <p className="muted">No installed blocks yet.</p> : visibleInstalledNodes.length === 0 ? <p className="muted">No blocks match this library view.</p> : visibleInstalledNodes.map(({ node, status }) => (
              <div className="installedNodeItem" key={node.id}>
                <div className="installedNodeHeader">
                  <strong>{node.title}</strong>
                  <span className={`nodeStatusBadge ${status}`}>{libraryNodeStatusLabel(status)}</span>
                </div>
                <span>{node.id}</span>
                <span>{node.author.name} · {node.version} · {node.origin}</span>
                <span>{node.source ?? "local install"}</span>
                <span>executor: {node.executor.type}{node.executor.runtime ? `/${node.executor.runtime}` : ""} · executable: {node.executor.type === "plugin" ? "yes" : "no"}</span>
                <span>permissions: {permissionsSummary(node)}</span>
                <div className="installedNodeControls">
                  <select value={status} onChange={(event) => setLibraryNodeStatus(node.id, event.target.value as LibraryNodeStatus)} title="Library status">
                    {libraryNodeStatuses.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                  <button className="nodeSmallButton iconOnly" title="Move up" onClick={() => moveInstalledNode(node.id, -1)}><ArrowUp size={14} /></button>
                  <button className="nodeSmallButton iconOnly" title="Move down" onClick={() => moveInstalledNode(node.id, 1)}><ArrowDown size={14} /></button>
                  <button className="nodeSmallButton" onClick={() => void setInstalledNodeState(node.id, node.enabled === false)}> {node.enabled === false ? "Enable" : "Disable"} </button>
                  <button className="nodeSmallButton" onClick={() => void viewInstalledNodeReadme(node.id)}>README</button>
                  {canUninstallNodePackage(node) ? (
                    <button className="nodeSmallButton danger" onClick={() => void uninstallNode(node.id)}>Uninstall</button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div> : null}

        {showDeveloperDiagnostics ? (
        <>
        <h2>Inspector</h2>
        <p className="selectionHint">{selectedNodeCount} block(s), {selectedEdgeCount} edge(s) selected</p>
        {selectedNode ? (
          <>
            <p className="muted">{selectedNode.id}</p>
            <textarea value={paramsText} onChange={(event) => setParamsText(event.target.value)} />
            {paramsError ? <p className="errorText">{paramsError}</p> : null}
            <button onClick={saveParams}>Save Params</button>
          </>
        ) : (
          <p className="muted">Select a block.</p>
        )}
        </>
        ) : null}

        <h2>Economics</h2>
        <EconomicsPanel route={flowToRoute(nodes, edges, routeBase)} runResult={runResult} ledgerSummary={ledgerSummary} runCostEstimate={runCostEstimate} creditBalance={creditBalance} creditTransactions={creditTransactions} showDeveloperDiagnostics={showDeveloperDiagnostics} isCloudMode={isCloudMode} currentUser={currentUser} />
        </>
        ) : null}
      </aside>

      {showDeveloperDiagnostics ? <section className="bottom">
        <div className="bottomHeader">
          <button className="iconButton" title={bottomCollapsed ? "Expand bottom panel" : "Collapse bottom panel"} onClick={() => setBottomCollapsed((value) => !value)}>
            {bottomCollapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
          </button>
          <span>Developer diagnostics</span>
        </div>
        {!bottomCollapsed ? (
        <>
        <div>
          <h2>Logs</h2>
          <pre>{formatLogs(runResult, logs)}</pre>
        </div>
        <div>
          <h2>Outputs</h2>
          <pre>{outputs ? formatOutputs(outputs) : "No outputs yet."}</pre>
        </div>
        </>
        ) : null}
      </section> : null}

      {imageViewer ? (
        <div className="imageViewerOverlay" role="dialog" aria-modal="true" aria-label="Image preview" onClick={() => setImageViewer(null)}>
          <div className="imageViewerWindow" onClick={(event) => event.stopPropagation()}>
            <div className="imageViewerHeader">
              <span title={imageViewer.title}>{truncateText(imageViewer.title, 96)}</span>
              <div className="imageViewerActions">
                <button
                  className="imageViewerButton"
                  type="button"
                  title="Download image"
                  onClick={() => downloadImageSrc(imageViewer.src, imageViewer.filename)}
                >
                  <Download size={15} />
                </button>
                <button className="imageViewerButton" type="button" title="Close" onClick={() => setImageViewer(null)}>
                  <X size={15} />
                </button>
              </div>
            </div>
            <img className="imageViewerImage" src={imageViewer.src} alt={imageViewer.title} />
          </div>
        </div>
      ) : null}
      {promptAssetDraft ? (
        <div className="promptAssetOverlay" role="dialog" aria-modal="true" aria-label="Save as Prompt Asset" onClick={() => setPromptAssetDraft(null)}>
          <div className="promptAssetWindow" onClick={(event) => event.stopPropagation()}>
            <div className="promptAssetHeader">
              <span>Save as Prompt Asset</span>
              <button className="imageViewerButton" type="button" title="Close" onClick={() => setPromptAssetDraft(null)}><X size={16} /></button>
            </div>
            <div className="promptAssetBody">
              <div className="promptAssetPreview">
                <img src={promptAssetDraft.imageSrc} alt="" />
                <small>{promptAssetDraft.sourceRouteId} / {promptAssetDraft.sourceNodeId}</small>
              </div>
              <div className="promptAssetForm">
                <label className="settingsField"><span>title</span><input value={promptAssetDraft.title} onChange={(event) => setPromptAssetDraft({ ...promptAssetDraft, title: event.target.value, slug: slugFromText(event.target.value) })} /></label>
                <label className="settingsField"><span>slug / id</span><input value={promptAssetDraft.slug} onChange={(event) => setPromptAssetDraft({ ...promptAssetDraft, slug: slugFromText(event.target.value) })} /></label>
                <label className="settingsField">
                  <span>category mode</span>
                  <select
                    value={promptAssetDraft.categoryMode}
                    onChange={(event) => {
                      const mode = event.target.value === "custom" ? "custom" : "existing";
                      const fallbackCategory = promptLibrary.categories[0]?.id ?? "image-generation";
                      setPromptAssetDraft({ ...promptAssetDraft, categoryMode: mode, category: mode === "existing" ? fallbackCategory : promptAssetDraft.category });
                    }}
                  >
                    <option value="existing">Choose existing category</option>
                    <option value="custom">Create custom category</option>
                  </select>
                </label>
                {promptAssetDraft.categoryMode === "existing" ? (
                  <label className="settingsField">
                    <span>category</span>
                    <select value={promptAssetDraft.category} onChange={(event) => setPromptAssetDraft({ ...promptAssetDraft, category: event.target.value })}>
                      {promptLibrary.categories.map((category) => (
                        <option key={category.id} value={category.id}>{category.title}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="settingsField">
                    <span>new category</span>
                    <input value={promptAssetDraft.category} onChange={(event) => setPromptAssetDraft({ ...promptAssetDraft, category: slugFromText(event.target.value) || "image-generation" })} />
                  </label>
                )}
                <label className="settingsField"><span>description</span><input value={promptAssetDraft.description} onChange={(event) => setPromptAssetDraft({ ...promptAssetDraft, description: event.target.value })} /></label>
                <label className="settingsField"><span>tags</span><input value={promptAssetDraft.tagsText} onChange={(event) => setPromptAssetDraft({ ...promptAssetDraft, tagsText: event.target.value })} /></label>
                <label className="settingsField"><span>model hints</span><input value={promptAssetDraft.modelHintsText} onChange={(event) => setPromptAssetDraft({ ...promptAssetDraft, modelHintsText: event.target.value })} /></label>
                <label className="settingsField"><span>prompt body</span><textarea value={promptAssetDraft.prompt} onChange={(event) => setPromptAssetDraft({ ...promptAssetDraft, prompt: event.target.value })} /></label>
                <label className="settingsField"><span>negative prompt</span><textarea value={promptAssetDraft.negativePrompt} onChange={(event) => setPromptAssetDraft({ ...promptAssetDraft, negativePrompt: event.target.value })} /></label>
                <div className="promptAssetSource">
                  <span>status: candidate</span>
                  <span>runId: {promptAssetDraft.sourceRunId || "unknown"}</span>
                  <span>routeId: {promptAssetDraft.sourceRouteId}</span>
                  <span>nodeId: {promptAssetDraft.sourceNodeId}</span>
                  <span>outputId: {promptAssetDraft.sourceOutputId || "image"}</span>
                </div>
                {promptAssetError ? <p className="errorText">{promptAssetError}</p> : null}
              </div>
            </div>
            <div className="promptAssetFooter">
              <span className={promptAssetError ? "promptAssetFooterError" : "promptAssetFooterStatus"}>
                {promptAssetError || (promptAssetSaving ? "Saving..." : "")}
              </span>
              <button type="button" disabled={promptAssetSaving} onClick={() => setPromptAssetDraft(null)}>Cancel</button>
              <button className="primary" type="button" disabled={promptAssetSaving || !promptAssetDraft.prompt.trim()} onClick={() => void savePromptAsset()}><Save size={16} /> {promptAssetSaving ? "Saving..." : "Save"}</button>
            </div>
          </div>
        </div>
      ) : null}
      {activeDoc ? (
        <div className="docsViewerOverlay" role="dialog" aria-modal="true" aria-label={activeDoc.title} onClick={() => setActiveDoc(null)}>
          <div className="docsViewerWindow" onClick={(event) => event.stopPropagation()}>
            <div className="docsViewerHeader">
              <div>
                <span>{activeDoc.title}</span>
                <small>{studioDocKindLabel(activeDoc.kind)} · {activeDoc.language.toUpperCase()}</small>
              </div>
              <button className="imageViewerButton" type="button" title="Close" onClick={() => setActiveDoc(null)}>
                <X size={15} />
              </button>
            </div>
            <MarkdownDocument content={activeDoc.content} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RootApp() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  if (path === "/admin") return <AdminDashboard />;
  if (path === "/admin/login") return <AdminLoginPage />;
  if (path === "/login") return <LoginPage />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><RootApp /></React.StrictMode>);

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function formatJsonish(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function formatLogs(runResult: RunDisplayResult | null, fallbackLogs: string[]): string {
  const header = runResult?.runId
    ? [`runId: ${runResult.runId}`, `status: ${runResult.status ?? "unknown"}`, `startedAt: ${runResult.startedAt ?? ""}`, `completedAt: ${runResult.completedAt ?? ""}`, ""]
    : [];
  const runLogs = runResult?.logs?.map((entry) => `${entry.timestamp ?? ""}${entry.nodeId ? ` [${entry.nodeId}]` : ""} ${entry.message}`) ?? fallbackLogs;
  return [...header, ...runLogs].join("\n");
}

function formatOutputs(outputs: unknown): string {
  const cost = runCostLabel(outputs);
  const body = JSON.stringify(outputs, null, 2);
  return cost ? `${cost}\n\n${body}` : body;
}

function outputString(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const direct = (value as Record<string, unknown>)[key];
  if (typeof direct === "string") return direct.trim();
  const metadata = (value as Record<string, unknown>).metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const nested = (metadata as Record<string, unknown>)[key];
    if (typeof nested === "string") return nested.trim();
  }
  return "";
}

function outputText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
}

function numberParamValue(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.replace(",", ".")) : fallback;
  return Number.isFinite(number) ? number : fallback;
}

function recordParam(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function worldRecordFromResponse(value: unknown): Record<string, unknown> {
  const record = recordParam(value);
  const response = recordParam(record.response);
  if (response.world_id || response.worldId || response.world_marble_url || response.worldMarbleUrl || worldPanoramaUrl(response) || worldSplatAssetUrl(response)) return withWorldPanoramaAlias(response);
  const world = recordParam(record.world);
  if (world.world_id || world.worldId || world.world_marble_url || world.worldMarbleUrl || world.id || worldPanoramaUrl(world) || worldSplatAssetUrl(world)) {
    return withWorldPanoramaAlias({ ...world, worldId: world.world_id ?? world.worldId ?? world.id });
  }
  if (record.world_id || record.worldId || record.world_marble_url || record.worldMarbleUrl || worldPanoramaUrl(record) || worldSplatAssetUrl(record)) return withWorldPanoramaAlias(record);
  return {};
}

function worldPanoramaUrl(world: Record<string, unknown>): string | undefined {
  const assets = recordParam(world.assets);
  const imagery = recordParam(assets.imagery);
  return stringFromRecord(world, "panoUrl")
    ?? stringFromRecord(world, "pano_url")
    ?? stringFromRecord(imagery, "pano_url")
    ?? stringFromRecord(imagery, "panoUrl");
}

function worldSplatAssetUrl(world: Record<string, unknown>): string | undefined {
  const assets = recordParam(world.assets);
  const splats = recordParam(assets.splats);
  const spzUrls = recordParam(splats.spz_urls ?? splats.spzUrls);
  return stringFromRecord(world, "splatUrl")
    ?? stringFromRecord(world, "splat_url")
    ?? stringFromRecord(splats, "spz_url")
    ?? stringFromRecord(splats, "spzUrl")
    ?? stringFromRecord(splats, "sog_url")
    ?? stringFromRecord(splats, "sogUrl")
    ?? firstStringFromRecord(spzUrls, ["full", "full_res", "fullResolution", "500k", "500K", "medium", "100k", "100K", "low"]);
}

function withWorldPanoramaAlias(world: Record<string, unknown>): Record<string, unknown> {
  const panoUrl = worldPanoramaUrl(world);
  return panoUrl ? { ...world, panoUrl, pano_url: panoUrl } : world;
}

function cameraPoseRecord(params: Record<string, unknown>): { position?: Record<string, unknown>; rotation?: Record<string, unknown>; fov?: unknown } {
  const pose = recordParam(params.cameraPose);
  return {
    position: recordParam(pose.position),
    rotation: recordParam(pose.rotation),
    fov: pose.fov
  };
}

function resolutionFromParam(resolution: unknown, output: unknown): { width: number; height: number } {
  const outputRecord = recordParam(output);
  const text = String(resolution ?? "");
  const match = text.match(/^(\d+)x(\d+)$/i);
  const width = match ? Number(match[1]) : numberParamValue(outputRecord.width, 1536);
  const height = match ? Number(match[2]) : numberParamValue(outputRecord.height, 864);
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

function systemUpdateComparisonText(status: SystemUpdateStatus | null): string {
  if (!status || status.error) return "Git comparison: unavailable";
  if (status.ahead == null || status.behind == null) return "Git comparison: no upstream comparison";
  if (status.ahead > 0 && status.behind > 0) return `Git comparison: ${status.ahead} ahead, ${status.behind} behind`;
  if (status.ahead > 0) return `Git comparison: ${status.ahead} ahead of GitHub`;
  if (status.behind > 0) return `Git comparison: ${status.behind} behind GitHub`;
  return "Git comparison: matches GitHub";
}

function downloadFilename(value: unknown, fallback = "snarkroute-image.png"): string {
  const label = imageLabel(value).split(/[\\/]/).pop() ?? fallback;
  return label || fallback;
}

function filenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function providerHintForNode(node: RouteDoc["nodes"][number] | undefined): string {
  if (!node) return "";
  if (node.type.startsWith("gemini.")) return "gemini";
  if (node.type.startsWith("local.stableDiffusion.") || node.type === "ai.image.sd15.qr_monster_hidden_control") return "stable-diffusion";
  if (node.type.startsWith("replicate.")) return "replicate";
  return "";
}

function slugFromText(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || `prompt-${Date.now()}`;
}

function splitCsv(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function filterPromptLibraryByStatus(library: PromptLibraryData, filter: PromptStatusFilter): PromptLibraryData {
  if (filter === "all") return library;
  return {
    ...library,
    categories: library.categories
      .map((category) => ({
        ...category,
        prompts: category.prompts.filter((prompt) => (prompt.status ?? "published") === filter)
      }))
      .filter((category) => category.prompts.length > 0)
  };
}

function promptPreviewSrc(prompt: PromptLibraryPrompt): string {
  const previewImage = prompt.previewImage ?? "";
  if (/^https?:\/\//i.test(previewImage)) return previewImage;
  const promptPath = prompt.path ?? "";
  const separatorIndex = Math.max(promptPath.lastIndexOf("/"), promptPath.lastIndexOf("\\"));
  const directory = separatorIndex >= 0 ? promptPath.slice(0, separatorIndex + 1) : "";
  return `${apiBase}/api/assets/preview?path=${encodeURIComponent(`${directory}${previewImage}`)}`;
}

function hasRequiredNodeOnlyInputs(node: RouteDoc["nodes"][number], incomingEdges: Edge[]): boolean {
  if (node.type === "replicate.clarity-upscaler") {
    return Boolean(node.params?.image) || incomingEdges.some((edge) => !edge.targetHandle || edge.targetHandle === "image");
  }
  if (node.type === "preview.image" || node.type === "preview.panorama360") {
    return Boolean(node.params?.image) || incomingEdges.some((edge) => !edge.targetHandle || edge.targetHandle === "image");
  }
  return true;
}

function costLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const output = value as Record<string, unknown>;
  const cost = output.cost;
  const record = cost && typeof cost === "object" ? (cost as Record<string, unknown>) : null;
  const metrics = output.metrics && typeof output.metrics === "object" ? (output.metrics as Record<string, unknown>) : null;
  const seconds = Number(record?.seconds ?? metrics?.predict_time ?? metrics?.total_time);
  const estimatedUsdFromCost = Number(record?.estimatedUsd ?? record?.amountUsd);
  const estimatedUsd = Number.isFinite(estimatedUsdFromCost) ? estimatedUsdFromCost : Number.isFinite(seconds) ? seconds * 0.0014 : NaN;
  if (!Number.isFinite(estimatedUsd)) return null;
  const parts = [`Estimated provider cost: $${estimatedUsd.toFixed(4)}`];
  if (Number.isFinite(seconds)) parts.push(`${seconds.toFixed(2)}s`);
  return parts.join(" В· ");
}

function runCostLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nodeResults = record.nodeResults;
  if (!nodeResults || typeof nodeResults !== "object") return null;
  const labels = Object.entries(nodeResults as Record<string, unknown>)
    .map(([nodeId, result]) => {
      if (!result || typeof result !== "object") return null;
      const output = (result as Record<string, unknown>).output;
      const label = costLabel(output);
      return label ? `${nodeId}: ${label}` : null;
    })
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join("\n") : null;
}

async function importLocalAsset(file: File, kind: AssetKind): Promise<string> {
  const dataBase64 = await fileToBase64(file);
  const response = await fetch(`${apiBase}/api/assets/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, dataBase64, kind })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Local import failed.");
  if (!result.path) throw new Error("Local import did not return a path.");
  return result.path;
}

function isImageFile(file: File): boolean {
  return ["image/png", "image/jpeg", "image/webp"].includes(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
}

function imageFileFromClipboard(event: ClipboardEvent): File | null {
  const items = Array.from(event.clipboardData?.items ?? []);
  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    return file.name ? file : new File([file], `clipboard-image.${extensionForMimeType(file.type)}`, { type: file.type });
  }

  const files = Array.from(event.clipboardData?.files ?? []);
  const file = files.find((candidate) => candidate.type.startsWith("image/"));
  if (!file) return null;
  return file.name ? file : new File([file], `clipboard-image.${extensionForMimeType(file.type)}`, { type: file.type });
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      resolve(text.includes(",") ? text.split(",")[1] : text);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

async function imageUrlToPngBase64(src: string): Promise<string> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Could not read preview image (${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create image conversion canvas.");
  context.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not convert preview image to PNG.")), "image/png");
  });
  return fileToBase64(new File([blob], "prompt-asset.png", { type: "image/png" }));
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}

