export type ModelLogo = {
  id: string;
  label: string;
  src: string;
};

type LogoDefinition = {
  label: string;
  filename: string;
};

const logoDefinitions = {
  alibaba: { label: "Alibaba", filename: "alibaba.svg" },
  anthropic: { label: "Anthropic", filename: "claude.png" },
  blackForestLabs: { label: "Black Forest Labs", filename: "flux-2-pro.png" },
  bytedance: { label: "ByteDance", filename: "seedream-4-5.png" },
  cohere: { label: "Cohere", filename: "cohere.svg" },
  comfyui: { label: "ComfyUI", filename: "comfyui.svg" },
  deepseek: { label: "DeepSeek", filename: "deepseek.png" },
  elevenlabs: { label: "ElevenLabs", filename: "elevenlabs.svg" },
  gemini: { label: "Gemini", filename: "gemini.png" },
  google: { label: "Google", filename: "gemini.png" },
  huggingface: { label: "Hugging Face", filename: "huggingface.svg" },
  heygen: { label: "HeyGen", filename: "heygen.svg" },
  kling: { label: "Kling", filename: "kling.png" },
  leonardo: { label: "Leonardo", filename: "leonardo.svg" },
  local: { label: "Local", filename: "local.svg" },
  luma: { label: "Luma", filename: "luma.svg" },
  meta: { label: "Meta", filename: "llama.png" },
  midjourney: { label: "Midjourney", filename: "midjourney.svg" },
  minimax: { label: "MiniMax", filename: "hailuo.png" },
  mistral: { label: "Mistral", filename: "mistral.svg" },
  nanoBanana: { label: "Nano Banana", filename: "nano-banana.svg" },
  nvidia: { label: "NVIDIA", filename: "nvidia.svg" },
  ollama: { label: "Ollama", filename: "ollama.svg" },
  openai: { label: "OpenAI", filename: "gpt.png" },
  openrouter: { label: "OpenRouter", filename: "openrouter.svg" },
  perplexity: { label: "Perplexity", filename: "perplexity.svg" },
  pika: { label: "Pika", filename: "pika.png" },
  polza: { label: "Polza", filename: "polza.svg" },
  qwen: { label: "Qwen", filename: "qwen.png" },
  replicate: { label: "Replicate", filename: "replicate.svg" },
  runway: { label: "Runway", filename: "runway.png" },
  seedream: { label: "Seedream", filename: "seedream-4-5.png" },
  sora: { label: "Sora", filename: "sora.png" },
  stability: { label: "Stability AI", filename: "stability.svg" },
  suno: { label: "Suno", filename: "suno.svg" },
  tencent: { label: "Tencent", filename: "tencent.svg" },
  topaz: { label: "Topaz Labs", filename: "topaz.svg" },
  veo: { label: "Veo", filename: "veo.png" },
  wan: { label: "Wan", filename: "wan.svg" },
  xai: { label: "xAI", filename: "grok-image.png" },
  yandex: { label: "Yandex", filename: "yandexart.png" },
  zai: { label: "Z-Image", filename: "z-image.png" },
  unknown: { label: "Model provider", filename: "unknown.svg" }
} satisfies Record<string, LogoDefinition>;

export type ModelLogoKey = keyof typeof logoDefinitions;

export const modelLogoRegistry: Array<{ family: string; logo: ModelLogoKey; pattern: RegExp }> = [
  { family: "Alibaba", logo: "alibaba", pattern: /alibaba|happyhorse/i },
  { family: "Anthropic Claude", logo: "anthropic", pattern: /anthropic|claude/i },
  { family: "Nano Banana", logo: "nanoBanana", pattern: /nano[-_\s]?banana|gemini-(?:\d|\w|[-.])*image/i },
  { family: "Google Veo", logo: "veo", pattern: /\bveo\b/i },
  { family: "Google Gemini", logo: "gemini", pattern: /gemini|google/i },
  { family: "OpenAI Sora", logo: "sora", pattern: /\bsora\b/i },
  { family: "OpenAI GPT / DALL-E", logo: "openai", pattern: /gpt|dall-?e|openai/i },
  { family: "Black Forest Labs Flux", logo: "blackForestLabs", pattern: /black-forest-labs|flux/i },
  { family: "ByteDance Seedance", logo: "bytedance", pattern: /bytedance|seedance|byteplus|volcengine/i },
  { family: "ByteDance Seedream", logo: "seedream", pattern: /seedream/i },
  { family: "Cohere Command", logo: "cohere", pattern: /cohere|command-r/i },
  { family: "ComfyUI", logo: "comfyui", pattern: /comfy/i },
  { family: "DeepSeek", logo: "deepseek", pattern: /deepseek/i },
  { family: "ElevenLabs", logo: "elevenlabs", pattern: /elevenlabs|eleven/i },
  { family: "Hugging Face", logo: "huggingface", pattern: /huggingface|hugging-face|hf\//i },
  { family: "HeyGen", logo: "heygen", pattern: /heygen|avatar-iv/i },
  { family: "Kling", logo: "kling", pattern: /kling|kwaivgi/i },
  { family: "Leonardo", logo: "leonardo", pattern: /leonardo/i },
  { family: "Llama / Meta", logo: "meta", pattern: /llama|meta/i },
  { family: "Luma Ray", logo: "luma", pattern: /luma|ray/i },
  { family: "Midjourney", logo: "midjourney", pattern: /midjourney/i },
  { family: "MiniMax / Hailuo", logo: "minimax", pattern: /minimax|hailuo/i },
  { family: "Mistral / Pixtral", logo: "mistral", pattern: /mistral|mixtral|pixtral/i },
  { family: "NVIDIA Nemotron", logo: "nvidia", pattern: /nvidia|nemotron/i },
  { family: "Ollama", logo: "ollama", pattern: /ollama/i },
  { family: "Perplexity Sonar", logo: "perplexity", pattern: /perplexity|sonar/i },
  { family: "Pika", logo: "pika", pattern: /\bpika\b/i },
  { family: "Runway Gen", logo: "runway", pattern: /runway|gen-?3|gen-?4/i },
  { family: "Stability AI", logo: "stability", pattern: /stable-diffusion|stability/i },
  { family: "Suno", logo: "suno", pattern: /suno/i },
  { family: "Tencent", logo: "tencent", pattern: /tencent|hy-mt2/i },
  { family: "Z.ai / Z-Image", logo: "zai", pattern: /z-?image|tongyi-mai|zai|z\.ai/i },
  { family: "Qwen", logo: "qwen", pattern: /qwen|tongyi-mai/i },
  { family: "Topaz", logo: "topaz", pattern: /topaz/i },
  { family: "Wan", logo: "wan", pattern: /^wan(?:\s|\/)|\swan\//i },
  { family: "Yandex", logo: "yandex", pattern: /yandex/i },
  { family: "xAI Grok", logo: "xai", pattern: /grok|x-ai|xai/i }
];

const providerAliases: Array<[RegExp, ModelLogoKey]> = [
  [/openrouter/i, "openrouter"],
  [/polza/i, "polza"],
  [/replicate/i, "replicate"],
  [/local/i, "local"]
];

export type CatalogLogoOption = {
  providerId?: string;
  id?: string;
  providerModelId?: string;
  storedModelId?: string;
  title?: string;
  iconPath?: string;
  iconKey?: string;
  originVendor?: string;
};

export function createModelIconResolver(apiBase: string) {
  const normalizedApiBase = apiBase.replace(/\/$/, "");
  const modelIcon = (filename: string) => `${normalizedApiBase}/api/model-icons/${encodeURIComponent(filename)}`;
  const logoForKey = (key: ModelLogoKey): ModelLogo => {
    const logo = logoDefinitions[key];
    return { id: key, label: logo.label, src: modelIcon(logo.filename) };
  };
  const unknown = logoForKey("unknown");

  function modelLogoFor(providerId: string | undefined, modelId: string | undefined, profileId = ""): ModelLogo {
    const provider = (providerId ?? "").trim().toLowerCase();
    const model = modelId ?? "";
    const upstream = model.includes("/") ? model.split("/")[0] ?? "" : "";
    const modelText = `${upstream} ${model} ${profileId}`;
    for (const entry of modelLogoRegistry) {
      if (entry.pattern.test(modelText)) return logoForKey(entry.logo);
    }
    for (const [pattern, key] of providerAliases) {
      if (pattern.test(provider)) return logoForKey(key);
    }
    return unknown;
  }

  function modelLogoForCatalogOption(option: CatalogLogoOption): ModelLogo {
    const identityPath = modelIdentityIconPath(option);
    const iconPath = resolvedIconPath(option.iconPath, option.providerId);
    if (iconPath) return { id: "catalog", label: option.title || "Model", src: iconPath };
    const iconKeyIsProvider = sameIconKey(option.iconKey, option.providerId);
    const fallbackPath = (!iconKeyIsProvider ? iconPathForKey(option.iconKey) : undefined)
      ?? iconPathForKey(option.originVendor)
      ?? identityPath;
    if (fallbackPath) return { id: "catalog", label: option.title || "Model", src: fallbackPath };
    return { id: "unknown", label: option.title || unknown.label, src: unknown.src };
  }

  function resolvedIconPath(value: string | undefined, providerId?: string): string | undefined {
    const path = value?.trim();
    if (!path) return undefined;
    if (/^(?:https?:|data:|blob:)/i.test(path)) return path;
    if (path.startsWith("/api/model-icons/")) {
      const filename = decodeURIComponent(path.slice("/api/model-icons/".length));
      if (filename === filenameForProvider(providerId)) return undefined;
      return knownModelIconFilenames.has(filename) ? `${normalizedApiBase}${path}` : undefined;
    }
    if (path.startsWith("/")) return `${normalizedApiBase}${path}`;
    return `${normalizedApiBase}/${path}`;
  }

  function iconPathForKey(value: string | undefined): string | undefined {
    if (!value?.trim()) return undefined;
    for (const key of iconKeyCandidates(value)) {
      const filename = iconFilenamesByKey[key];
      if (filename) return modelIcon(filename);
    }
    return undefined;
  }

  function modelIdentityIconPath(option: { id?: string; providerModelId?: string; storedModelId?: string }): string | undefined {
    return iconPathForKey(option.providerModelId)
      ?? iconPathForKey(option.storedModelId)
      ?? iconPathForKey(option.id);
  }

  function filenameForProvider(providerId: string | undefined): string | undefined {
    if (!providerId?.trim()) return undefined;
    return providerIconFilenamesByKey.get(normalizedIconKey(providerId));
  }

  return {
    modelLogoFor,
    modelLogoForCatalogOption,
    unknownModelLogoSrc: unknown.src
  };
}

function sameIconKey(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left?.trim() && right?.trim() && normalizedIconKey(left) === normalizedIconKey(right));
}

function normalizedIconKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function iconKeyCandidates(value: string): string[] {
  const normalized = normalizedIconKey(value);
  const upstream = normalized.split("/")[0];
  return upstream && upstream !== normalized ? [normalized, upstream] : [normalized];
}

const iconFilenamesByKey: Record<string, string> = {
  alibaba: "alibaba.svg",
  anthropic: "claude.png",
  "black-forest-labs": "flux-2-pro.png",
  "flux-2-pro": "flux-2-pro.png",
  bytedance: "seedream-4-5.png",
  claude: "claude.png",
  gemini: "gemini.png",
  google: "gemini.png",
  gpt: "gpt.png",
  deepseek: "deepseek.png",
  heygen: "heygen.svg",
  local: "local.svg",
  kling: "kling.png",
  kwaivgi: "kling.png",
  kuaishou: "kling.png",
  minimax: "hailuo.png",
  hailuo: "hailuo.png",
  "nano-banana": "nano-banana.svg",
  "image.nano-banana": "nano-banana.svg",
  "google/gemini-3.1-flash-image-preview": "nano-banana.svg",
  "google/gemini-3-pro-image-preview": "nano-banana.svg",
  openai: "gpt.png",
  openrouter: "openrouter.svg",
  perplexity: "perplexity.svg",
  polza: "polza.svg",
  qwen: "qwen.png",
  replicate: "replicate.svg",
  runway: "runway.png",
  rutronix: "unknown.svg",
  seedance: "seedream-4-5.png",
  seedream: "seedream-4-5.png",
  "seedream-4-5": "seedream-4-5.png",
  stability: "stability.svg",
  tencent: "tencent.svg",
  topaz: "topaz.svg",
  unknown: "unknown.svg",
  wan: "wan.svg",
  "x-ai": "grok-image.png",
  xai: "grok-image.png",
  grok: "grok-image.png",
  "z-ai": "z-image.png",
  zai: "z-image.png",
  "z-image": "z-image.png",
  "tongyi-mai": "z-image.png",
  yandex: "yandexart.png"
};

const providerIconFilenamesByKey = new Map([
  ["openrouter", "openrouter.svg"],
  ["polza", "polza.svg"],
  ["replicate", "replicate.svg"],
  ["rutronix", "unknown.svg"],
  ["local", "local.svg"]
]);

const knownModelIconFilenames = new Set(Object.values(logoDefinitions).map((logo) => logo.filename));
