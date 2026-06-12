export type ModelLogo = {
  label: string;
  src: string;
};

const apiBase = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:4317";
const modelIcon = (filename: string) => `${apiBase}/api/model-icons/${encodeURIComponent(filename)}`;
const unknownLogo = () => logos.unknown;

const logos = {
  anthropic: { label: "Anthropic", src: modelIcon("claude.png") },
  blackForestLabs: { label: "Black Forest Labs", src: modelIcon("flux-2-pro.png") },
  bytedance: { label: "ByteDance", src: modelIcon("seedream-4-5.png") },
  cohere: { label: "Cohere", src: modelIcon("cohere.svg") },
  comfyui: { label: "ComfyUI", src: modelIcon("comfyui.svg") },
  deepseek: { label: "DeepSeek", src: modelIcon("deepseek.png") },
  elevenlabs: { label: "ElevenLabs", src: modelIcon("elevenlabs.svg") },
  gemini: { label: "Gemini", src: modelIcon("gemini.png") },
  google: { label: "Google", src: modelIcon("gemini.png") },
  huggingface: { label: "Hugging Face", src: modelIcon("huggingface.svg") },
  kling: { label: "Kling", src: modelIcon("kling.png") },
  leonardo: { label: "Leonardo", src: modelIcon("leonardo.svg") },
  local: { label: "Local", src: modelIcon("local.svg") },
  luma: { label: "Luma", src: modelIcon("luma.svg") },
  meta: { label: "Meta", src: modelIcon("llama.png") },
  midjourney: { label: "Midjourney", src: modelIcon("midjourney.svg") },
  minimax: { label: "MiniMax", src: modelIcon("hailuo.png") },
  nanoBanana: { label: "Nano Banana", src: modelIcon("gemini.png") },
  mistral: { label: "Mistral", src: modelIcon("mistral.svg") },
  nvidia: { label: "NVIDIA", src: modelIcon("nvidia.svg") },
  ollama: { label: "Ollama", src: modelIcon("ollama.svg") },
  openai: { label: "OpenAI", src: modelIcon("gpt.png") },
  openrouter: { label: "OpenRouter", src: modelIcon("openrouter.svg") },
  perplexity: { label: "Perplexity", src: modelIcon("perplexity.svg") },
  pika: { label: "Pika", src: modelIcon("pika.png") },
  polza: { label: "Polza", src: modelIcon("polza.svg") },
  qwen: { label: "Qwen", src: modelIcon("qwen.png") },
  replicate: { label: "Replicate", src: modelIcon("replicate.svg") },
  runway: { label: "Runway", src: modelIcon("runway.png") },
  seedream: { label: "Seedream", src: modelIcon("seedream-4-5.png") },
  sora: { label: "Sora", src: modelIcon("sora.png") },
  stability: { label: "Stability AI", src: modelIcon("stability.svg") },
  suno: { label: "Suno", src: modelIcon("suno.svg") },
  topaz: { label: "Topaz Labs", src: modelIcon("topaz.svg") },
  veo: { label: "Veo", src: modelIcon("veo.png") },
  wan: { label: "Wan", src: modelIcon("wan.svg") },
  xai: { label: "xAI", src: modelIcon("grok-image.png") },
  zai: { label: "Z-Image", src: modelIcon("z-image.png") },
  yandex: { label: "Yandex", src: modelIcon("yandexart.png") },
  unknown: { label: "Model provider", src: modelIcon("unknown.svg") }
};

export const modelLogoRegistry: Array<{ family: string; logo: keyof typeof logos; pattern: RegExp }> = [
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
  { family: "Z.ai / Z-Image", logo: "zai", pattern: /z-?image|tongyi-mai|zai|z\.ai/i },
  { family: "Qwen", logo: "qwen", pattern: /qwen|tongyi-mai/i },
  { family: "Topaz", logo: "topaz", pattern: /topaz/i },
  { family: "Wan", logo: "wan", pattern: /^wan(?:\s|\/)|\swan\//i },
  { family: "Yandex", logo: "yandex", pattern: /yandex/i },
  { family: "xAI Grok", logo: "xai", pattern: /grok|x-ai|xai/i }
];

const providerAliases: Array<[RegExp, keyof typeof logos]> = [
  [/openrouter/i, "openrouter"],
  [/polza/i, "polza"],
  [/replicate/i, "replicate"],
  [/local/i, "local"]
];

export function modelLogoFor(providerId: string | undefined, modelId: string | undefined): ModelLogo {
  const model = modelId ?? "";
  const upstream = model.includes("/") ? model.split("/")[0] ?? "" : "";
  const modelText = `${upstream} ${model}`;
  for (const entry of modelLogoRegistry) {
    if (entry.pattern.test(modelText)) return logos[entry.logo];
  }
  const providerText = providerId ?? "";
  for (const [pattern, key] of providerAliases) {
    if (pattern.test(providerText)) return logos[key];
  }
  return logos.unknown;
}

export function modelLogoForCatalogOption(option: {
  providerId?: string;
  id?: string;
  title?: string;
  iconPath?: string;
}): ModelLogo {
  const iconPath = resolvedIconPath(option.iconPath);
  if (iconPath) return { label: option.title || "Model", src: iconPath };
  const fallback = modelLogoFor(option.providerId, undefined);
  return fallback.src ? fallback : unknownLogo();
}

function resolvedIconPath(value: string | undefined): string | undefined {
  const path = value?.trim();
  if (!path) return undefined;
  if (/^(?:https?:|data:|blob:)/i.test(path)) return path;
  if (path.startsWith("/")) return `${apiBase}${path}`;
  return `${apiBase}/${path}`;
}
