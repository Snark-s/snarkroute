from pathlib import Path
p=Path(r"Y:\Процесс\SnarkRoute\packages\adapters\replicate\src\index.ts")
s=p.read_text(encoding="utf-8")
s=s.replace('import { extname, join } from "node:path";','import { basename, extname, join } from "node:path";')

marker='''export interface DownloadedImageAsset {
  originalUrl: string;
  localPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceNodeId: string;
  predictionId: string;
}
'''
insert=marker+'''
export interface DownloadedModelAsset {
  originalUrl: string;
  localPath: string;
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceNodeId: string;
  predictionId: string;
}
'''
if marker not in s: raise SystemExit("DownloadedImageAsset marker missing")
s=s.replace(marker,insert)

needle='''export function createReplicateProviderAdapter(options: ReplicateClientOptions = {}): ProviderAdapter {
'''
runner=r'''export function createReplicate3DNodeRunner(options: ReplicateClientOptions = {}): NodeRunner {
  return async ({ node, params, context }) => {
    const model = String(params.providerModelId ?? params.model ?? "tencent/hunyuan-3d-3.1").trim();
    if (!model) throw new Error("ai.3d.generate requires a Replicate model id.");

    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
    const images = Array.isArray(params.images) ? params.images : [];
    const firstImage = images[0];
    const input: Record<string, unknown> = {};

    if (firstImage) input.image = await prepareImageValue(firstImage);
    else if (prompt) input.prompt = prompt;
    else throw new Error("3D generation requires either a prompt or one image.");

    if (firstImage && prompt) {
      // Hunyuan 3D 3.1 accepts either prompt OR image. The image is the
      // stronger geometric constraint, so keep it and omit prompt.
    }

    const faceCount = Number(params.face_count ?? params.faceCount ?? 500000);
    if (Number.isFinite(faceCount)) input.face_count = Math.max(40000, Math.min(1500000, Math.round(faceCount)));
    input.enable_pbr = Boolean(params.enable_pbr ?? params.enablePbr ?? true);
    input.generate_type = String(params.generate_type ?? params.generateType ?? "Normal");

    const client = createReplicateClient(options);
    const result = await client.runPrediction(model, input, {
      pollingIntervalMs: Number(params.pollingIntervalMs ?? 1000),
      timeoutMs: Number(params.timeoutMs ?? 900000)
    });
    if (result.status !== "succeeded") {
      throw new Error(`Replicate 3D prediction ${result.status}: ${result.error ?? "unknown error"}`);
    }

    const originalUrl = firstImageUrl(result.output);
    if (!originalUrl) throw new Error("Replicate 3D generation succeeded but returned no downloadable model URL.");
    const modelAsset = await downloadPredictionModel(originalUrl, {
      outputDirectory: context.outputDirectory,
      sourceNodeId: node.id,
      predictionId: result.predictionId,
      fetchImpl: options.fetchImpl
    });
    const cost = estimateReplicateCost(result.metrics, params.estimated_usd_per_second);
    return {
      output: {
        model: modelAsset,
        models: [modelAsset],
        predictionId: result.predictionId,
        status: result.status,
        metrics: result.metrics,
        cost,
        provider: "replicate",
        model
      },
      logs: [`Downloaded Replicate 3D output to ${modelAsset.localPath}`],
      metrics: result.metrics,
      provenance: { provider: "replicate", model },
      providerUsage: replicateProviderUsage(result, node.id, node.type)
    };
  };
}

'''
if needle not in s: raise SystemExit("provider adapter marker missing")
s=s.replace(needle,runner+needle)

needle2='''function parseModel(model: string): [string, string] {
'''
download=r'''export async function downloadPredictionModel(
  url: string,
  options: { outputDirectory: string; sourceNodeId: string; predictionId: string; fetchImpl?: typeof fetch }
): Promise<DownloadedModelAsset> {
  const fetcher = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not download Replicate 3D output from ${url}: ${message}.`);
  }
  if (!response.ok) throw new Error(`Could not download Replicate 3D output (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "model/gltf-binary";
  const urlPath = new URL(url).pathname;
  const rawExt = extname(urlPath).toLowerCase();
  const ext = rawExt === ".glb" || rawExt === ".gltf" ? rawExt : ".glb";
  const assetsDirectory = join(options.outputDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const filename = `${options.sourceNodeId}-${options.predictionId}${ext}`;
  const localPath = join(assetsDirectory, filename);
  await writeFile(localPath, buffer);
  const metadata: DownloadedModelAsset = {
    originalUrl: url,
    localPath,
    path: localPath,
    filename,
    mimeType: contentType === "application/octet-stream" ? "model/gltf-binary" : contentType,
    sizeBytes: buffer.byteLength,
    sourceNodeId: options.sourceNodeId,
    predictionId: options.predictionId
  };
  await writeFile(join(assetsDirectory, `${filename}.json`), JSON.stringify(metadata, null, 2), "utf8");
  return metadata;
}

'''
if needle2 not in s: raise SystemExit("parseModel marker missing")
s=s.replace(needle2,download+needle2)

p.write_text(s,encoding="utf-8")
print("patched replicate 3d runner")
