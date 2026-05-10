import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const API_BASE = "https://api.openai.com/v1";
const MAX_INPUT_IMAGES = 16;
const LOCAL_FILE_LIMIT_BYTES = 50 * 1024 * 1024;

export async function runNode(context) {
  const token = String(context.env.OPENAI_API_KEY ?? "").trim();
  if (!token) {
    throw new Error("OPENAI_API_KEY is not configured. Open Settings -> Secrets -> OpenAI and paste your API key.");
  }

  const prompt = firstInputText(context.inputs.prompt) ?? stringParam(context.params.prompt) ?? "Create a polished image.";
  const model = stringParam(context.params.model) ?? "chatgpt-image-latest";
  const images = collectImages(context.inputs.images ?? context.inputs.image ?? context.params.images ?? context.params.image);

  if (images.length > MAX_INPUT_IMAGES) {
    throw new Error(`ChatGPT Image 2 accepts at most ${MAX_INPUT_IMAGES} input images, got ${images.length}.`);
  }

  const result = images.length > 0
    ? await editImage({ token, model, prompt, images, params: context.params })
    : await generateImage({ token, model, prompt, params: context.params });

  const firstImage = Array.isArray(result.data) ? result.data.find((item) => item && typeof item.b64_json === "string") : undefined;
  if (!firstImage) {
    throw new Error("OpenAI image response did not include a base64 image.");
  }

  const outputFormat = normalizeOutputFormat(result.output_format ?? context.params.outputFormat) ?? "png";
  const image = await context.assets.writeBase64(`chatgpt-image-2.${extensionForFormat(outputFormat)}`, firstImage.b64_json, `image/${outputFormat}`);

  return {
    outputs: {
      image
    },
    logs: [`Generated image with ${model} at ${image.localPath}`]
  };
}

async function generateImage({ token, model, prompt, params }) {
  const body = filterDefined({
    model,
    prompt,
    n: 1,
    size: stringParam(params.size),
    quality: stringParam(params.quality),
    output_format: normalizeOutputFormat(params.outputFormat),
    background: stringParam(params.background),
    moderation: stringParam(params.moderation)
  });

  return openaiJson("/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function editImage({ token, model, prompt, images, params }) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("n", "1");
  appendIfString(form, "size", params.size);
  appendIfString(form, "quality", params.quality);
  appendIfString(form, "output_format", normalizeOutputFormat(params.outputFormat));
  appendIfString(form, "background", params.background);
  appendIfString(form, "moderation", params.moderation);

  let index = 1;
  for (const image of images) {
    const file = await imageToBlob(image, index);
    form.append("image", file.blob, file.filename);
    index += 1;
  }

  return openaiJson("/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });
}

async function openaiJson(path, init) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenAI API is unreachable: ${message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}): ${truncate(text, 1500)}`);
  }
  return text.trim() ? JSON.parse(text) : {};
}

async function imageToBlob(value, index) {
  const resolved = unwrapImageValue(value);
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw new Error("Expected each image input to be a local path, image object, data URI, or remote URL.");
  }

  if (resolved.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.+)$/i.exec(resolved);
    if (!match) throw new Error("Invalid data URI image input.");
    const bytes = Buffer.from(match[2], "base64");
    return {
      blob: new Blob([bytes], { type: match[1] }),
      filename: `input-${index}.${extensionForMimeType(match[1])}`
    };
  }

  if (/^https?:\/\//i.test(resolved)) {
    const response = await fetch(resolved);
    if (!response.ok) throw new Error(`Could not fetch remote image input (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > LOCAL_FILE_LIMIT_BYTES) throw new Error(`Remote image input is too large (${bytes.length} bytes). Limit is ${LOCAL_FILE_LIMIT_BYTES} bytes.`);
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
    return {
      blob: new Blob([bytes], { type: mimeType }),
      filename: `input-${index}.${extensionForMimeType(mimeType)}`
    };
  }

  const bytes = await readFile(resolved);
  if (bytes.length > LOCAL_FILE_LIMIT_BYTES) {
    throw new Error(`Local image input is too large (${bytes.length} bytes). Limit is ${LOCAL_FILE_LIMIT_BYTES} bytes.`);
  }
  const mimeType = mimeTypeFromPath(resolved);
  return {
    blob: new Blob([bytes], { type: mimeType }),
    filename: basename(resolved)
  };
}

function collectImages(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectImages(item));
  if (value && typeof value === "object") {
    const record = value;
    if (Array.isArray(record.images)) return collectImages(record.images);
    if ("image" in record && Object.keys(record).length === 1) return collectImages(record.image);
  }
  return [value];
}

function unwrapImageValue(value) {
  if (value && typeof value === "object") {
    const record = value;
    return unwrapImageValue(record.localPath ?? record.path ?? record.originalUrl ?? record.url ?? record.image);
  }
  return value;
}

function firstInputText(value) {
  if (Array.isArray(value)) {
    const found = value.map(firstInputText).find((item) => item !== undefined);
    return found;
  }
  if (value && typeof value === "object") {
    const record = value;
    return firstInputText(record.text ?? record.value ?? record.output);
  }
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringParam(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function appendIfString(form, key, value) {
  const text = stringParam(value);
  if (text) form.set(key, text);
}

function filterDefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function normalizeOutputFormat(value) {
  const format = stringParam(value)?.toLowerCase();
  if (format === "jpeg" || format === "jpg") return "jpeg";
  if (format === "webp") return "webp";
  if (format === "png") return "png";
  return undefined;
}

function extensionForFormat(format) {
  return format === "jpeg" ? "jpg" : format || "png";
}

function extensionForMimeType(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/png") return "png";
  return "png";
}

function mimeTypeFromPath(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".png") return "image/png";
  return "image/png";
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
