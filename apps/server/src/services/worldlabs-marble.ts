import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import sharp from "sharp";

const WORLDS_API_BASE = "https://api.worldlabs.ai/marble/v1";
const MARBLE_PANORAMA_WIDTH = 3000;
const MARBLE_PANORAMA_HEIGHT = 1500;

export type MarbleModel = "marble-1.0-draft" | "marble-1.0" | "marble-1.1" | "marble-1.1-plus";

export interface GenerateMarbleWorldInput {
  imageUrl?: string;
  imagePath?: string;
  isPano?: boolean;
  model?: MarbleModel | string;
  displayName?: string;
  sourceImageHash?: string;
}

export function worldLabsApiKey(): string {
  const key = process.env.WORLDS_API_KEY?.trim();
  if (!key) throw new Error("World Labs API key is not configured. Set WORLDS_API_KEY in environment variables.");
  return key;
}

export async function generateMarbleWorld(input: GenerateMarbleWorldInput) {
  const apiKey = worldLabsApiKey();
  const model = normalizeMarbleModel(input.model);
  const imagePrompt = input.imagePath
    ? await uploadLocalImageAsMediaAsset(input.imagePath, apiKey)
    : await uploadImageUrlAsMediaAsset(requiredString(input.imageUrl, "Generate Marble world requires imageUrl or imagePath."), apiKey);

  const payload = {
    display_name: input.displayName?.trim() || "SnarkRoute camera point draft",
    model,
    world_prompt: {
      type: "image",
      image_prompt: imagePrompt,
      is_pano: input.isPano !== false,
      text_prompt: "Reconstruct a navigable draft world from this 360 equirectangular panorama."
    },
    permission: {
      allow_id_access: false,
      allowed_readers: [],
      allowed_writers: [],
      public: false
    },
    tags: ["snarkroute", "choose-camera"],
    metadata: {
      sourceImageHash: input.sourceImageHash
    }
  };

  return worldLabsJson("/worlds:generate", {
    method: "POST",
    apiKey,
    body: payload
  });
}

export async function getMarbleOperation(operationId: string) {
  return worldLabsJson(`/operations/${encodeURIComponent(requiredString(operationId, "operationId is required."))}`, {
    method: "GET",
    apiKey: worldLabsApiKey()
  });
}

export async function getMarbleWorld(worldId: string) {
  return worldLabsJson(`/worlds/${encodeURIComponent(requiredString(worldId, "worldId is required."))}`, {
    method: "GET",
    apiKey: worldLabsApiKey()
  });
}

function normalizeMarbleModel(model: unknown): MarbleModel {
  const value = String(model ?? "marble-1.0-draft");
  if (["marble-1.0-draft", "marble-1.0", "marble-1.1", "marble-1.1-plus"].includes(value)) return value as MarbleModel;
  return "marble-1.0-draft";
}

async function uploadLocalImageAsMediaAsset(imagePath: string, apiKey: string) {
  return uploadNormalizedImageAsMediaAsset(await normalizeLocalMarblePanoramaImage(imagePath), apiKey);
}

async function uploadImageUrlAsMediaAsset(imageUrl: string, apiKey: string) {
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error("World Labs imageUrl must be an http(s) URL. Pass imagePath for local files.");
  }
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`World Labs source image download failed (${response.status}).`);
  return uploadNormalizedImageAsMediaAsset(await normalizeMarblePanoramaBytes(Buffer.from(await response.arrayBuffer()), "snarkroute-pano"), apiKey);
}

async function uploadNormalizedImageAsMediaAsset(normalizedImage: { bytes: Buffer; filename: string }, apiKey: string) {
  const prepare = await worldLabsJson("/media-assets:prepare_upload", {
    method: "POST",
    apiKey,
    body: {
      file_name: normalizedImage.filename.slice(0, 64) || "snarkroute-pano-3000x1500.png",
      kind: "image",
      extension: "png",
      metadata: { source: "snarkroute", normalizedWidth: MARBLE_PANORAMA_WIDTH, normalizedHeight: MARBLE_PANORAMA_HEIGHT }
    }
  }) as Record<string, unknown>;
  const mediaAsset = objectRecord(prepare.media_asset);
  const uploadInfo = objectRecord(prepare.upload_info);
  const mediaAssetId = requiredString(mediaAsset.media_asset_id ?? mediaAsset.id, "World Labs prepare_upload response did not include media_asset_id.");
  const uploadUrl = requiredString(uploadInfo.upload_url, "World Labs prepare_upload response did not include upload_url.");
  const requiredHeaders = objectRecord(uploadInfo.required_headers);
  const headers = new Headers();
  headers.set("Content-Type", "image/png");
  for (const [key, value] of Object.entries(requiredHeaders)) headers.set(key, String(value));

  const uploadResponse = await fetch(uploadUrl, {
    method: String(uploadInfo.upload_method ?? "PUT"),
    headers,
    body: arrayBufferFromBuffer(normalizedImage.bytes)
  });
  if (!uploadResponse.ok) {
    throw new Error(`World Labs media upload failed (${uploadResponse.status}).`);
  }
  return { source: "media_asset", media_asset_id: mediaAssetId };
}

async function normalizeLocalMarblePanoramaImage(imagePath: string): Promise<{ bytes: Buffer; filename: string }> {
  const sourceName = basename(imagePath, extname(imagePath)).slice(0, 40) || "snarkroute-pano";
  return normalizeMarblePanoramaBytes(await readFile(imagePath), sourceName);
}

async function normalizeMarblePanoramaBytes(source: Buffer, sourceName: string): Promise<{ bytes: Buffer; filename: string }> {
  const bytes = await sharp(source, { failOn: "none" })
    .resize(MARBLE_PANORAMA_WIDTH, MARBLE_PANORAMA_HEIGHT, { fit: "fill" })
    .png()
    .toBuffer();
  return { bytes, filename: `${sourceName}-3000x1500.png` };
}

function arrayBufferFromBuffer(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

async function worldLabsJson(path: string, options: { method: "GET" | "POST"; apiKey: string; body?: unknown }) {
  const response = await fetch(`${WORLDS_API_BASE}${path}`, {
    method: options.method,
    headers: {
      "Content-Type": "application/json",
      "WLT-Api-Key": options.apiKey
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  const body = text ? parseJson(text) : {};
  if (!response.ok) {
    const message = objectRecord(body).error;
    throw new Error(typeof message === "string" ? message : `World Labs API request failed (${response.status}).`);
  }
  return body;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function requiredString(value: unknown, message: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(message);
  return text;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
