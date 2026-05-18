import type { FastifyInstance } from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtInNodeManifests,
  formatIssues,
  getInstalledNodesDirectory,
  installNodePackageFromArchive,
  installNodePackageFromManifest,
  isSupportedRemoteUrl,
  loadInstalledNodeManifests,
  packNodePackage,
  previewNodePackageArchive,
  setInstalledNodeEnabled,
  uninstallInstalledNode,
  validateNodeLibraryManifest,
  validateNodeManifest,
  type SnarkNodeManifest
} from "@snarkroute/nodes";
import { allReservedNodeIds, providerNodeManifests } from "../providers/provider-node-manifests";
import { errorMessage, nodePackageUninstallErrorShape } from "../services/errors";
import { fetchRemoteBytes, fetchRemoteJson, isSnarkNodeArchiveFilename, nodePackagePreviewErrorMessage, normalizeNodePackageUpload, packageWarnings, parseUploadedNodeManifestJson, unsupportedNodePackageMessage } from "../node-packages/service";

export async function registerNodePackageRoutes(app: FastifyInstance) {
app.get("/api/node-packages/installed", async () => ({
  installedDirectory: getInstalledNodesDirectory(),
  nodes: await loadInstalledNodeManifests()
}));

app.post<{ Body: { filename?: string; fileName?: string; manifest?: unknown; text?: string; dataBase64?: string } }>("/api/node-packages/preview", async (request, reply) => {
  try {
    const upload = normalizeNodePackageUpload(request.body);
    if (upload.mode === "archive") {
      const preview = await previewNodePackageArchive(upload.data, { source: upload.filename, existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
      return { ok: true, ...preview };
    }
    if (upload.mode === "unsupported") return reply.code(400).send({ ok: false, issues: [{ path: upload.filename, message: unsupportedNodePackageMessage(upload.filename) }] });
    const manifest = request.body?.manifest ?? parseUploadedNodeManifestJson(upload.text);
    const validation = validateNodeManifest(manifest, { existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
    return validation.ok ? { ok: true, manifest: validation.manifest, warnings: packageWarnings(validation.manifest!) } : validation;
  } catch (error) {
    const filename = request.body?.filename ?? request.body?.fileName ?? "<upload>";
    return reply.code(400).send({ ok: false, issues: [{ path: filename, message: nodePackagePreviewErrorMessage(filename, error) }] });
  }
});

app.post<{ Body: { manifest?: unknown; text?: string; dataBase64?: string; filename?: string; fileName?: string; source?: string; files?: Array<{ path: string; dataBase64?: string; text?: string }> } }>("/api/node-packages/install", async (request, reply) => {
  try {
    const upload = normalizeNodePackageUpload(request.body, request.body?.source);
    if (upload.mode === "archive") {
      const installed = await installNodePackageFromArchive(upload.data, { source: request.body.source ?? upload.filename, origin: "installed", overwrite: true });
      return { ok: true, manifest: installed };
    }
    if (upload.mode === "unsupported") return reply.code(400).send({ ok: false, issues: [{ path: upload.filename, message: unsupportedNodePackageMessage(upload.filename) }] });
    const manifest = request.body?.manifest ?? parseUploadedNodeManifestJson(upload.text);
    const duplicateValidation = validateNodeManifest(manifest, { existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
    if (!duplicateValidation.ok) return reply.code(400).send(duplicateValidation);
    const installed = await installNodePackageFromManifest(duplicateValidation.manifest!, {
      source: request.body?.source ?? "local-file",
      files: request.body?.files,
      overwrite: true
    });
    return { ok: true, manifest: installed };
  } catch (error) {
    const filename = request.body?.source ?? request.body?.filename ?? request.body?.fileName ?? "<upload>";
    return reply.code(400).send({ ok: false, issues: [{ path: filename, message: nodePackagePreviewErrorMessage(filename, error) }] });
  }
});

app.post<{ Body: { manifest?: unknown } }>("/api/node-packages/install-generated", async (request, reply) => {
  try {
    const validation = validateNodeManifest({ ...(request.body?.manifest as object), origin: "generated", source: "snarkroute-studio" });
    if (!validation.ok || !validation.manifest) return reply.code(400).send(validation);
    const installed = await installNodePackageFromManifest(validation.manifest, {
      source: "snarkroute-studio",
      origin: "generated",
      overwrite: true
    });
    return { ok: true, manifest: installed };
  } catch (error) {
    return reply.code(400).send({ ok: false, error: errorMessage(error) });
  }
});

app.post<{ Body: { path?: string } }>("/api/node-packages/install-path", async (request, reply) => {
  try {
    const packagePath = request.body?.path?.trim() ?? "";
    if (!packagePath) return reply.code(400).send({ ok: false, error: "path is required." });
    const { installNodePackageFromPath } = await import("@snarkroute/nodes");
    const installed = await installNodePackageFromPath(packagePath, { overwrite: true });
    return { ok: true, manifest: installed };
  } catch (error) {
    return reply.code(400).send({ ok: false, error: errorMessage(error) });
  }
});

app.post<{ Body: { url?: string } }>("/api/node-packages/preview-url", async (request, reply) => {
  try {
    const url = request.body?.url?.trim() ?? "";
    if (!isSupportedRemoteUrl(url)) return reply.code(400).send({ ok: false, error: "URL must be http or https." });
    if (isSnarkNodeArchiveFilename(url)) {
      const preview = await previewNodePackageArchive(await fetchRemoteBytes(url), { source: url, origin: "remote", existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
      return { ok: true, ...preview };
    }
    const json = await fetchRemoteJson(url);
    if ((json as { kind?: string }).kind === "snarkroute.nodeLibrary") {
      const validation = validateNodeLibraryManifest({ ...(json as object), source: url });
      return validation.ok ? { ok: true, library: validation.library } : validation;
    }
    const validation = validateNodeManifest({ ...(json as object), source: url, origin: "remote" }, { existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
    return validation.ok ? { ok: true, manifest: validation.manifest, warnings: packageWarnings(validation.manifest!) } : validation;
  } catch (error) {
    return reply.code(400).send({ ok: false, error: errorMessage(error) });
  }
});

app.post<{ Body: { url?: string } }>("/api/node-packages/install-url", async (request, reply) => {
  try {
    const url = request.body?.url?.trim() ?? "";
    if (!isSupportedRemoteUrl(url)) return reply.code(400).send({ ok: false, error: "URL must be http or https." });
    if (isSnarkNodeArchiveFilename(url)) {
      const installed = await installNodePackageFromArchive(await fetchRemoteBytes(url), { source: url, origin: "installed", overwrite: true });
      return { ok: true, manifest: installed };
    }
    const json = await fetchRemoteJson(url);
    const validation = validateNodeManifest({ ...(json as object), source: url, origin: "remote" }, { existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
    if (!validation.ok || !validation.manifest) return reply.code(400).send(validation);
    const installed = await installNodePackageFromManifest(validation.manifest, { source: url, origin: "installed", overwrite: true });
    return { ok: true, manifest: installed };
  } catch (error) {
    return reply.code(400).send({ ok: false, error: errorMessage(error) });
  }
});

app.post<{ Body: { libraryUrl?: string; nodeIds?: string[] } }>("/api/node-packages/install-library", async (request, reply) => {
  try {
    const libraryUrl = request.body?.libraryUrl?.trim() ?? "";
    if (!isSupportedRemoteUrl(libraryUrl)) return reply.code(400).send({ ok: false, error: "Library URL must be http or https." });
    const libraryValidation = validateNodeLibraryManifest({ ...((await fetchRemoteJson(libraryUrl)) as object), source: libraryUrl });
    if (!libraryValidation.ok || !libraryValidation.library) return reply.code(400).send(libraryValidation);
    const selected = new Set(request.body?.nodeIds ?? []);
    const installed: SnarkNodeManifest[] = [];
    for (const entry of libraryValidation.library.nodes.filter((node) => selected.has(node.id))) {
      if (isSnarkNodeArchiveFilename(entry.url)) {
        const manifest = await installNodePackageFromArchive(await fetchRemoteBytes(entry.url), { source: entry.url, origin: "installed", overwrite: true });
        installed.push(manifest);
        continue;
      }
      const json = await fetchRemoteJson(entry.url);
      const validation = validateNodeManifest({ ...(json as object), source: entry.url, origin: "remote" }, { existingIds: allReservedNodeIds([...(await loadInstalledNodeManifests()), ...installed]) });
      if (!validation.ok || !validation.manifest) throw new Error(`Invalid node "${entry.id}": ${formatIssues(validation.issues)}`);
      installed.push(await installNodePackageFromManifest(validation.manifest, { source: entry.url, origin: "installed", overwrite: true }));
    }
    return { ok: true, installed };
  } catch (error) {
    return reply.code(400).send({ ok: false, error: errorMessage(error) });
  }
});

app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/node-packages/:id/enabled", async (request, reply) => {
  try {
    return { ok: true, manifest: await setInstalledNodeEnabled(request.params.id, Boolean(request.body?.enabled)) };
  } catch (error) {
    return reply.code(404).send({ ok: false, error: errorMessage(error) });
  }
});

app.delete<{ Params: { id: string } }>("/api/node-packages/:id", async (request, reply) => {
  const id = request.params.id;
  const bundled = [...builtInNodeManifests, ...providerNodeManifests()].find((manifest) => manifest.id === id && manifest.origin === "bundled");
  if (bundled) return reply.code(400).send({ ok: false, code: "NODE_PACKAGE_NOT_UNINSTALLABLE", error: `Bundled node "${id}" cannot be deleted.` });
  try {
    await uninstallInstalledNode(id);
    return { ok: true, id, message: `Uninstalled node package "${id}".` };
  } catch (error) {
    const uninstallError = nodePackageUninstallErrorShape(error);
    if (uninstallError) {
      return reply.code(uninstallError.statusCode).send({ ok: false, code: uninstallError.code, error: uninstallError.message });
    }
    return reply.code(500).send({ ok: false, code: "NODE_PACKAGE_DELETE_FAILED", error: errorMessage(error) });
  }
});

app.get<{ Params: { id: string } }>("/api/node-packages/:id/export", async (request, reply) => {
  try {
    const installed = await loadInstalledNodeManifests();
    const manifest = [...builtInNodeManifests, ...providerNodeManifests(), ...installed].find((candidate) => candidate.id === request.params.id);
    if (!manifest) return reply.code(404).send({ ok: false, error: `Node package "${request.params.id}" was not found.` });

    if (manifest.origin !== "bundled") {
      const sourceDirectory = join(getInstalledNodesDirectory(), request.params.id.replace(/[^a-z0-9._-]/gi, "_"));
      const outputDirectory = await mkdtemp(join(tmpdir(), "snarknode-export-"));
      const outputPath = join(outputDirectory, `${request.params.id.replace(/[^a-z0-9._-]/gi, "_")}.snarknode`);
      try {
        const packed = await packNodePackage(sourceDirectory, outputPath);
        return {
          ok: true,
          filename: `${packed.manifest.id}.snarknode`,
          contentType: "application/octet-stream",
          dataBase64: (await readFile(packed.outputPath)).toString("base64")
        };
      } finally {
        await rm(outputDirectory, { recursive: true, force: true });
      }
    }

    return {
      ok: true,
      filename: `${manifest.id}.node.json`,
      contentType: "application/json",
      text: `${JSON.stringify(manifest, null, 2)}\n`
    };
  } catch (error) {
    return reply.code(400).send({ ok: false, error: errorMessage(error) });
  }
});

app.get<{ Params: { id: string } }>("/api/node-packages/:id/readme", async (request, reply) => {
  try {
    const path = join(getInstalledNodesDirectory(), request.params.id.replace(/[^a-z0-9._-]/gi, "_"), "README.md");
    return { ok: true, path, text: await readFile(path, "utf8") };
  } catch (error) {
    return reply.code(404).send({ ok: false, error: errorMessage(error) });
  }
});
}


