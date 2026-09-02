import { createExecutor } from "@snarkroute/executor";
import { createGeminiLlmNodeRunner, createNanoBanana2NodeRunner } from "@snarkroute/gemini";
import { createH3NodeRunner } from "@snarkroute/h3";
import { createLocalUpscaleNodeRunner } from "@snarkroute/local-upscale";
import { createLocalVideoUpscaleNodeRunner } from "@snarkroute/local-video-upscale";
import { registerBuiltInNodeRunners, registerInstalledNodeRunners } from "@snarkroute/nodes";
import { createClarityUpscalerNodeRunner, createReplicateNodeRunner } from "@snarkroute/replicate";
import { createModelResolver, createOpenRouterVideoNodeRunner } from "@snarkroute/openrouter";
import { createPolzaImageNodeRunner, createPolzaTextNodeRunner, createPolzaVideoNodeRunner } from "@snarkroute/polza";
import { createKieNodeRunner } from "@snarkroute/kie";
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
  executor.registerNodeRunner("minimax.h3.generate", createH3NodeRunner());
  executor.registerNodeRunner("local_upscale", createLocalUpscaleNodeRunner());
  executor.registerNodeRunner("local_video_upscale", createLocalVideoUpscaleNodeRunner());
  executor.registerNodeRunner("polza.text", createPolzaTextNodeRunner());
  executor.registerNodeRunner("polza.image.generate", createPolzaImageNodeRunner());
  executor.registerNodeRunner("polza.video.generate", createPolzaVideoNodeRunner());
  executor.registerNodeRunner("ai.text", createRemoteTextNodeRunner(modelResolver));
  executor.registerNodeRunner("ai.image.generate", createRemoteImageNodeRunner(modelResolver));
  const openRouterVideoRunner = createOpenRouterVideoNodeRunner();
  const polzaVideoRunner = createPolzaVideoNodeRunner();
  const kieVideoRunner = createKieNodeRunner("video.generate");
  executor.registerNodeRunner("ai.video.generate", (input) => {
    const executionProvider = String(input.params.executionProvider ?? input.params.provider ?? "openrouter");
    const providerModelId = String(input.params.providerModelId ?? input.params.model ?? "");
    const forwarded = { ...input, params: { ...input.params, model: providerModelId, providerModelId } };
    if (executionProvider === "kie") return kieVideoRunner(forwarded);
    if (executionProvider === "polza") return polzaVideoRunner(forwarded);
    return openRouterVideoRunner(forwarded);
  });
  return executor;
}
