import type { DialogueContentPart } from "@snarkroute/protocol";

export type CompoundPortMapping = {
  id: string;
  label?: string;
  kind?: string;
  nodeId: string;
  port?: string;
  targets?: Array<{ nodeId: string; port?: string }>;
};

export type CompoundInterface = {
  title?: string;
  inputs?: CompoundPortMapping[];
  outputs?: CompoundPortMapping[];
};

export type SubrouteFrame = {
  compoundId: string;
  parentRoute: RouteDoc;
  interfacePositions?: {
    input?: { x: number; y: number };
    output?: { x: number; y: number };
  };
};

export type RouteDoc = {
  routeVersion: string;
  route: { id: string; title: string; description?: string; author: Record<string, unknown>; tags?: string[] };
  economics?: Record<string, unknown>;
  nodes: Array<{
    id: string;
    type: string;
    title?: string;
    params?: Record<string, unknown>;
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
    compound?: CompoundInterface;
    subroute?: RouteDoc;
    nodePackage?: Record<string, unknown>;
    ui?: Record<string, unknown>;
  }>;
  edges: Array<{ id?: string; from: string; to: string; fromPort?: string; toPort?: string }>;
  provenance?: Record<string, unknown>;
};

export type ExampleCategory = "Basic Image" | "AI Image" | "Local AI" | "Developer";

export type StudioExample = {
  route: RouteDoc;
  title: string;
  description: string;
  provider: "Replicate" | "Gemini" | "Local" | "HTTP";
  category: ExampleCategory;
  milestone?: string;
};

export type NodeRunResult = {
  status?: string;
  output?: unknown;
  error?: string;
  logs?: string[];
  costEstimate?: CostEstimate;
  actualUsage?: ActualUsage;
  actualCredits?: number;
  actualProviderCostAmount?: number | null;
  actualProviderCostCurrency?: string | null;
  usageSource?: "provider" | "estimated" | "unknown";
  startedAt?: string;
  completedAt?: string;
};

export type ActualUsage = {
  inputTokens?: number;
  outputTokens?: number;
  imageCount?: number;
  videoSeconds?: number;
  requestCount?: number;
};

export type CostEstimate = {
  nodeId: string;
  nodeType: string;
  estimatedCredits: number;
  estimatedProviderCostAmount: number | null;
  providerCostCurrency: string | null;
  usageUnits: ActualUsage;
  provider?: string;
  model?: string;
  operation?: string;
  free?: boolean;
  baseCostMicrousd?: number;
  baseCredits?: number;
  globalMarkupPercent?: number;
  globalMarkupCredits?: number;
  nodeMarkupPercent?: number;
  nodeMarkupCredits?: number;
  markupCredits?: number;
  finalCredits?: number;
  maxChargeCredits?: number;
  pricingSource?: string;
  pricingConfidence?: string;
  pricingSnapshotId?: string;
  parameterRules?: Record<string, unknown>;
  canonicalModelId?: string;
  providerNativeModelId?: string;
  fetchedAt?: string;
  staleAfter?: string;
  fallback?: boolean;
  pricingBreakdown?: PricingBreakdown;
  usageSource: "provider" | "estimated" | "unknown" | "catalog_estimate";
};

export type PricingBreakdown = {
  nodeId: string;
  title?: string;
  nodeType?: string;
  provider?: string;
  operation?: string;
  model?: string;
  free?: boolean;
  providerCostMicrousd?: number;
  baseCostMicrousd?: number;
  baseCredits?: number;
  globalMarkupPercent?: number;
  globalMarkupCredits?: number;
  nodeMarkupPercent?: number;
  nodeMarkupCredits?: number;
  markupCredits?: number;
  finalCredits?: number;
  maxChargeCredits?: number;
  pricingSource?: string;
  pricingConfidence?: string;
  pricingSnapshotId?: string;
  parameterRules?: Record<string, unknown>;
  canonicalModelId?: string;
  providerNativeModelId?: string;
  fetchedAt?: string;
  staleAfter?: string;
  fallback?: boolean;
  source?: string;
  notes?: string;
};

export type RunCostSummary = {
  estimates: CostEstimate[];
  actuals: Array<CostEstimate & { actualCredits: number; actualProviderCostAmount: number | null }>;
  totalEstimatedCredits: number;
  totalActualCredits: number;
  refundedCredits: number;
  nodes?: PricingBreakdown[];
};

export type CreditTransaction = {
  id: string;
  createdAt: string;
  type: "grant" | "reserve" | "capture" | "release" | "refund" | "adjustment" | "demo_grant" | "expired" | "purchase_placeholder" | string;
  amount: number;
  status?: string;
  balanceAfter?: number | null;
  reason?: string | null;
  runId?: string | null;
  nodeTitle?: string | null;
  provider?: string | null;
  maxChargeCredits?: number | null;
};

export type RunDisplayResult = {
  runId?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  nodeResults?: Record<string, NodeRunResult>;
  logs?: Array<{ timestamp?: string; nodeId?: string; message: string }>;
  economics?: unknown;
  costSummary?: RunCostSummary;
  error?: string;
};

export type FixNodeOutputOptions = {
  persist?: boolean;
  logMessage?: string;
};

export type RunStreamEvent =
  | { type: "runStarted"; runId?: string; startedAt?: string; estimate?: RunCostSummary }
  | { type: "nodeResult"; nodeResult?: NodeRunResult & { nodeId?: string } }
  | { type: "runCompleted"; result?: RunDisplayResult }
  | { type: "runFailed"; error?: string };

export type LedgerSummary = {
  totalRuns: number;
  runsByProvider: Record<string, number>;
  runsByStatus: Record<string, number>;
  estimatedProviderCostTotal: number | null;
  actualProviderCostTotal: number | null;
  paymentExecuted: false;
  paymentExecutedCount: number;
  recentRuns: Array<Record<string, unknown>>;
};

export type AssetKind = "file" | "image" | "video";

export type PromptLibraryPrompt = {
  id: string;
  title: string;
  category?: string;
  description?: string;
  tags?: string[];
  kind?: string;
  status?: string;
  previewImage?: string;
  source?: Record<string, unknown>;
  modelHints?: string[];
  ref?: string;
  path?: string;
  text: string;
};

export type PromptLibraryCategory = {
  id: string;
  title: string;
  prompts: PromptLibraryPrompt[];
};

export type PromptLibraryData = {
  categories: PromptLibraryCategory[];
  diagnostics?: Array<{ path: string; message: string; severity: "warning" | "error" }>;
};

export type PromptStatusFilter = "published" | "approved" | "candidate" | "draft" | "archived" | "all";

export type StableDiffusionModel = {
  title: string;
  modelName?: string;
  filename?: string;
  hash?: string;
};

export type ProviderLinks = Record<string, Record<string, string>>;

export type AppCapabilities = {
  product: "boojum" | "snark";
  mode: "local" | "cloud" | "self_hosted";
  authRequiredForSave: boolean;
  supportsCredits: boolean;
  supportsGuestDemo: boolean;
  supportsUserApiKeys: boolean;
  supportsBrowserVault: boolean;
  supportsCloudStoredUserKeys: boolean;
  supportsLocalFilesystem: boolean;
  supportsPublicSharing: boolean;
  supportsDeveloperDiagnostics: boolean;
  cloudStorageConfigured: boolean;
  cloudAuthReady: boolean;
};

export type CurrentUser = {
  id: string;
  displayName?: string;
  email?: string;
  authProvider?: string;
  role?: "user" | "admin";
};

export type AdminOverview = {
  storageMode?: "cloud-postgres" | "local-dev";
  storageConfigured?: boolean;
  usersCount: number;
  runsCount?: number;
  nodeRunsCount?: number;
  creditTransactionsCount?: number;
  providerUsageCount?: number;
  runs: Array<Record<string, unknown>>;
  nodeRuns: Array<Record<string, unknown>>;
  creditTransactions: Array<Record<string, unknown>>;
  providerUsage: Array<Record<string, unknown>>;
  recentErrors: Array<Record<string, unknown>>;
  artifactStats: unknown;
  guestDemoUsage: unknown;
  providerKeyStatus: Record<string, boolean>;
};

export type AdminBillingUser = {
  id: string;
  role: "user" | "admin";
  createdAt: string;
  authProviders: string[];
  providerSubjectHashPrefix?: string | null;
  currentBalance: number;
  totalGranted: number;
  totalCaptured: number;
  totalReleased: number;
  totalRefunded: number;
  activeReserved: number;
  runsCount: number;
  lastActivityAt?: string | null;
};

export type AdminUserCard = AdminBillingUser & {
  providerUsageCount: number;
  recentRuns: Array<Record<string, unknown>>;
  recentCreditTransactions: Array<Record<string, unknown>>;
  recentProviderUsage: Array<Record<string, unknown>>;
};

export type OpenRouterModel = {
  id: string;
  provider?: "openrouter";
  kind?: "text" | "image" | "video";
  name?: string;
  title?: string;
  providerId?: string;
  capabilities?: string[];
  inputTypes?: string[];
  outputTypes?: string[];
  pricing?: Record<string, unknown>;
  pricingHint?: string;
  metadata?: Record<string, unknown>;
  defaultParameters?: Record<string, unknown>;
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
  supported_durations?: string[];
  supported_aspect_ratios?: string[];
  supported_resolutions?: string[];
  supported_frame_image_modes?: string[];
};

export type PolzaModel = {
  id: string;
  name?: string;
  title?: string;
  providerId?: string;
  capabilities?: string[];
  iconPath?: string;
  catalogModelId?: string;
  catalogProviderModelId?: string;
  catalogParameters?: ModelParameterDefinition[];
  inputTypes?: string[];
  outputTypes?: string[];
  type?: string;
  short_description?: string;
  supported_parameters?: string[];
  generationParameters?: Array<{ id?: string; label?: string; type?: string; options?: Array<{ value?: string; label?: string }> }>;
  maxImageInputs?: number;
  pricing?: Record<string, unknown>;
  pricingHint?: string;
  metadata?: Record<string, unknown>;
  defaultParameters?: Record<string, unknown>;
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
};

export type PricingQuote = {
  logicalModel?: string;
  provider: string;
  providerModel: string;
  capability: string;
  estimatedCost: number | null;
  currency: string | null;
  pricingSource: string;
  confidence: string;
  pricingStatus?: "fresh" | "stale" | "unknown" | string;
  pricingUpdatedAt?: string | null;
  pricingExpiresAt?: string | null;
  unit?: string;
  breakdown?: Record<string, unknown>;
  warnings?: string[];
};

export type ModelQuotePreview = {
  selected: PricingQuote;
  alternatives: PricingQuote[];
  warnings: string[];
};

export type ImageModelOption = {
  id: string;
  slug: string;
  label: string;
  provider: string;
  executionProvider?: string;
  capabilities: string[];
  iconPath?: string;
  parameters?: ModelParameterDefinition[];
  catalogModelId?: string;
  catalogProviderModelId?: string;
  aspectRatios?: string[];
  imageSizes?: string[];
  supportsImageGeneration: "supported" | "unsupported" | "unknown";
  routeSupport: {
    openrouter: "supported" | "unsupported" | "unknown";
    direct: "supported" | "unsupported" | "unknown";
  };
  disabled?: boolean;
  note?: string;
  pricing?: Record<string, unknown>;
};

export type ModelParameterDefinition = {
  id: string;
  label?: string;
  type: "select" | "number" | "text" | "boolean";
  default?: string | number | boolean;
  options?: Array<{ value: string; label?: string }>;
  min?: number;
  max?: number;
  step?: number;
};

export type UnifiedModelInfo = {
  id: string;
  provider: string;
  providerModelId: string;
  displayName: string;
  outputType: string;
  inputTypes: string[];
  iconKey: string;
  iconPath: string;
  parameters: ModelParameterDefinition[];
  catalogStatus: "known" | "unknown";
  capabilities?: string[];
  aliases?: string[];
  metadata?: Record<string, unknown>;
};

export type ModelOptionForNodeV1 = {
  id: string;
  provider: string;
  providerModelId: string;
  originVendor?: string;
  displayName: string;
  iconKey: string;
  iconPath: string;
  inputTypes: string[];
  outputTypes: string[];
  capabilities: string[];
  roles: string[];
  availability?: Record<string, unknown>;
  parameters: ModelParameterDefinition[];
  catalogStatus: "known" | "unknown";
  nodeType: string;
  storedModelId: string;
  executionProvider: string;
  compatibilityReason?: string;
  metadata?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
};

export type VideoModelOption = {
  id: string;
  name?: string;
  providerId: "polza" | "openrouter";
  providerLabel: string;
  pricing?: Record<string, unknown>;
  short_description?: string;
  supported_parameters?: string[];
  generationParameters?: PolzaModel["generationParameters"];
  architecture?: PolzaModel["architecture"];
};

export type OpenRouterSettings = {
  configured: boolean;
  maskedApiKey?: string;
  defaultModel?: string;
  budgetWarningUsd?: number | null;
  catalog?: { refreshedAt?: string | null; modelCount?: number; sourceCounts?: { models?: number; videoModels?: number } };
  defaultModelStatus?: string;
};

export type SeedanceSettings = {
  configured: boolean;
  backend?: string;
  backendLabel?: string;
  maskedApiKey?: string;
  apiKeyEnvKey?: string;
  hasApiKey?: boolean;
  baseUrl?: string;
  baseUrlSource?: string;
  diagnostics?: string[];
  statusText?: string;
};

export type SystemUpdateStatus = {
  ok: boolean;
  repoRoot?: string;
  branch?: string | null;
  commit?: string | null;
  remote?: string | null;
  upstream?: string | null;
  ahead?: number | null;
  behind?: number | null;
  dirty?: boolean;
  changes?: string[];
  error?: string;
};

export type NodeManifest = {
  kind?: "snarkroute.node";
  schemaVersion?: string;
  id: string;
  title: string;
  version: string;
  author: { name: string };
  origin: string;
  source?: string;
  license: string;
  category?: string;
  description?: string;
  tags?: string[];
  permissions: { network: boolean; networkHosts?: string[]; readFiles: boolean; writeOutputs: boolean; shell: boolean; env: string[] };
  executor: { type: string; runtime?: string; entry?: string; builtinRunner?: string };
  inputs: Array<{ id: string; type: string; label?: string; required?: boolean }>;
  outputs: Array<{ id: string; type: string; label?: string; required?: boolean }>;
  params?: Array<{ id: string; type: string; label?: string; description?: string; default?: unknown; options?: Array<{ value: unknown; label?: string }>; min?: number; max?: number; step?: number; binding?: { nodeId: string; paramId: string }; poseManaged?: boolean }>;
  canvasAction?: {
    enabled: boolean;
    surface?: "livingCanvas" | "brandeshmyg";
    title?: string;
    description?: string;
    icon?: { kind: "preset"; name: string } | { kind: "custom"; svg?: string; dataUrl?: string };
    poseBindings?: Partial<Record<"yaw" | "pitch" | "roll" | "fov" | "positionX" | "positionY" | "positionZ" | "cameraPose", string>>;
    dialog?: {
      enabled: boolean;
      params: string[];
      preview?: Array<{ kind: "image" | "video" | "audio" | "panorama360" | "splat"; source: "input" | { output: string } | { pause: string } }>;
    };
  };
  tool?: unknown;
  generatedWith?: unknown;
  ui?: {
    params?: Record<string, {
      control?: string;
      options?: Array<string | { value: string; label?: string }>;
      multiline?: boolean;
      advanced?: boolean;
      size?: "compact" | "large";
      layout?: "inline";
      placeholder?: string;
      helperText?: string;
      min?: number;
      max?: number;
      step?: number;
    }>;
  };
  enabled?: boolean;
};

export type NodeCatalogItem = {
  type: string;
  title: string;
  description?: string;
  enabled?: boolean;
  manifest?: NodeManifest;
  params?: Record<string, unknown>;
};

export type NodeLibraryPreview = {
  kind: "snarkroute.nodeLibrary";
  id: string;
  title: string;
  version: string;
  author: { name: string };
  license: string;
  nodes: Array<{ id: string; title: string; url: string; version?: string; description?: string; status?: string }>;
};

export type LibraryNodeStatus = "draft" | "candidate" | "approved" | "published" | "archived";

export type LibraryStatusFilter = LibraryNodeStatus | "all";

export type LibraryNodeMetadata = Record<string, { status?: LibraryNodeStatus; order?: number }>;

export type LibrarySortMode = "status" | "manual" | "title";

export type NodeLibraryGroup = {
  id: string;
  title: string;
  types: string[];
};

export type NodeLibraryLayout = {
  groups: NodeLibraryGroup[];
  hiddenTypes: string[];
};

export type SavedCameraPose = {
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number; roll: number };
  fov: number;
};

export type SplatRuntime = {
  renderer: import("three").WebGLRenderer;
  scene: import("three").Scene;
  camera: import("three").PerspectiveCamera;
  control: import("three").Object3D;
};

export type PendingTextSelection = {
  target: HTMLInputElement | HTMLTextAreaElement;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: "forward" | "backward" | "none" | null;
};

export type PortKind = "text" | "image" | "video" | "file" | "json" | "data" | "conversation_context";

export type ImageViewerState = {
  src: string;
  title: string;
  filename: string;
  mode?: "preview" | "correction";
};

export type PromptAssetDraft = {
  title: string;
  slug: string;
  category: string;
  categoryMode: "existing" | "custom";
  description: string;
  tagsText: string;
  prompt: string;
  negativePrompt: string;
  modelHintsText: string;
  sourceNodeId: string;
  sourceRouteId: string;
  sourceRunId: string;
  sourceOutputId: string;
  imageSrc: string;
  imagePath: string;
  generalize: boolean;
};

export type PendingConnectionStart = {
  nodeId: string;
  handleId: string;
  handleType: "source" | "target";
};

export type ConnectionNodeMenuState = {
  clientX: number;
  clientY: number;
  flowPosition: { x: number; y: number };
  sourceNodeId: string;
  sourceHandle: string;
};

export type ConnectionNodeEntry =
  | { kind: "output"; inputPort: PortSpec }
  | { kind: "catalog"; item: NodeCatalogItem; inputPort: PortSpec };

export type ContextMenuState = {
  clientX: number;
  clientY: number;
  nodeId?: string;
};

export type LibraryItemMenuState = {
  clientX: number;
  clientY: number;
  type: string;
  sectionId: string;
  sectionTitle: string;
  sectionTypes: string[];
};

export type LibrarySectionMenuState = {
  clientX: number;
  clientY: number;
  sectionId: string;
  sectionTitle: string;
  sectionTypes: string[];
};

export type PromptAssetMenuState = {
  clientX: number;
  clientY: number;
  nodeId: string;
  result: NodeRunResult;
};

export type PromptLibraryMenuState = {
  clientX: number;
  clientY: number;
  prompt: PromptLibraryPrompt;
};

export type PortSpec = {
  id: string;
  kind: PortKind;
  label?: string;
  maxConnections?: number;
};

export type DialogueConnectedInput = {
  id: string;
  type: PortKind;
  sourceNodeId: string;
  sourcePort?: string;
  preview: string;
  value: unknown;
  chipBackgroundAssetRef?: string;
  sourceAccentColor?: string;
};

export type DialogueDraftContentPart = DialogueContentPart & { sourceAccentColor?: string };
