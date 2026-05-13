import { builtInNodeManifests, type SnarkNodeManifest } from "@snarkroute/nodes";
import { allReservedNodeIds, providerNodeManifests } from "../providers/provider-node-manifests";
import { errorMessage } from "../services/errors";
import { fetchWithTimeout } from "../services/http";
export async function fetchRemoteJson(url: string): Promise<unknown> {
  const response = await fetchWithTimeout(url, 15000);
  const text = await response.text();
  if (!response.ok) throw new Error(`Fetch failed (${response.status}).`);
  return JSON.parse(text);
}

export async function fetchRemoteBytes(url: string): Promise<Buffer> {
  const response = await fetchWithTimeout(url, 15000);
  if (!response.ok) throw new Error(`Fetch failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

export function isSnarkNodeArchiveFilename(filename: string): boolean {
  return filename.toLowerCase().split("?")[0].endsWith(".snarknode");
}

export type NodePackageUpload =
  | { mode: "archive"; filename: string; data: Buffer }
  | { mode: "json"; filename: string; text: string }
  | { mode: "unsupported"; filename: string };

export function normalizeNodePackageUpload(
  body: { filename?: string; fileName?: string; manifest?: unknown; text?: string; dataBase64?: string } | undefined,
  source?: string
): NodePackageUpload {
  const providedFilename = source ?? body?.filename ?? body?.fileName;
  const filename = String(providedFilename ?? "local-file");
  const lower = filename.toLowerCase().split("?")[0];
  if (lower.endsWith(".snarknode")) {
    return { mode: "archive", filename, data: Buffer.from(body?.dataBase64 ?? "", "base64") };
  }
  if (lower.endsWith(".node.json") || lower.endsWith(".json") || (providedFilename === undefined && (body?.manifest !== undefined || body?.text !== undefined))) {
    return { mode: "json", filename, text: uploadedNodeManifestText(body) };
  }
  return { mode: "unsupported", filename };
}

function uploadedNodeManifestText(body: { text?: string; dataBase64?: string } | undefined): string {
  if (typeof body?.text === "string" && body.text.length > 0) return body.text;
  if (body?.dataBase64) return Buffer.from(body.dataBase64, "base64").toString("utf8");
  return "{}";
}

export function parseUploadedNodeManifestJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON node manifest.");
  }
}

export function nodePackagePreviewErrorMessage(filename: string, error: unknown): string {
  const message = errorMessage(error);
  if (isSnarkNodeArchiveFilename(filename) && isZipFormatError(message)) {
    return "Invalid .snarknode package: expected a ZIP archive. For a plain node manifest, use .node.json.";
  }
  return message;
}

function isZipFormatError(message: string): boolean {
  return /central directory|zip file|corrupted zip|end of data|invalid zip/i.test(message);
}

export function unsupportedNodePackageMessage(filename: string): string {
  return `Unsupported node package file type for "${filename}". Use .snarknode for packaged nodes or .node.json for plain node manifests.`;
}

export function packageWarnings(manifest: SnarkNodeManifest): string[] {
  const warnings: string[] = [];
  if (manifest.executor.type === "plugin") warnings.push("Contains executable plugin code. Review permissions before installing.");
  if (manifest.permissions.shell) warnings.push("Requests shell permission. This build refuses shell execution.");
  if (manifest.permissions.readFiles) warnings.push("Requests local file read permission.");
  if (manifest.permissions.network) warnings.push(`Requests network access${manifest.permissions.networkHosts?.length ? ` to ${manifest.permissions.networkHosts.join(", ")}` : ""}.`);
  return warnings;
}
