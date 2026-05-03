import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createExecutor } from "@snarkroute/executor";
import { registerBuiltInNodeRunners } from "@snarkroute/nodes";
import { loadRouteFromYaml } from "@snarkroute/protocol";
import { createClarityUpscalerNodeRunner } from "@snarkroute/replicate";

dotenv.config();

async function main() {
  if (!process.env.REPLICATE_API_TOKEN?.trim()) {
    console.error("live smoke:clarity failed because REPLICATE_API_TOKEN is missing. Add it to .env or Studio Settings.");
    process.exit(1);
  }

  const routePath = join(process.cwd(), "examples", "routes", "clarity-upscale-basic.route.yaml");
  const route = loadRouteFromYaml(await readFile(routePath, "utf8"));
  const runId = `smoke_clarity_${Date.now()}`;
  const outputDirectory = join(process.cwd(), "data", "runs", runId);

  const executor = createExecutor();
  registerBuiltInNodeRunners(executor);
  executor.registerNodeRunner("replicate.clarity-upscaler", createClarityUpscalerNodeRunner());

  const result = await executor.executeRoute(route, { runId, outputDirectory });
  const upscale = result.nodeResults.upscale?.output as
    | { predictionId?: string; status?: string; originalUrl?: string; localPath?: string; image?: { originalUrl?: string; localPath?: string } }
    | undefined;
  const outputText = result.nodeResults.output_text?.output as { text?: string } | undefined;

  console.log(
    JSON.stringify(
      {
        runId: result.runId,
        predictionId: upscale?.predictionId,
        status: result.status,
        originalUrl: upscale?.image?.originalUrl ?? upscale?.originalUrl,
        localPath: upscale?.image?.localPath ?? upscale?.localPath,
        outputPreview: outputText?.text?.slice(0, 240),
        startedAt: result.startedAt,
        completedAt: result.completedAt
      },
      null,
      2
    )
  );

  if (result.status !== "succeeded" || upscale?.status !== "succeeded") {
    console.error(JSON.stringify({ failedNodes: result.nodeResults, logs: result.logs }, null, 2));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
