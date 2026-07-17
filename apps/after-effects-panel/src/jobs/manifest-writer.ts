import type { GenerationMetadata, ManifestWriteDiagnostic, ProjectFileContext } from "../types";
import { serializeGenerationManifest } from "./manifest";

type FileHandleLike = { writeFile(data: string, options: { encoding: "utf8" }): Promise<void>; close(): Promise<void> };
export type NodeFsPromisesLike = {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(path: string, flags: "w"): Promise<FileHandleLike>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean; size: number }>;
  unlink(path: string): Promise<void>;
};
export type NodePathLike = { join(...parts: string[]): string; dirname(path: string): string };
export type ManifestNodeRuntime = { fs: NodeFsPromisesLike; path: NodePathLike; env: Record<string, string | undefined> };

export async function generationDirectory(context: ProjectFileContext, runtime = loadCepNodeRuntime()): Promise<string> {
  if (context.saved && context.projectDirectory) return ensureDirectory(runtime.path.join(context.projectDirectory, "SnarkRoute Generations"), runtime);
  const appData = runtime.env.APPDATA || context.appDataPath;
  const temp = runtime.env.TEMP || runtime.env.TMP || context.tempPath;
  if (appData) {
    try { return await ensureDirectory(runtime.path.join(appData, "SnarkRoute Generations"), runtime); }
    catch { /* APPDATA may exist but be unwritable in the CEP process. */ }
  }
  if (!temp) throw new Error("Neither APPDATA nor TEMP is available for an unsaved After Effects project.");
  return ensureDirectory(runtime.path.join(temp, "SnarkRoute Generations"), runtime);
}

export async function writeGenerationManifest(metadata: GenerationMetadata, runtime = loadCepNodeRuntime()): Promise<ManifestWriteDiagnostic> {
  const manifestPath = metadata.manifestPath;
  const directoryPath = runtime.path.dirname(manifestPath);
  const tempPath = `${manifestPath}.tmp`;
  const diagnostic: ManifestWriteDiagnostic = { ok: false, manifestPath, outputPath: metadata.outputPath ?? manifestPath.replace(/\.json$/, ""), projectSaved: metadata.projectSaved ?? null, projectFilePath: metadata.projectFilePath ?? null, tempPath, directoryPath, directoryExists: false, mkdirResult: "not attempted", openResult: "not attempted", writeResult: "not attempted", closeResult: "not attempted", renameResult: "not attempted", finalExists: false, finalSize: 0, encoding: "utf8", fileError: "not applicable (CEP Node fs)" };
  let handle: FileHandleLike | undefined;
  try {
    try { await runtime.fs.mkdir(directoryPath, { recursive: true }); }
    catch (error) { diagnostic.mkdirResult = `failed: ${errorText(error)}`; throw error; }
    diagnostic.mkdirResult = "ok";
    diagnostic.directoryExists = (await runtime.fs.stat(directoryPath)).isDirectory();
    try { handle = await runtime.fs.open(tempPath, "w"); }
    catch (error) { diagnostic.openResult = `failed: ${errorText(error)}`; throw error; }
    diagnostic.openResult = "ok";
    try { await handle.writeFile(serializeGenerationManifest(metadata), { encoding: "utf8" }); }
    catch (error) { diagnostic.writeResult = `failed: ${errorText(error)}`; throw error; }
    diagnostic.writeResult = "ok";
    try { await handle.close(); }
    catch (error) { diagnostic.closeResult = `failed: ${errorText(error)}`; throw error; }
    handle = undefined;
    diagnostic.closeResult = "ok";
    try { await runtime.fs.rename(tempPath, manifestPath); }
    catch (error) { diagnostic.renameResult = `failed: ${errorText(error)}`; throw error; }
    diagnostic.renameResult = "ok";
    const final = await runtime.fs.stat(manifestPath);
    diagnostic.finalExists = true;
    diagnostic.finalSize = final.size;
    diagnostic.ok = final.size > 0;
    if (!diagnostic.ok) throw new Error("Manifest exists but is empty.");
  } catch (error) {
    const nodeError = error as { code?: string; message?: string };
    diagnostic.nodeErrorCode = nodeError.code || "unknown";
    diagnostic.nodeErrorMessage = nodeError.message || String(error);
    if (handle) {
      try { await handle.close(); diagnostic.closeResult = "ok after error"; }
      catch (closeError) { diagnostic.closeResult = `failed: ${errorText(closeError)}`; }
    }
    try { await runtime.fs.unlink(tempPath); } catch { /* best-effort cleanup */ }
  }
  return diagnostic;
}

export function manifestFailureText(diagnostic: ManifestWriteDiagnostic): string {
  return ["Manifest write failed", `Path: ${diagnostic.manifestPath}`, `Output path: ${diagnostic.outputPath}`, `Project saved: ${diagnostic.projectSaved === null ? "unknown" : diagnostic.projectSaved ? "yes" : "no"}`, `app.project.file: ${diagnostic.projectFilePath || "none"}`, `Directory exists: ${diagnostic.directoryExists ? "yes" : "no"}`, `mkdir result: ${diagnostic.mkdirResult}`, `Open result: ${diagnostic.openResult}`, `Write result: ${diagnostic.writeResult}`, `Close result: ${diagnostic.closeResult}`, `Rename result: ${diagnostic.renameResult}`, `File.error: ${diagnostic.fileError}`, `Node error code: ${diagnostic.nodeErrorCode || "none"}`, `Node error message: ${diagnostic.nodeErrorMessage || "none"}`].join("\n");
}

async function ensureDirectory(path: string, runtime: ManifestNodeRuntime): Promise<string> {
  await runtime.fs.mkdir(path, { recursive: true });
  if (!(await runtime.fs.stat(path)).isDirectory()) throw new Error(`Generation directory is not a directory: ${path}`);
  return path;
}

function loadCepNodeRuntime(): ManifestNodeRuntime {
  const root = globalThis as typeof globalThis & { require?: (id: string) => unknown; cep_node?: { require(id: string): unknown }; process?: { env?: Record<string, string | undefined> } };
  const requireModule = root.cep_node?.require?.bind(root.cep_node) ?? root.require;
  if (!requireModule) throw new Error("CEP Node runtime is unavailable. Ensure --enable-nodejs is active for this extension.");
  const nodeProcess = root.process ?? requireModule("process") as { env?: Record<string, string | undefined> };
  return { fs: requireModule("fs/promises") as NodeFsPromisesLike, path: requireModule("path") as NodePathLike, env: nodeProcess.env ?? {} };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
