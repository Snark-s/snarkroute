import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getLocalAssetMetadata, type LocalAssetKind } from "@snarkroute/nodes";
import { assetsDirectory, modelIconsDirectory } from "../server-paths";
import { browseLocalFile, sanitizeFilename } from "../assets/service";
import { errorMessage } from "../services/errors";

export async function registerAssetRoutes(app: FastifyInstance) {
app.get<{ Params: { filename: string } }>("/api/model-icons/:filename", async (request, reply) => {
  try {
    const filename = sanitizeFilename(basename(request.params.filename));
    if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(filename)) return reply.code(404).send({ error: "Model icon not found." });
    const path = join(modelIconsDirectory, filename);
    await access(path);
    reply.header("Cache-Control", "no-cache");
    reply.header("Content-Type", modelIconContentType(filename));
    return reply.send(createReadStream(path));
  } catch {
    return reply.code(404).send({ error: "Model icon not found." });
  }
});

app.get<{ Querystring: { path?: string; kind?: LocalAssetKind } }>("/api/assets/metadata", async (request, reply) => {
  try {
    return await getLocalAssetMetadata(request.query.path ?? "", request.query.kind ?? "file");
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.get<{ Querystring: { path?: string; kind?: LocalAssetKind } }>("/api/assets/preview", async (request, reply) => {
  try {
    const metadata = await getLocalAssetMetadata(request.query.path ?? "", request.query.kind ?? "image");
    reply.header("Content-Type", metadata.mimeType);
    return reply.send(createReadStream(metadata.path));
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: { kind?: LocalAssetKind } }>("/api/assets/browse", async (request, reply) => {
  try {
    const path = await browseLocalFile(request.body?.kind ?? "file");
    if (!path) return { canceled: true };
    const metadata = await getLocalAssetMetadata(path, request.body?.kind ?? "file");
    return { canceled: false, path: metadata.path, metadata };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: { filename?: string; dataBase64?: string; kind?: LocalAssetKind } }>("/api/assets/import", async (request, reply) => {
  let createdPath = "";
  try {
    const filename = sanitizeFilename(basename(request.body?.filename ?? "asset.bin")) || "asset.bin";
    const dataBase64 = request.body?.dataBase64;
    const kind = request.body?.kind ?? "file";
    if (!["file", "image", "video", "audio"].includes(kind)) return reply.code(400).send({ error: "Unsupported asset kind." });
    if (!dataBase64) return reply.code(400).send({ error: "dataBase64 is required." });
    const normalized = strictBase64(dataBase64);
    const maxBytes = positiveEnv("SNARKROUTE_ASSET_MAX_UPLOAD_BYTES", 100 * 1024 * 1024);
    const estimatedBytes = Math.floor(normalized.length * 3 / 4) - (normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0);
    if (estimatedBytes <= 0 || estimatedBytes > maxBytes) return reply.code(413).send({ error: `Asset must be between 1 and ${maxBytes} bytes.` });
    const bytes = Buffer.from(normalized, "base64");
    validateMediaSignature(kind, bytes, filename);
    await mkdir(assetsDirectory, { recursive: true });
    const id = `asset_${randomUUID()}`;
    createdPath = join(assetsDirectory, `${id}-${filename}`);
    await writeFile(createdPath, bytes, { flag: "wx" });
    const metadata = await getLocalAssetMetadata(createdPath, kind);
    return { id, path: createdPath, metadata };
  } catch (error) {
    if (createdPath) await rm(createdPath, { force: true }).catch(() => undefined);
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

}

function strictBase64(value: string): string {
  const normalized = value.replace(/^data:[^;,]+;base64,/i, "").replace(/\s/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error("dataBase64 is malformed.");
  return normalized;
}

function validateMediaSignature(kind: LocalAssetKind, bytes: Buffer, filename: string): void {
  if (kind === "file") return;
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  const mp4 = bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
  const webm = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const wav = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
  const mp3 = bytes.length >= 3 && (bytes.toString("ascii", 0, 3) === "ID3" || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  const flac = bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "fLaC";
  const ogg = bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS";
  if (kind === "image" && !([".png"].includes(extension) && png || [".jpg", ".jpeg"].includes(extension) && jpeg || extension === ".webp" && webp)) throw new Error("Image content does not match a supported PNG, JPEG, or WebP filename.");
  if (kind === "video" && !([".mp4", ".mov", ".m4v"].includes(extension) && mp4 || [".webm", ".mkv"].includes(extension) && webm)) throw new Error("Video content does not match a supported MP4/MOV or WebM/MKV filename.");
  if (kind === "audio" && !(extension === ".wav" && wav || extension === ".mp3" && mp3 || extension === ".flac" && flac || extension === ".ogg" && ogg || [".m4a", ".aac"].includes(extension) && (mp4 || bytes[0] === 0xff))) throw new Error("Audio content does not match a supported WAV, MP3, FLAC, OGG, M4A, or AAC filename.");
}

function positiveEnv(name: string, fallback: number): number { const value = Number(process.env[name]); return Number.isSafeInteger(value) && value > 0 ? value : fallback; }

function modelIconContentType(filename: string): string {
  if (/\.svg$/i.test(filename)) return "image/svg+xml";
  if (/\.webp$/i.test(filename)) return "image/webp";
  if (/\.gif$/i.test(filename)) return "image/gif";
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  return "image/png";
}
