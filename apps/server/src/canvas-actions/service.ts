import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  getInstalledNodesDirectory,
  installNodePackageFromArchive,
  installNodePackageFromManifest,
  installNodePackageFromPath,
  loadInstalledNodeManifests,
  previewNodePackageArchive,
  uninstallInstalledNode,
  type SnarkNodeManifest
} from "@snarkroute/nodes";

function canvasActionDirectoryName(id: string): string {
  return id.replace(/[^a-z0-9._-]/gi, "_");
}

export function getCanvasActionsDirectory(): string {
  return process.env.SNARKROUTE_CANVAS_ACTIONS_PATH ?? join(process.cwd(), "data", "canvas-actions");
}

export async function loadCanvasActionManifests(): Promise<SnarkNodeManifest[]> {
  return loadInstalledNodeManifests(getCanvasActionsDirectory());
}

export async function preserveCanvasActionFromArchive(data: Buffer, source?: string): Promise<SnarkNodeManifest | null> {
  const preview = await previewNodePackageArchive(data, { source: source ?? "canvas-action", origin: "installed" });
  if (!isCanvasActionManifest(preview.manifest)) return null;
  const manifest = await installNodePackageFromArchive(data, {
    installedDirectory: getCanvasActionsDirectory(),
    source: source ?? "canvas-action",
    origin: "installed",
    overwrite: true
  });
  return manifest;
}

export async function preserveCanvasActionFromManifest(manifest: SnarkNodeManifest, options: { source?: string; files?: Array<{ path: string; dataBase64?: string; text?: string }> } = {}): Promise<SnarkNodeManifest | null> {
  if (!isCanvasActionManifest(manifest)) return null;
  return installNodePackageFromManifest(manifest, {
    installedDirectory: getCanvasActionsDirectory(),
    source: options.source ?? manifest.source ?? "canvas-action",
    origin: "installed",
    files: options.files,
    overwrite: true
  });
}

export async function preserveInstalledCanvasAction(id: string): Promise<SnarkNodeManifest | null> {
  const sourceDirectory = join(getInstalledNodesDirectory(), canvasActionDirectoryName(id));
  const targetDirectory = join(getCanvasActionsDirectory(), canvasActionDirectoryName(id));
  const manifests = await loadInstalledNodeManifests();
  const manifest = manifests.find((candidate) => candidate.id === id);
  if (!manifest || !isCanvasActionManifest(manifest)) return null;
  await mkdir(getCanvasActionsDirectory(), { recursive: true });
  await cp(sourceDirectory, targetDirectory, { recursive: true, force: true });
  return manifest;
}

export async function preserveCanvasActionFromPath(path: string): Promise<SnarkNodeManifest | null> {
  const manifest = await installNodePackageFromPath(path, {
    installedDirectory: getCanvasActionsDirectory(),
    overwrite: true
  });
  return isCanvasActionManifest(manifest) ? manifest : null;
}

export async function deleteCanvasActionPackage(id: string): Promise<void> {
  let removed = false;
  let notFoundError: unknown;
  for (const directory of [getCanvasActionsDirectory(), getInstalledNodesDirectory()]) {
    try {
      await uninstallInstalledNode(id, directory);
      removed = true;
    } catch (error) {
      if (error && typeof error === "object" && (error as { code?: unknown }).code === "NODE_PACKAGE_NOT_FOUND") {
        notFoundError ??= error;
        continue;
      }
      throw error;
    }
  }
  if (!removed) throw notFoundError;
}

function isCanvasActionManifest(manifest: SnarkNodeManifest): boolean {
  const surface = manifest.canvasAction?.surface;
  return manifest.enabled !== false
    && manifest.canvasAction?.enabled === true
    && manifest.inputs.length > 0
    && manifest.inputs.every((input) => isCanvasActionPortType(input.type))
    && (surface !== "livingCanvas" || manifest.inputs.length === 1)
    && manifest.outputs.length > 0
    && manifest.outputs.every((output) => isCanvasActionPortType(output.type));
}

function isCanvasActionPortType(value: string): boolean {
  return value === "image" || value === "video" || value === "audio" || value === "text";
}
