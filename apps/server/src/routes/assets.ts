import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
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
  try {
    const filename = sanitizeFilename(basename(request.body?.filename ?? "asset.bin"));
    const dataBase64 = request.body?.dataBase64;
    const kind = request.body?.kind ?? "file";
    if (!dataBase64) return reply.code(400).send({ error: "dataBase64 is required." });
    await mkdir(assetsDirectory, { recursive: true });
    const id = `asset_${randomUUID()}`;
    const path = join(assetsDirectory, `${id}-${filename}`);
    await writeFile(path, Buffer.from(dataBase64, "base64"));
    const metadata = await getLocalAssetMetadata(path, kind);
    return { id, path, metadata };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

}

function modelIconContentType(filename: string): string {
  if (/\.svg$/i.test(filename)) return "image/svg+xml";
  if (/\.webp$/i.test(filename)) return "image/webp";
  if (/\.gif$/i.test(filename)) return "image/gif";
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  return "image/png";
}
