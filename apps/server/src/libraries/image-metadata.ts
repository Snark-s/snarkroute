export const imageProvenanceFormat = "snarkroute.image-provenance";
export const imageProvenanceVersion = "0.1";

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

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngKeyword = "snarkroute.provenance";
const xmpHeader = "http://ns.adobe.com/xap/1.0/\0";
const xmpNamespace = "https://snarkroute.local/ns/image-provenance/0.1/";

export function embedImageProvenance(buffer: Buffer, extension: string, provenance: SnarkImageProvenance): Buffer {
  const json = JSON.stringify(provenance);
  if (extension === ".png") return embedPngText(buffer, json);
  if (extension === ".jpg" || extension === ".jpeg") return embedJpegXmp(buffer, json);
  if (extension === ".webp") return embedWebpXmp(buffer, json);
  throw new Error(`Cannot embed SnarkRoute provenance in image format "${extension}".`);
}

export function extractImageProvenance(buffer: Buffer, extension: string): SnarkImageProvenance | undefined {
  let json: string | undefined;
  if (extension === ".png") json = extractPngText(buffer);
  if (extension === ".jpg" || extension === ".jpeg") json = extractJpegXmp(buffer);
  if (extension === ".webp") json = extractWebpXmp(buffer);
  if (!json) return undefined;
  const parsed = JSON.parse(json) as SnarkImageProvenance;
  return parsed.format === imageProvenanceFormat && parsed.version === imageProvenanceVersion ? parsed : undefined;
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
    if (type === "iTXt" && data.toString("latin1", 0, pngKeyword.length) === pngKeyword && data[pngKeyword.length] === 0) {
      return data.subarray(pngKeyword.length + 5).toString("utf8");
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
