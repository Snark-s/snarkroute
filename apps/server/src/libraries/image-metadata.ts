export const imageProvenanceFormat = "snarkroute.image-provenance";
export const imageProvenanceVersion = "0.1";
export const imageMetadataSchema = "snarkroute.image-metadata.v1";

export interface SnarkImageProvenance {
  format: typeof imageProvenanceFormat;
  version: typeof imageProvenanceVersion;
  prompt: string;
  parameters: Record<string, unknown>;
  providerId?: string;
  modelId: string;
  nodeId: string;
  createdAt: string;
}

export interface SnarkImageMetadata {
  schema: typeof imageMetadataSchema;
  kind: "generated-image";
  id: string;
  createdAt: string;
  source: {
    nodeId: string;
    outputId: string;
    runId?: string;
  };
  generation: {
    providerId?: string;
    modelId: string;
    providerMode?: string;
    fallbackAllowed?: boolean;
    prompt: {
      text: string;
      template?: string;
    };
    inputImages: Array<{
      ref: string;
      nodeId?: string;
      assetId?: string;
      mimeType?: string;
      role?: string;
    }>;
    parameters: Record<string, unknown>;
  };
  library?: {
    title?: string;
    category?: string;
    status?: string;
    modelHints?: string[];
  };
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngKeyword = "snarkroute.provenance";
const legacyPngKeywords = [pngKeyword, "snarkroute.provenance_json"];
const xmpHeader = "http://ns.adobe.com/xap/1.0/\0";
const xmpNamespace = "https://snarkroute.local/ns/image-provenance/0.1/";

export function embedImageProvenance(buffer: Buffer, extension: string, metadata: SnarkImageMetadata): Buffer {
  const json = JSON.stringify(metadata);
  if (extension === ".png") return embedPngText(buffer, json);
  if (extension === ".jpg" || extension === ".jpeg") return embedJpegXmp(buffer, json);
  if (extension === ".webp") return embedWebpXmp(buffer, json);
  throw new Error(`Cannot embed SnarkRoute provenance in image format "${extension}".`);
}

export function extractImageProvenance(buffer: Buffer, extension: string): SnarkImageMetadata | undefined {
  let json: string | undefined;
  if (extension === ".png") json = extractPngText(buffer);
  if (extension === ".jpg" || extension === ".jpeg") json = extractJpegXmp(buffer);
  if (extension === ".webp") json = extractWebpXmp(buffer);
  if (!json) return undefined;
  return normalizeImageMetadata(JSON.parse(json));
}

export function normalizeImageMetadata(value: unknown): SnarkImageMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schema === imageMetadataSchema && record.kind === "generated-image") {
    return scrubImageMetadata(record as unknown as SnarkImageMetadata);
  }
  if (record.format !== imageProvenanceFormat || record.version !== imageProvenanceVersion) return undefined;
  const parameters = objectRecord(record.parameters);
  const cleanParameters = stripRuntimeFields(parameters);
  const prompt = stringValue(record.prompt) || stringValue(parameters.prompt) || "";
  const promptTemplate = stringValue(parameters.promptTemplate);
  const images = Array.isArray(parameters.images) ? parameters.images : [];
  return scrubImageMetadata({
    schema: imageMetadataSchema,
    kind: "generated-image",
    id: stringValue(record.id) || `${stringValue(record.nodeId) || "image"}-legacy`,
    createdAt: stringValue(record.createdAt) || new Date(0).toISOString(),
    source: {
      nodeId: stringValue(record.nodeId) || "",
      outputId: stringValue(record.outputId) || "image",
      runId: stringValue(record.runId)
    },
    generation: {
      providerId: stringValue(record.providerId) || stringValue(parameters.executionProvider),
      modelId: stringValue(record.modelId) || stringValue(parameters.model) || "",
      providerMode: stringValue(parameters.providerMode),
      fallbackAllowed: typeof parameters.fallbackAllowed === "boolean" ? parameters.fallbackAllowed : undefined,
      prompt: {
        text: prompt,
        template: promptTemplate || undefined
      },
      inputImages: images.map((entry) => normalizeInputImage(entry)).filter((entry): entry is NonNullable<ReturnType<typeof normalizeInputImage>> => Boolean(entry)),
      parameters: cleanParameters
    },
    library: {
      category: "generated",
      status: "candidate",
      modelHints: stringValue(record.modelId) ? [stringValue(record.modelId)!] : undefined
    }
  });
}

function embedPngText(buffer: Buffer, json: string): Buffer {
  if (!buffer.subarray(0, pngSignature.length).equals(pngSignature)) throw new Error("Cannot write PNG provenance to an invalid PNG.");
  const payload = Buffer.concat([
    Buffer.from(pngKeyword, "latin1"),
    Buffer.from([0, 0, 0, 0, 0]),
    Buffer.from(json, "utf8")
  ]);
  const chunk = pngChunk("iTXt", payload);
  const iendOffset = findPngChunk(buffer, "IEND");
  if (iendOffset < 0) throw new Error("Cannot write PNG provenance without an IEND chunk.");
  return Buffer.concat([buffer.subarray(0, iendOffset), chunk, buffer.subarray(iendOffset)]);
}

function extractPngText(buffer: Buffer): string | undefined {
  let offset = pngSignature.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "iTXt") {
      for (const keyword of legacyPngKeywords) {
        if (data.toString("latin1", 0, keyword.length) === keyword && data[keyword.length] === 0) {
          return data.subarray(keyword.length + 5).toString("utf8");
        }
      }
    }
    offset += length + 12;
  }
  return undefined;
}

function embedJpegXmp(buffer: Buffer, json: string): Buffer {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error("Cannot write JPEG provenance to an invalid JPEG.");
  const payload = Buffer.from(`${xmpHeader}${xmpPacket(json)}`, "utf8");
  if (payload.length + 2 > 0xffff) throw new Error("JPEG provenance payload is too large for APP1.");
  const app1 = Buffer.alloc(4 + payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  return Buffer.concat([buffer.subarray(0, 2), app1, buffer.subarray(2)]);
}

function extractJpegXmp(buffer: Buffer): string | undefined {
  let offset = 2;
  while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = buffer.readUInt16BE(offset + 2);
    const segment = buffer.toString("utf8", offset + 4, offset + 2 + length);
    if (marker === 0xe1 && segment.startsWith(xmpHeader)) return jsonFromXmp(segment.slice(xmpHeader.length));
    offset += length + 2;
  }
  return undefined;
}

function embedWebpXmp(buffer: Buffer, json: string): Buffer {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("Cannot write WebP provenance to an invalid WebP.");
  }
  const payload = Buffer.from(xmpPacket(json), "utf8");
  const padding = payload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  const chunk = Buffer.alloc(8 + payload.length + padding.length);
  chunk.write("XMP ", 0, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  padding.copy(chunk, 8 + payload.length);
  const result = Buffer.concat([buffer, chunk]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

function extractWebpXmp(buffer: Buffer): string | undefined {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    if (type === "XMP ") return jsonFromXmp(buffer.toString("utf8", offset + 8, offset + 8 + length));
    offset += 8 + length + (length % 2);
  }
  return undefined;
}

function xmpPacket(json: string): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:snarkroute="${xmpNamespace}"><snarkroute:provenance>${Buffer.from(json, "utf8").toString("base64")}</snarkroute:provenance></x:xmpmeta>`;
}

function jsonFromXmp(xmp: string): string | undefined {
  const match = xmp.match(/<snarkroute:provenance>([A-Za-z0-9+/=]+)<\/snarkroute:provenance>/);
  return match ? Buffer.from(match[1], "base64").toString("utf8") : undefined;
}

function scrubImageMetadata(metadata: SnarkImageMetadata): SnarkImageMetadata {
  return {
    ...metadata,
    generation: {
      ...metadata.generation,
      inputImages: metadata.generation.inputImages.map((image) => ({ ...image, ref: portableRef(image.ref) })).filter((image) => Boolean(image.ref)),
      parameters: stripRuntimeFields(metadata.generation.parameters)
    }
  };
}

function stripRuntimeFields(parameters: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (key === "prompt" || key === "promptTemplate" || key === "images" || key === "localPath" || key === "path") continue;
    const stripped = stripRuntimeValue(value);
    if (stripped !== undefined) clean[key] = stripped;
  }
  return clean;
}

function stripRuntimeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRuntimeValue);
  if (typeof value === "string") return isAbsoluteLocalPath(value) ? undefined : value;
  if (!value || typeof value !== "object") return value;
  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "localPath" || key === "path") continue;
    const stripped = stripRuntimeValue(nested);
    if (stripped !== undefined) clean[key] = stripped;
  }
  return clean;
}

function normalizeInputImage(value: unknown): { ref: string; nodeId?: string; assetId?: string; mimeType?: string; role?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const ref = portableRef(stringValue(record.ref) || stringValue(record.assetRef) || stringValue(record.path) || stringValue(record.url) || "");
  if (!ref) return undefined;
  return {
    ref,
    nodeId: stringValue(record.nodeId) || stringValue(record.sourceNodeId),
    assetId: stringValue(record.assetId),
    mimeType: stringValue(record.mimeType),
    role: stringValue(record.role) || stringValue(record.caption)
  };
}

function portableRef(value: string): string {
  if (!value) return "";
  if (/^(library|node|asset):\/\//i.test(value) || /^https?:\/\//i.test(value)) return value;
  if (isAbsoluteLocalPath(value)) return "";
  return value.replace(/\\/g, "/");
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function findPngChunk(buffer: Buffer, chunkType: string): number {
  let offset = pngSignature.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.toString("ascii", offset + 4, offset + 8) === chunkType) return offset;
    offset += length + 12;
  }
  return -1;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
