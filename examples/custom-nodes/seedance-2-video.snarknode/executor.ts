const BACKENDS = {
  "byteplus-modelark": {
    label: "BytePlus ModelArk",
    keyEnvKeys: ["ARK_API_KEY", "BYTEPLUS_ARK_API_KEY", "SEEDANCE_API_KEY"],
    defaultBaseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3"
  },
  "volcengine-las": {
    label: "Volcengine LAS",
    keyEnvKeys: ["LAS_API_KEY", "VOLCENGINE_LAS_API_KEY", "SEEDANCE_API_KEY"],
    defaultBaseUrl: "https://operator.las.cn-beijing.volces.com/api/v1"
  },
  "seedance-compatible": {
    label: "Custom Seedance-compatible endpoint",
    keyEnvKeys: ["SEEDANCE_API_KEY"]
  }
};
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_IMAGES = 9;
const MAX_VIDEOS = 3;
const MAX_AUDIO = 3;
const BYTEPLUS_MODEL_ALIASES = {
  "seedance-2.0": "dreamina-seedance-2-0-260128",
  "seedance-2.0-fast": "dreamina-seedance-2-0-fast-260128",
  "seedance-2.0-text-to-video": "dreamina-seedance-2-0-260128",
  "seedance-2.0-fast-text-to-video": "dreamina-seedance-2-0-fast-260128",
  "seedance-2.0-image-to-video": "dreamina-seedance-2-0-260128",
  "seedance-2.0-fast-image-to-video": "dreamina-seedance-2-0-fast-260128"
};

export async function runNode(context) {
  const inferredBackend = inferBackendFromEnv(context.env);
  const selectedBackend = normalizeBackend(context.params.providerBackend ?? context.env.SEEDANCE_PROVIDER_BACKEND);
  const hasCustomBaseUrl = Boolean(stringParam(context.params.baseUrl) ?? context.env.SEEDANCE_API_BASE_URL);
  const backend = selectedBackend === "seedance-compatible" && !hasCustomBaseUrl && inferredBackend ? inferredBackend : selectedBackend ?? inferredBackend;
  if (!backend) throw new Error("Seedance provider backend is not selected");
  const backendConfig = BACKENDS[backend];
  const token = firstEnvValue(context.env, backendConfig.keyEnvKeys);
  if (!token) throw new Error("Seedance API key is missing");

  const prompt = firstInputText(context.inputs.prompt) ?? stringParam(context.params.prompt);
  if (!prompt) throw new Error("Seedance 2 Video requires a prompt input or prompt parameter.");

  const firstFrame = firstAssetUrl(context.inputs.firstFrame ?? context.inputs.first_frame ?? context.inputs.image ?? context.params.firstFrame ?? context.params.first_frame ?? context.params.image);
  const referenceImages = collectAssetUrls(context.inputs.images ?? context.params.images);
  const images = firstFrame ? [firstFrame, ...referenceImages] : referenceImages;
  const videos = collectAssetUrls(context.inputs.videos ?? context.inputs.video ?? context.params.videos ?? context.params.video);
  const audio = collectAssetUrls(context.inputs.audio ?? context.params.audio);
  const endImage = firstAssetUrl(context.inputs.endImage ?? context.inputs.end_image ?? context.params.endImage ?? context.params.end_image);

  if (images.length > MAX_IMAGES) throw new Error(`Seedance 2 accepts at most ${MAX_IMAGES} image references including First Frame, got ${images.length}.`);
  if (videos.length > MAX_VIDEOS) throw new Error(`Seedance 2 accepts at most ${MAX_VIDEOS} video references, got ${videos.length}.`);
  if (audio.length > MAX_AUDIO) throw new Error(`Seedance 2 accepts at most ${MAX_AUDIO} audio references, got ${audio.length}.`);

  const baseUrl = trimTrailingSlash(stringParam(context.params.baseUrl) ?? stringParam(context.env.SEEDANCE_API_BASE_URL) ?? backendConfig.defaultBaseUrl ?? "");
  if (!baseUrl) throw new Error("Seedance API base URL is missing");
  const endpointMode = normalizeEndpointMode(context.params.endpointMode, { images, videos, audio, endImage });
  const body = buildRequestBody({ backend, prompt, images, videos, audio, endImage, endpointMode, params: context.params });
  const createPath = stringParam(context.params.createPath) ?? pathForMode(endpointMode, backend);
  const started = Date.now();
  const createResult = await seedanceJson(`${baseUrl}${normalizePath(createPath)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const completed = await waitForVideo({
    baseUrl,
    token,
    initial: createResult,
    pollIntervalMs: positiveNumber(context.params.pollIntervalMs) ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: positiveNumber(context.params.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    statusPathTemplate: stringParam(context.params.statusPathTemplate) ?? statusPathTemplateForBackend(backend)
  });

  const videoUrl = findVideoUrl(completed);
  if (!videoUrl) {
    throw new Error(`Seedance response did not include a video URL: ${truncate(JSON.stringify(completed), 1500)}`);
  }

  const video = await downloadVideoAsset(context, videoUrl);
  return {
    outputs: {
      video,
      output: completed
    },
    logs: [`Generated Seedance 2 video through ${backendConfig.label} ${endpointMode} in ${Date.now() - started}ms at ${video.localPath}`]
  };
}

function buildRequestBody({ backend, prompt, images, videos, audio, endImage, endpointMode, params }) {
  if (backend === "byteplus-modelark") {
    return buildBytePlusRequestBody({ prompt, images, videos, audio, endImage, endpointMode, params });
  }

  const extra = objectParam(params.extraJson);
  const body = filterDefined({
    ...extra,
    model: stringParam(params.model) ?? extra?.model ?? "seedance-2.0",
    prompt,
    motion_prompt: stringParam(params.motionPrompt),
    duration: normalizeDuration(params.duration),
    resolution: stringParam(params.resolution),
    aspect_ratio: stringParam(params.aspectRatio),
    style: stringParam(params.style),
    generate_audio: booleanParam(params.generateAudio),
    seed: integerParam(params.seed),
    end_user_id: stringParam(params.endUserId)
  });

  if (endpointMode === "image-to-video") {
    body.image_url = images[0];
    if (endImage) body.end_image_url = endImage;
    return body;
  }

  if (endpointMode === "reference-to-video") {
    if (images.length) body.image_urls = images;
    if (videos.length) body.video_urls = videos;
    if (audio.length) body.audio_urls = audio;
    if (endImage) body.end_image_url = endImage;
    return body;
  }

  return body;
}

function buildBytePlusRequestBody({ prompt, images, videos, audio, endImage, endpointMode, params }) {
  const extra = objectParam(params.extraJson);
  const model = bytePlusModelId(stringParam(params.model) ?? extra?.model ?? "seedance-2.0");
  const content = [{ type: "text", text: prompt }];

  if (endpointMode === "image-to-video") {
    if (images[0]) content.push({
      type: "image_url",
      image_url: { url: images[0] },
      role: "first_frame"
    });
    if (endImage) content.push({
      type: "image_url",
      image_url: { url: endImage },
      role: "last_frame"
    });
  } else if (endpointMode === "reference-to-video") {
    for (const url of images) {
      content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    }
    for (const url of videos) {
      content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    }
    for (const url of audio) {
      content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
    }
  }

  return filterDefined({
    ...extra,
    model,
    content,
    duration: bytePlusDuration(params.duration),
    resolution: stringParam(params.resolution),
    ratio: stringParam(params.aspectRatio),
    generate_audio: booleanParam(params.generateAudio),
    seed: supportsBytePlusSeed(model) ? integerParam(params.seed) : undefined
  });
}

async function waitForVideo({ baseUrl, token, initial, pollIntervalMs, timeoutMs, statusPathTemplate }) {
  if (isCompleted(initial) || findVideoUrl(initial)) return initial;
  const videoId = findVideoId(initial);
  if (!videoId) return initial;

  const deadline = Date.now() + timeoutMs;
  let latest = initial;
  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    latest = await seedanceJson(`${baseUrl}${statusPath(statusPathTemplate, videoId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (isFailed(latest)) throw new Error(`Seedance generation failed: ${truncate(JSON.stringify(latest), 1500)}`);
    if (isCompleted(latest) || findVideoUrl(latest)) return latest;
  }
  throw new Error(`Seedance generation timed out after ${timeoutMs}ms.`);
}

async function seedanceJson(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`Seedance API request failed: network error${networkErrorDetail(error) ? ` (${networkErrorDetail(error)})` : ""}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(seedanceHttpError(response.status, text));
  }
  return text.trim() ? JSON.parse(text) : {};
}

async function downloadVideoAsset(context, videoUrl) {
  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`Could not download Seedance video (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type")?.split(";")[0] || "video/mp4";
  const dataBase64 = bytes.toString("base64");
  return context.assets.writeBase64(`seedance-2.${extensionForMimeType(contentType, videoUrl)}`, dataBase64, contentType);
}

function normalizeEndpointMode(value, inputs) {
  const mode = stringParam(value)?.toLowerCase();
  if (mode && mode !== "auto") {
    if (["text-to-video", "image-to-video", "reference-to-video"].includes(mode)) return mode;
    throw new Error('endpointMode must be "auto", "text-to-video", "image-to-video", or "reference-to-video".');
  }
  if (inputs.videos.length > 0 || inputs.audio.length > 0 || inputs.images.length > 1) return "reference-to-video";
  if (inputs.images.length === 1 || inputs.endImage) return "image-to-video";
  return "text-to-video";
}

function pathForMode(mode, backend) {
  if (backend === "byteplus-modelark") return "/contents/generations/tasks";
  if (mode === "image-to-video") return "/generate/image-to-video";
  if (mode === "reference-to-video") return "/generate/reference-to-video";
  return "/generate/text-to-video";
}

function statusPathTemplateForBackend(backend) {
  return backend === "byteplus-modelark"
    ? "/contents/generations/tasks/{id}"
    : "/video/{video_id}/status";
}

function statusPath(template, videoId) {
  return normalizePath(template.replace(/\{video_id\}|\{id\}|\{task_id\}/g, encodeURIComponent(videoId)));
}

function normalizePath(value) {
  return value.startsWith("/") ? value : `/${value}`;
}

function collectAssetUrls(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectAssetUrls(item));
  if (value && typeof value === "object") {
    const record = value;
    if (Array.isArray(record.images)) return collectAssetUrls(record.images);
    if (Array.isArray(record.videos)) return collectAssetUrls(record.videos);
    if (Array.isArray(record.audio)) return collectAssetUrls(record.audio);
    const direct = firstAssetUrl(record);
    return direct ? [direct] : [];
  }
  return firstAssetUrl(value) ? [firstAssetUrl(value)] : [];
}

function firstAssetUrl(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value.map(firstAssetUrl).find(Boolean);
  if (value && typeof value === "object") {
    const record = value;
    return firstAssetUrl(record.url ?? record.originalUrl ?? record.remoteUrl ?? record.publicUrl ?? record.image_url ?? record.video_url ?? record.audio_url ?? record.value);
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
  if (typeof value === "string" && value.trim()) {
    throw new Error("Seedance direct API requires reference media as public http(s) URLs. Connect an upstream asset with a URL field or pass a URL parameter.");
  }
  return undefined;
}

function firstInputText(value) {
  if (Array.isArray(value)) return value.map(firstInputText).find((item) => item !== undefined);
  if (value && typeof value === "object") {
    const record = value;
    return firstInputText(record.text ?? record.value ?? record.output);
  }
  return stringParam(value);
}

function findVideoId(value) {
  const record = unwrapData(value);
  return stringParam(record.video_id) ?? stringParam(record.id) ?? stringParam(record.task_id);
}

function findVideoUrl(value) {
  const record = unwrapData(value);
  return stringParam(record.video_url)
    ?? stringParam(record.output_url)
    ?? stringParam(record.url)
    ?? stringParam(record.content?.video_url)
    ?? stringParam(record.video?.url)
    ?? stringParam(record.result?.video_url)
    ?? stringParam(record.result?.video?.url);
}

function isCompleted(value) {
  const status = stringParam(unwrapData(value).status)?.toLowerCase();
  return ["completed", "complete", "succeeded", "success", "done", "finished"].includes(status ?? "");
}

function isFailed(value) {
  const status = stringParam(unwrapData(value).status)?.toLowerCase();
  return ["failed", "error", "cancelled", "canceled"].includes(status ?? "");
}

function unwrapData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value;
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) return record.data;
  return record;
}

function objectParam(value) {
  if (!value) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return JSON.parse(value);
  return undefined;
}

function stringParam(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanParam(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.trim()) return value.trim().toLowerCase() !== "false";
  return undefined;
}

function integerParam(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizeDuration(value) {
  const text = stringParam(value);
  if (!text) return undefined;
  return text.toLowerCase() === "auto" ? "auto" : text;
}

function bytePlusDuration(value) {
  const text = stringParam(value);
  if (!text || text.toLowerCase() === "auto") return undefined;
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function bytePlusModelId(value) {
  const model = stringParam(value) ?? "seedance-2.0";
  return BYTEPLUS_MODEL_ALIASES[model.toLowerCase()] ?? model;
}

function supportsBytePlusSeed(model) {
  return !model.toLowerCase().includes("seedance-2-0");
}

function filterDefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function normalizeBackend(value) {
  const text = stringParam(value)?.toLowerCase().replace(/[_\s]+/g, "-");
  if (text === "byteplus-modelark" || text === "byteplus" || text === "modelark" || text === "seedance-byteplus") return "byteplus-modelark";
  if (text === "volcengine-las" || text === "volcengine" || text === "las" || text === "seedance-volcengine") return "volcengine-las";
  if (text === "seedance-compatible" || text === "custom-seedance-compatible-endpoint" || text === "seedance" || text === "custom") return "seedance-compatible";
  return undefined;
}

function inferBackendFromEnv(env) {
  if (stringParam(env.ARK_API_KEY) || stringParam(env.BYTEPLUS_ARK_API_KEY)) return "byteplus-modelark";
  if (stringParam(env.LAS_API_KEY) || stringParam(env.VOLCENGINE_LAS_API_KEY)) return "volcengine-las";
  const legacyKey = stringParam(env.SEEDANCE_API_KEY);
  const baseUrl = stringParam(env.SEEDANCE_API_BASE_URL);
  if (legacyKey?.startsWith("ark-")) return "byteplus-modelark";
  if (legacyKey && baseUrl) return "seedance-compatible";
  return undefined;
}

function firstEnvValue(env, keys) {
  let invalidKey;
  for (const key of keys) {
    const value = stringParam(env[key]);
    if (value && isHeaderSafeSecret(value)) return value;
    if (value && !invalidKey) invalidKey = key;
  }
  if (invalidKey) throw new Error(`Seedance API key in ${invalidKey} is invalid`);
  return undefined;
}

function isHeaderSafeSecret(value) {
  return /^[\x21-\x7E]+$/.test(value);
}

function seedanceHttpError(status, body) {
  if (status === 401 || status === 403) return "Seedance API returned 401/403: check API key";
  if (status === 404) return "Seedance API returned 404: check base URL / endpoint";
  if (status === 429) return "Seedance API returned 429: rate limit or quota exceeded";
  return `Seedance API request failed (${status}): ${truncate(body, 1500)}`;
}

function networkErrorDetail(error) {
  if (!error) return "";
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return [message, cause].filter(Boolean).join(": ");
}

function extensionForMimeType(mimeType, url) {
  if (mimeType === "video/quicktime") return "mov";
  if (mimeType === "video/webm") return "webm";
  if (mimeType === "video/mp4") return "mp4";
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url);
  return match?.[1] ?? "mp4";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
