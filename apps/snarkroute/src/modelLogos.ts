export type ModelLogo = {
  label: string;
  src: string;
};

const logoSvg = (body: string, background = "#111722") =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${background ? `<rect width="64" height="64" rx="14" fill="${background}"/>` : ""}${body}</svg>`)}`;

const logos = {
  anthropic: { label: "Anthropic", src: logoSvg('<path d="M16 48 31 14h6l15 34h-7l-3.4-8H26.4L23 48h-7Zm13-14h10l-5-12-5 12Z" fill="#f1efe4"/>', "#17130f") },
  gemini: { label: "Gemini", src: logoSvg('<path d="M32 8c3.6 12.1 11.9 20.4 24 24-12.1 3.6-20.4 11.9-24 24C28.4 43.9 20.1 35.6 8 32c12.1-3.6 20.4-11.9 24-24Z" fill="#8ab4f8"/><path d="M32 17c2.2 7.6 7.4 12.8 15 15-7.6 2.2-12.8 7.4-15 15-2.2-7.6-7.4-12.8-15-15 7.6-2.2 12.8-7.4 15-15Z" fill="#d7e3ff"/>', "#111827") },
  local: { label: "Local", src: logoSvg('<path d="M15 19c0-2.2 1.8-4 4-4h26c2.2 0 4 1.8 4 4v18c0 2.2-1.8 4-4 4H19c-2.2 0-4-1.8-4-4V19Zm8 30h18M28 41v8m8-8v8" fill="none" stroke="#7ee0bd" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="28" r="3" fill="#7ee0bd"/><circle cx="40" cy="28" r="3" fill="#7ee0bd"/>', "#10201c") },
  meta: { label: "Meta", src: logoSvg('<path d="M13 38c4-16 10-20 17-6 6-14 14-10 21 1 5 9-3 16-11 8-4-4-7-9-10-9s-6 5-10 9c-5 5-10 3-7-3Z" fill="none" stroke="#8ab4ff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>', "#0e1726") },
  mistral: { label: "Mistral", src: logoSvg('<path d="M15 16h8v8h6v8h6v-8h6v-8h8v32h-8v-8h-6v8h-6v-8h-6v8h-8V16Z" fill="#ffaf45"/>', "#1b1510") },
  openai: { label: "OpenAI", src: logoSvg('<g fill="none" stroke="#f4f6fb" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M32 13c5 0 9 4 9 9v4l4 2c5 3 6 10 3 14s-9 6-14 3l-3-2-3 2c-5 3-11 1-14-3s-2-11 3-14l4-2v-4c2-5 6-9 11-9Z"/><path d="M23 27 32 22l9 5v10l-9 5-9-5V27Z"/><path d="M32 22v20M23 27l18 10M41 27 23 37"/></g>', "#111111") },
  openrouter: { label: "OpenRouter", src: logoSvg('<path d="M11 32h26m0 0-9-9m9 9-9 9" fill="none" stroke="#80dec8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 18h10a7 7 0 0 1 0 14H37m0 14h10a7 7 0 0 0 0-14H37" fill="none" stroke="#c9fff5" stroke-width="5" stroke-linecap="round"/>', "#0b1d1a") },
  polza: { label: "Polza", src: logoSvg('<circle cx="26" cy="32" r="11" fill="#9fc4ff"/><circle cx="40" cy="24" r="7" fill="#7ee0bd"/><circle cx="41" cy="40" r="6" fill="#f6d365"/><path d="M25 42V54" stroke="#9fc4ff" stroke-width="5" stroke-linecap="round"/>', "#111827") },
  stability: { label: "Stability AI", src: logoSvg('<path d="M19 42c5 5 21 7 26-1 5-9-9-12-16-14-8-2-8-10 1-12 5-1 11 1 15 5" fill="none" stroke="#f4f6fb" stroke-width="5" stroke-linecap="round"/><path d="M18 22h28M18 32h28" stroke="#8ab4ff" stroke-width="3" stroke-linecap="round"/>', "#111827") },
  xai: { label: "xAI", src: logoSvg('<path d="M18 17 46 47M46 17 18 47" stroke="#f4f6fb" stroke-width="6" stroke-linecap="round"/><path d="M50 14v36" stroke="#aeb6c5" stroke-width="4" stroke-linecap="round"/>', "#111111") },
  unknown: { label: "Model provider", src: logoSvg('<circle cx="32" cy="32" r="17" fill="none" stroke="#9da8ba" stroke-width="4"/><path d="M24 32h16M32 24v16" stroke="#9da8ba" stroke-width="4" stroke-linecap="round"/>', "#151b25") }
};

const aliases: Array<[RegExp, keyof typeof logos]> = [
  [/anthropic|claude/i, "anthropic"],
  [/gemini|google/i, "gemini"],
  [/gpt|dall-?e|openai/i, "openai"],
  [/openrouter/i, "openrouter"],
  [/polza/i, "polza"],
  [/llama|meta/i, "meta"],
  [/mistral|mixtral|pixtral/i, "mistral"],
  [/stable-diffusion|stability/i, "stability"],
  [/grok|x-ai|xai/i, "xai"],
  [/local/i, "local"]
];

export function modelLogoFor(providerId: string | undefined, modelId: string | undefined): ModelLogo {
  const text = `${modelId?.includes("/") ? modelId.split("/")[0] : ""} ${modelId ?? ""} ${providerId ?? ""}`;
  for (const [pattern, key] of aliases) {
    if (pattern.test(text)) return logos[key];
  }
  return logos.unknown;
}
