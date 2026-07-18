import { createExecutor } from "@snarkroute/executor";
import { createGeminiLlmNodeRunner, createNanoBanana2NodeRunner } from "@snarkroute/gemini";
import { registerBuiltInNodeRunners, registerInstalledNodeRunners } from "@snarkroute/nodes";
import { createClarityUpscalerNodeRunner, createReplicateNodeRunner } from "@snarkroute/replicate";
import { createModelResolver } from "@snarkroute/openrouter";
import { createPolzaImageNodeRunner, createPolzaTextNodeRunner, createPolzaVideoNodeRunner } from "@snarkroute/polza";
import { createRemoteImageNodeRunner, createRemoteTextNodeRunner, loadModelRouteMappings } from "./model-gateway-runners";
import { getCanvasActionsDirectory } from "../canvas-actions/service";
export async function createRouteExecutor() {
  const executor = createExecutor();
  registerBuiltInNodeRunners(executor);
  await registerInstalledNodeRunners(executor);
  await registerInstalledNodeRunners(executor, getCanvasActionsDirectory());
  executor.registerNodeRunner("output.text", ({ params, inputs }) => {
    const from = params.from ?? Object.values(inputs)[0] ?? "";
    const text = typeof from === "string" ? from : JSON.stringify(from, null, 2);
    return { output: { text } };
  });
  const modelResolver = createModelResolver(await loadModelRouteMappings());
  executor.registerNodeRunner("replicate.model", createReplicateNodeRunner());
  executor.registerNodeRunner("replicate.clarity-upscaler", createClarityUpscalerNodeRunner());
  executor.registerNodeRunner("gemini.llm", createGeminiLlmNodeRunner());
  executor.registerNodeRunner("gemini.nano-banana-2", createNanoBanana2NodeRunner());
  executor.registerNodeRunner("polza.text", createPolzaTextNodeRunner());
  executor.registerNodeRunner("polza.image.generate", createPolzaImageNodeRunner());
  executor.registerNodeRunner("polza.video.generate", createPolzaVideoNodeRunner());
  executor.registerNodeRunner("ai.text", createRemoteTextNodeRunner(modelResolver));
  executor.registerNodeRunner("ai.image.generate", createRemoteImageNodeRunner(modelResolver));
  return executor;
}
