import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getLocalAssetMetadata, type LocalAssetKind } from "@snarkroute/nodes";
import { assetsDirectory } from "../server-paths";
import { browseLocalFile, sanitizeFilename } from "../assets/service";
import { errorMessage } from "../services/errors";

export async function registerAssetRoutes(app: FastifyInstance) {
app.get<{ Querystring: { path?: string; kind?: LocalAssetKind } }>("/api/assets/metadata", async (request, reply) => {
  try {
    return await getLocalAssetMetadata(request.query.path ?? "", request.query.kind ?? "file");
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.get<{ Querystring: { path?: string } }>("/api/assets/preview", async (request, reply) => {
  try {
    const metadata = await getLocalAssetMetadata(request.query.path ?? "", "image");
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
    const path = join(assetsDirectory, `${Date.now()}-${filename}`);
    await writeFile(path, Buffer.from(dataBase64, "base64"));
    const metadata = await getLocalAssetMetadata(path, kind);
    return { path, metadata };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

}
