import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createExecutor } from "@snarkroute/executor";
import { registerBuiltInNodeRunners } from "@snarkroute/nodes";
import { loadRouteFromYaml } from "@snarkroute/protocol";
import { createReplicateNodeRunner } from "@snarkroute/replicate";

dotenv.config();

const routePath = join(process.cwd(), "examples", "routes", "replicate-flux-basic.route.yaml");

async function main() {
  if (!process.env.REPLICATE_API_TOKEN?.trim()) {
    throw new Error("REPLICATE_API_TOKEN is not configured. Add it to the local .env file as REPLICATE_API_TOKEN=your_token_here.");
  }

  const route = loadRouteFromYaml(await readFile(routePath, "utf8"));
  const model = String(route.nodes.find((node) => node.id === "generate_image")?.params?.model ?? "");
  const runId = `smoke_replicate_${Date.now()}`;
  const outputDirectory = join(process.cwd(), "data", "runs", runId);

  const executor = createExecutor();
  registerBuiltInNodeRunners(executor);
  executor.registerNodeRunner("replicate.model", createReplicateNodeRunner());

  const result = await executor.executeRoute(route, { runId, outputDirectory });
  const replicateOutput = result.nodeResults.generate_image?.output as
    | { predictionId?: string; output?: unknown; status?: string; webUrl?: string }
    | undefined;
  const fileOutput = result.nodeResults.save_output?.output as
    | { path?: string; filename?: string; contentPreview?: string }
    | undefined;

  const report = {
    runId: result.runId,
    status: result.status,
    model,
    predictionId: replicateOutput?.predictionId,
    outputPath: fileOutput?.path,
    contentPreview: fileOutput?.contentPreview ?? previewValue(replicateOutput?.output ?? replicateOutput?.webUrl),
    startedAt: result.startedAt,
    completedAt: result.completedAt
  };

  console.log(JSON.stringify(report, null, 2));

  if (result.status !== "succeeded" || replicateOutput?.status !== "succeeded") {
    const failedNodes = Object.values(result.nodeResults)
      .filter((node) => node.status === "failed")
      .map((node) => ({ nodeId: node.nodeId, type: node.type, error: node.error, logs: node.logs }));
    console.error(JSON.stringify({ failedNodes, logs: result.logs }, null, 2));
    process.exit(1);
  }
}

function previewValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
