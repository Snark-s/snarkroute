export type ModelLogo = {
  id: string;
  label: string;
  src: string;
};

const logoSvg = (body: string, background = "#111722") =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img">${background ? `<rect width="64" height="64" rx="14" fill="${background}"/>` : ""}${body}</svg>`)}`;

const PROVIDER_LOGOS: Record<string, ModelLogo> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    src: logoSvg('<path d="M16 48 31 14h6l15 34h-7l-3.4-8H26.4L23 48h-7Zm13-14h10l-5-12-5 12Z" fill="#f1efe4"/>', "#17130f")
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    src: logoSvg('<path d="M32 8c3.6 12.1 11.9 20.4 24 24-12.1 3.6-20.4 11.9-24 24C28.4 43.9 20.1 35.6 8 32c12.1-3.6 20.4-11.9 24-24Z" fill="#8ab4f8"/><path d="M32 17c2.2 7.6 7.4 12.8 15 15-7.6 2.2-12.8 7.4-15 15-2.2-7.6-7.4-12.8-15-15 7.6-2.2 12.8-7.4 15-15Z" fill="#d7e3ff"/>', "#111827")
  },
  google: {
    id: "google",
    label: "Google",
    src: logoSvg('<path d="M51 33.1c0-1.6-.1-2.8-.4-4.1H32v7.6h10.9c-.4 2.5-3.3 7.4-10.9 7.4-6.6 0-12-5.4-12-12s5.4-12 12-12c3.8 0 6.3 1.6 7.7 3l5.3-5.1C41.6 14.7 37.2 13 32 13c-10.5 0-19 8.5-19 19s8.5 19 19 19c11 0 19-7.7 19-17.9Z" fill="#f4f6fb"/><path d="M14.7 24.6 21 29.2c1-3 3.8-5.2 7.1-5.2 1.9 0 3.6.7 4.9 1.9l5.5-5.3c-2.8-2.6-6.4-4.1-10.4-4.1-6 0-11.2 3.3-13.4 8.1Z" fill="#ea4335"/><path d="M28.1 47.5c4 0 7.5-1.3 10.2-3.7l-5.9-4.6c-1.1.8-2.6 1.3-4.3 1.3-3.2 0-6-2.1-7-5.1l-6.3 4.9c2.2 4.3 7.2 7.2 13.3 7.2Z" fill="#34a853"/>', "#101418")
  },
  local: {
    id: "local",
    label: "Local",
    src: logoSvg('<path d="M15 19c0-2.2 1.8-4 4-4h26c2.2 0 4 1.8 4 4v18c0 2.2-1.8 4-4 4H19c-2.2 0-4-1.8-4-4V19Zm8 30h18M28 41v8m8-8v8" fill="none" stroke="#7ee0bd" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="28" r="3" fill="#7ee0bd"/><circle cx="40" cy="28" r="3" fill="#7ee0bd"/>', "#10201c")
  },
  meta: {
    id: "meta",
    label: "Meta",
    src: logoSvg('<path d="M13 38c4-16 10-20 17-6 6-14 14-10 21 1 5 9-3 16-11 8-4-4-7-9-10-9s-6 5-10 9c-5 5-10 3-7-3Z" fill="none" stroke="#8ab4ff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>', "#0e1726")
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    src: logoSvg('<path d="M15 16h8v8h6v8h6v-8h6v-8h8v32h-8v-8h-6v8h-6v-8h-6v8h-8V16Z" fill="#ffaf45"/>', "#1b1510")
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    src: logoSvg('<g fill="none" stroke="#f4f6fb" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M32 13c5 0 9 4 9 9v4l4 2c5 3 6 10 3 14s-9 6-14 3l-3-2-3 2c-5 3-11 1-14-3s-2-11 3-14l4-2v-4c2-5 6-9 11-9Z"/><path d="M23 27 32 22l9 5v10l-9 5-9-5V27Z"/><path d="M32 22v20M23 27l18 10M41 27 23 37"/></g>', "#111111")
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    src: logoSvg('<path d="M11 32h26m0 0-9-9m9 9-9 9" fill="none" stroke="#80dec8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 18h10a7 7 0 0 1 0 14H37m0 14h10a7 7 0 0 0 0-14H37" fill="none" stroke="#c9fff5" stroke-width="5" stroke-linecap="round"/>', "#0b1d1a")
  },
  polza: {
    id: "polza",
    label: "Polza",
    src: logoSvg('<circle cx="26" cy="32" r="11" fill="#9fc4ff"/><circle cx="40" cy="24" r="7" fill="#7ee0bd"/><circle cx="41" cy="40" r="6" fill="#f6d365"/><path d="M25 42V54" stroke="#9fc4ff" stroke-width="5" stroke-linecap="round"/>', "#111827")
  },
  replicate: {
    id: "replicate",
    label: "Replicate",
    src: logoSvg('<path d="M17 18h22c7 0 12 5 12 12s-5 12-12 12H29v9H17V18Zm12 10v4h10a2 2 0 0 0 0-4H29Z" fill="#f4f6fb"/>', "#151515")
  },
  seedance: {
    id: "seedance",
    label: "Seedance",
    src: logoSvg('<path d="M18 40c8 8 22 8 30-4-12 3-21-2-26-15-6 6-8 13-4 19Z" fill="#67c5ad"/><path d="M24 44c5-13 12-21 24-25" fill="none" stroke="#f4f6fb" stroke-width="4" stroke-linecap="round"/>', "#10201c")
  },
  stability: {
    id: "stability",
    label: "Stability AI",
    src: logoSvg('<path d="M19 42c5 5 21 7 26-1 5-9-9-12-16-14-8-2-8-10 1-12 5-1 11 1 15 5" fill="none" stroke="#f4f6fb" stroke-width="5" stroke-linecap="round"/><path d="M18 22h28M18 32h28" stroke="#8ab4ff" stroke-width="3" stroke-linecap="round"/>', "#111827")
  },
  xai: {
    id: "xai",
    label: "xAI",
    src: logoSvg('<path d="M18 17 46 47M46 17 18 47" stroke="#f4f6fb" stroke-width="6" stroke-linecap="round"/><path d="M50 14v36" stroke="#aeb6c5" stroke-width="4" stroke-linecap="round"/>', "#111111")
  },
  unknown: {
    id: "unknown",
    label: "Model provider",
    src: logoSvg('<circle cx="32" cy="32" r="17" fill="none" stroke="#9da8ba" stroke-width="4"/><path d="M24 32h16M32 24v16" stroke="#9da8ba" stroke-width="4" stroke-linecap="round"/>', "#151b25")
  }
};

const PROVIDER_ALIASES: Array<[RegExp, keyof typeof PROVIDER_LOGOS]> = [
  [/anthropic|claude/i, "anthropic"],
  [/gemini|google/i, "gemini"],
  [/gpt|dall-?e|openai/i, "openai"],
  [/openrouter/i, "openrouter"],
  [/polza/i, "polza"],
  [/replicate/i, "replicate"],
  [/seedance|byteplus|volcengine/i, "seedance"],
  [/llama|meta/i, "meta"],
  [/mistral|mixtral|pixtral/i, "mistral"],
  [/stable-diffusion|stability/i, "stability"],
  [/grok|x-ai|xai/i, "xai"],
  [/local/i, "local"]
];

export function modelLogoFor(providerId: string | undefined, modelId: string | undefined, profileId = ""): ModelLogo {
  const provider = normalizeProvider(providerId);
  const model = modelId ?? "";
  const upstream = model.includes("/") ? model.split("/")[0] ?? "" : "";
  const haystack = `${upstream} ${model} ${profileId} ${provider}`.trim();
  for (const [pattern, logoId] of PROVIDER_ALIASES) {
    if (pattern.test(haystack)) return PROVIDER_LOGOS[logoId];
  }
  return PROVIDER_LOGOS.unknown;
}

function normalizeProvider(providerId: string | undefined): string {
  const provider = (providerId ?? "").trim();
  if (provider === "openrouter") return provider;
  return provider.toLowerCase();
}
