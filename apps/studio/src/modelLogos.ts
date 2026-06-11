export type ModelLogo = {
  id: string;
  label: string;
  src: string;
};

const apiBase = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:4317";
const modelIcon = (filename: string) => `${apiBase}/api/model-icons/${encodeURIComponent(filename)}`;

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
  mistral: { label: "Mistral", src: modelIcon("mistral.svg") },
  nanoBanana: { label: "Nano Banana", src: modelIcon("nano-banana.svg") },
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
  yandex: { label: "Yandex", src: modelIcon("yandexart.png") },
  zai: { label: "Z-Image", src: modelIcon("z-image.png") },
  unknown: { label: "Model provider", src: modelIcon("unknown.svg") }
};

type LogoKey = keyof typeof logos;

const modelLogoRegistry: Array<{ logo: LogoKey; pattern: RegExp }> = [
  { logo: "anthropic", pattern: /anthropic|claude/i },
  { logo: "nanoBanana", pattern: /nano[-_\s]?banana|gemini-(?:\d|\w|[-.])*image/i },
  { logo: "veo", pattern: /\bveo\b/i },
  { logo: "gemini", pattern: /gemini|google/i },
  { logo: "sora", pattern: /\bsora\b/i },
  { logo: "openai", pattern: /gpt|dall-?e|openai/i },
  { logo: "blackForestLabs", pattern: /black-forest-labs|flux/i },
  { logo: "bytedance", pattern: /bytedance|seedance|byteplus|volcengine/i },
  { logo: "seedream", pattern: /seedream/i },
  { logo: "cohere", pattern: /cohere|command-r/i },
  { logo: "comfyui", pattern: /comfy/i },
  { logo: "deepseek", pattern: /deepseek/i },
  { logo: "elevenlabs", pattern: /elevenlabs|eleven/i },
  { logo: "huggingface", pattern: /huggingface|hugging-face|hf\//i },
  { logo: "kling", pattern: /kling|kwaivgi/i },
  { logo: "leonardo", pattern: /leonardo/i },
  { logo: "meta", pattern: /llama|meta/i },
  { logo: "luma", pattern: /luma|ray/i },
  { logo: "midjourney", pattern: /midjourney/i },
  { logo: "minimax", pattern: /minimax|hailuo/i },
  { logo: "mistral", pattern: /mistral|mixtral|pixtral/i },
  { logo: "nvidia", pattern: /nvidia|nemotron/i },
  { logo: "ollama", pattern: /ollama/i },
  { logo: "perplexity", pattern: /perplexity|sonar/i },
  { logo: "pika", pattern: /\bpika\b/i },
  { logo: "runway", pattern: /runway|gen-?3|gen-?4/i },
  { logo: "stability", pattern: /stable-diffusion|stability/i },
  { logo: "suno", pattern: /suno/i },
  { logo: "zai", pattern: /z-?image|tongyi-mai|zai|z\.ai/i },
  { logo: "qwen", pattern: /qwen|tongyi-mai/i },
  { logo: "topaz", pattern: /topaz/i },
  { logo: "wan", pattern: /^wan(?:\s|\/)|\swan\//i },
  { logo: "yandex", pattern: /yandex/i },
  { logo: "xai", pattern: /grok|x-ai|xai/i }
];

const providerAliases: Array<[RegExp, LogoKey]> = [
  [/openrouter/i, "openrouter"],
  [/polza/i, "polza"],
  [/replicate/i, "replicate"],
  [/local/i, "local"]
];

export function modelLogoFor(providerId: string | undefined, modelId: string | undefined, profileId = ""): ModelLogo {
  const provider = (providerId ?? "").trim().toLowerCase();
  const model = modelId ?? "";
  const upstream = model.includes("/") ? model.split("/")[0] ?? "" : "";
  const modelText = `${upstream} ${model} ${profileId}`;
  for (const entry of modelLogoRegistry) {
    if (entry.pattern.test(modelText)) return { id: entry.logo, ...logos[entry.logo] };
  }
  for (const [pattern, key] of providerAliases) {
    if (pattern.test(provider)) return { id: key, ...logos[key] };
  }
  return { id: "unknown", ...logos.unknown };
}
