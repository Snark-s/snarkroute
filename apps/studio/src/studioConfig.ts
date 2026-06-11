import type {
  AppCapabilities,
  LibraryNodeStatus,
  PolzaModel,
  PromptLibraryData,
  PromptStatusFilter
} from "./studioTypes";

export const STUDIO_FAVICON_HREF = "/boojumroute-icon.png";
export const isProductionBuild = import.meta.env.PROD;

export const DEFAULT_APP_CAPABILITIES: AppCapabilities = {
  product: "boojum",
  mode: "local",
  authRequiredForSave: false,
  supportsCredits: false,
  supportsGuestDemo: true,
  supportsUserApiKeys: true,
  supportsBrowserVault: false,
  supportsCloudStoredUserKeys: false,
  supportsLocalFilesystem: true,
  supportsPublicSharing: false,
  supportsDeveloperDiagnostics: false
};

export const apiBase = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:4317";
export const NODE_DRAG_MIME = "application/x-snarkroute-node";
export const ROUTE_FILE_ACCEPT = ".orp,.opt,.orp.json,.opt.json,.orp.yaml,.opt.yaml,.orp.yml,.opt.yml,.route,.route.json,.route.yaml,.route.yml,.json,.yaml,.yml,application/json,application/yaml,text/yaml,text/x-yaml";
export const SAVED_PROJECT_STORAGE_KEY = "snarkroute-studio:saved-project";
export const LIBRARY_NODE_METADATA_STORAGE_KEY = "snarkroute-studio:node-library-metadata";
export const NODE_LIBRARY_LAYOUT_STORAGE_KEY = "snarkroute-studio:node-library-layout";
export const DEFAULT_ROUTE_FILENAME = "default-route.orp.json";
export const GEMINI_API_KEY_URL = "https://aistudio.google.com/app/apikey";

export const libraryNodeStatuses: Array<{ id: LibraryNodeStatus; label: string }> = [
  { id: "draft", label: "Draft" },
  { id: "candidate", label: "Candidate" },
  { id: "approved", label: "Approved" },
  { id: "published", label: "Published" },
  { id: "archived", label: "Archived" }
];

export const promptStatusOptions: PromptStatusFilter[] = ["all", "published", "approved", "candidate", "draft", "archived"];

export const GEMINI_LLM_DEFAULT_SYSTEM_PROMPT = `Convert the user's rough idea into a clean image-generation prompt.
Preserve the humor and core idea.
Make risky wording safe and non-erotic.
Do not include copyrighted characters, logos, or text.
Output only the final image prompt.`;

export const GEMINI_LLM_MODEL_OPTIONS = [
  { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.4, supportsVision: true },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", inputUsdPerMillionTokens: 0.3, outputUsdPerMillionTokens: 2.5, supportsVision: true },
  { value: "gemini-2.5-flash-preview-09-2025", label: "Gemini 2.5 Flash Preview", inputUsdPerMillionTokens: 0.3, outputUsdPerMillionTokens: 2.5, supportsVision: true },
  { value: "gemini-2.5-flash-lite-preview-09-2025", label: "Gemini 2.5 Flash-Lite Preview", inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.4, supportsVision: true }
];

export const DEFAULT_PROMPT_LIBRARY: PromptLibraryData = {
  categories: [
    {
      id: "image-generation",
      title: "Image generation",
      prompts: [
        {
          id: "adapt-user-idea-for-image-generator",
          title: "Adapt user idea for image generator",
          category: "image-generation",
          description: "Starter fallback prompt shown when the local prompt library API is unavailable.",
          ref: "image-generation/adapt-user-idea-for-image-generator",
          path: "data/prompt-library/image-generation/adapt-user-idea-for-image-generator.prompt.md",
          text: GEMINI_LLM_DEFAULT_SYSTEM_PROMPT
        }
      ]
    }
  ]
};

export const SUBROUTE_INPUT_NODE_ID = "__subroute_input__";
export const SUBROUTE_OUTPUT_NODE_ID = "__subroute_output__";

export const GEMINI_IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
export const GEMINI_IMAGE_SIZES = ["1K", "2K", "4K"];
export const OPENAI_IMAGE_ASPECT_RATIOS = ["1:1", "3:2", "2:3", "16:9", "9:16"];
export const OPENAI_IMAGE_QUALITIES = ["low", "medium", "high"];

export const POLZA_TEXT_MODEL_OPTIONS: PolzaModel[] = [
  { id: "openai/gpt-4o", name: "GPT-4o", type: "chat" },
  { id: "anthropic/claude-3-5-sonnet", name: "Claude 3.5 Sonnet", type: "chat" },
  { id: "google/gemini-2.5-pro-preview", name: "Gemini 2.5 Pro", type: "chat" },
  { id: "meta-llama/llama-3.3-70b", name: "Llama 3.3 70B", type: "chat" }
];

export const POLZA_IMAGE_MODEL_OPTIONS: PolzaModel[] = [
  { id: "openai/gpt-5.4-image-2", name: "GPT-5.4 Image 2", type: "image", short_description: "Supports aspect_ratio: auto, 1:1, 5:4, 9:16, 21:9, 16:9, 4:3, 3:2, 4:5, 3:4, 2:3" },
  { id: "openai/gpt-5-image-mini", name: "GPT-5 Image Mini", type: "image" },
  { id: "openai/gpt-image-1.5", name: "GPT Image 1.5", type: "image", short_description: "Supports aspect_ratio: 1:1, 2:3, 3:2" },
  { id: "gpt-image-1", name: "GPT Image 1", type: "image" },
  { id: "dall-e-3", name: "DALL-E 3", type: "image" },
  { id: "x-ai/grok-imagine-image", name: "Grok Imagine", type: "image" }
];

export const POLZA_VIDEO_MODEL_OPTIONS: PolzaModel[] = [
  { id: "google/veo3_fast", name: "Veo 3 Fast", type: "video", short_description: "Supports video generation with sound." },
  { id: "google/veo3", name: "Veo 3", type: "video", short_description: "Supports video generation with sound." },
  { id: "wan/2.6", name: "Wan 2.6", type: "video" },
  { id: "bytedance/seedance-2", name: "Seedance 2", type: "video" },
  { id: "bytedance/seedance-2-fast", name: "Seedance 2 Fast", type: "video" }
];

export const POLZA_IMAGE_ASPECT_RATIOS = ["auto", "1:1", "5:4", "4:5", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"];
export const POLZA_IMAGE_RESOLUTIONS = ["1K", "2K"];
export const POLZA_IMAGE_QUALITIES = ["auto", "low", "medium", "high"];
export const POLZA_IMAGE_FORMATS = ["png", "jpeg", "webp"];
export const POLZA_VIDEO_RESOLUTIONS = ["720p", "1080p"];
export const POLZA_VIDEO_DURATIONS = ["5", "10"];
