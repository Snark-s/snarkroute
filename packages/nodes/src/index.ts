import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve, join } from "node:path";
import type { NodeRunner, RouteExecutor } from "@snarkroute/executor";

export interface NodeDefinition {
  type: string;
  title: string;
  description: string;
}

export const builtInNodeDefinitions: NodeDefinition[] = [
  { type: "input.text", title: "Text Input", description: "Produces a text value from params.value." },
  { type: "input.file", title: "Input File", description: "Reads metadata for a local file path." },
  { type: "input.image", title: "Input Image", description: "Reads metadata and dimensions for a local image path." },
  { type: "input.video", title: "Input Video", description: "Reads metadata for a local video path." },
  { type: "transform.template", title: "Template Transform", description: "Produces text from params.template after route template resolution." },
  { type: "debug.log", title: "Debug Log", description: "Logs a message or value and passes the value through." },
  { type: "output.file", title: "Output File", description: "Writes text or JSON to the local run folder." }
];

export const inputTextRunner: NodeRunner = ({ params }) => ({
  output: {
    text: String(params.value ?? "")
  }
});

export const inputFileRunner: NodeRunner = async ({ params }) => ({
  output: await getLocalAssetMetadata(String(params.path ?? ""), "file")
});

export const inputImageRunner: NodeRunner = async ({ params }) => ({
  output: await getLocalAssetMetadata(String(params.path ?? ""), "image")
});

export const inputVideoRunner: NodeRunner = async ({ params }) => ({
  output: await getLocalAssetMetadata(String(params.path ?? ""), "video")
});

export const transformTemplateRunner: NodeRunner = ({ params }) => ({
  output: {
    text: String(params.template ?? "")
  }
});

export const debugLogRunner: NodeRunner = ({ params, context }) => {
  const value = params.value ?? params.message ?? null;
  const message = params.message ? String(params.message) : JSON.stringify(value);
  context.log(message, undefined);
  return {
    output: { value },
    logs: [message]
  };
};

export const outputFileRunner: NodeRunner = async ({ params, inputs, context }) => {
  const filename = sanitizeFilename(basename(String(params.filename ?? "output.json")));
  const from = params.from ?? firstInputValue(inputs) ?? {};
  const path = join(context.outputDirectory, filename);
  const data = typeof from === "string" ? from : JSON.stringify(from, null, 2);
  await writeFile(path, data, "utf8");
  return {
    output: {
      path,
      filename,
      contentPreview: data.length > 500 ? `${data.slice(0, 500)}...` : data
    },
    logs: [`Wrote ${filename}`]
  };
};

export function registerBuiltInNodeRunners(executor: RouteExecutor): void {
  executor.registerNodeRunner("input.text", inputTextRunner);
  executor.registerNodeRunner("input.file", inputFileRunner);
  executor.registerNodeRunner("input.image", inputImageRunner);
  executor.registerNodeRunner("input.video", inputVideoRunner);
  executor.registerNodeRunner("transform.template", transformTemplateRunner);
  executor.registerNodeRunner("debug.log", debugLogRunner);
  executor.registerNodeRunner("output.file", outputFileRunner);
}

export type LocalAssetKind = "file" | "image" | "video";

export interface LocalAssetMetadata {
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
}

export async function getLocalAssetMetadata(path: string, kind: LocalAssetKind): Promise<LocalAssetMetadata> {
  if (!path.trim()) throw new Error(`${kind} input requires params.path.`);
  const resolvedPath = resolve(path);
  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    throw new Error(`Local ${kind} file was not found: ${resolvedPath}`);
  }
  if (!fileStat.isFile()) throw new Error(`Local ${kind} path is not a file: ${resolvedPath}`);

  const mimeType = getMimeType(resolvedPath);
  if (kind === "image" && !mimeType.startsWith("image/")) {
    throw new Error(`input.image expected an image file, got ${mimeType}: ${resolvedPath}`);
  }
  if (kind === "video" && !mimeType.startsWith("video/")) {
    throw new Error(`input.video expected a video file, got ${mimeType}: ${resolvedPath}`);
  }

  const metadata: LocalAssetMetadata = {
    path: resolvedPath,
    filename: basename(resolvedPath),
    mimeType,
    sizeBytes: fileStat.size
  };

  if (kind === "image") {
    const dimensions = readImageDimensions(await readFile(resolvedPath), mimeType);
    metadata.width = dimensions.width;
    metadata.height = dimensions.height;
  }

  return metadata;
}

function firstInputValue(inputs: Record<string, unknown>): unknown {
  const first = Object.values(inputs)[0];
  if (first && typeof first === "object" && "text" in first) return (first as { text: unknown }).text;
  return first;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function getMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo"
  };
  return mimeTypes[ext] ?? "application/octet-stream";
}

function readImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } {
  if (mimeType === "image/png") {
    if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") throw new Error("Invalid PNG image.");
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === "image/jpeg") return readJpegDimensions(buffer);
  if (mimeType === "image/webp") return readWebpDimensions(buffer);
  throw new Error(`Unsupported image metadata format: ${mimeType}. Supported formats: png, jpg, webp.`);
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("Could not read JPEG dimensions.");
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("Invalid WebP image.");
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }
  if (chunk === "VP8 ") {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }
  if (chunk === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }
  throw new Error("Could not read WebP dimensions.");
}
