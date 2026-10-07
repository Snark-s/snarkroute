import { createExecutor } from "@snarkroute/executor";
import { createGeminiLlmNodeRunner, createNanoBanana2NodeRunner } from "@snarkroute/gemini";
import { createH3HostedNodeRunner, createH3NodeRunner, parseH3ModelVariant } from "@snarkroute/h3";
import { createLocalUpscaleNodeRunner } from "@snarkroute/local-upscale";
import { createProductionVideoUpscaleNodeRunner } from "../services/video-upscale";
import { registerBuiltInNodeRunners, registerInstalledNodeRunners } from "@snarkroute/nodes";
import { createClarityUpscalerNodeRunner, createReplicate3DNodeRunner, createReplicateNodeRunner } from "@snarkroute/replicate";
import { createModelResolver, createOpenRouterVideoNodeRunner } from "@snarkroute/openrouter";
import { createPolzaImageNodeRunner, createPolzaTextNodeRunner, createPolzaVideoNodeRunner } from "@snarkroute/polza";
import { createKieNodeRunner } from "@snarkroute/kie";
import { createTripoRetopologyNodeRunner, createTripoSegmentNodeRunner, createTripoTextureNodeRunner, createTripoRigNodeRunner } from "@snarkroute/tripo";
import { createRemoteImageNodeRunner, createRemoteTextNodeRunner, loadModelRouteMappings } from "./model-gateway-runners";
import { getCanvasActionsDirectory } from "../canvas-actions/service";
import { assertLocalRuntimeAdmission } from "../services/local-runtime-supervisor";

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
  executor.registerNodeRunner("ai.3d.generate", createReplicate3DNodeRunner());
  executor.registerNodeRunner("ai.model.retopology", createTripoRetopologyNodeRunner());
  executor.registerNodeRunner("ai.model.segment", createTripoSegmentNodeRunner());
  executor.registerNodeRunner("ai.model.texture", createTripoTextureNodeRunner());
  executor.registerNodeRunner("ai.model.rig", createTripoRigNodeRunner());
  executor.registerNodeRunner("gemini.llm", createGeminiLlmNodeRunner());
  executor.registerNodeRunner("gemini.nano-banana-2", createNanoBanana2NodeRunner());
  const localH3Runner = createH3NodeRunner();
  const hostedH3Runner = createH3HostedNodeRunner();
  const localUpscaleRunner = createLocalUpscaleNodeRunner();
  const productionH3Runner = async (input: Parameters<typeof localH3Runner>[0]) => {
    const variant = parseH3ModelVariant(input.params.modelVariant ?? input.params.providerModelId ?? input.params.model);
    if (variant === "h3_max" || variant === "h3_max_turbo") {
      return hostedH3Runner({ ...input, params: { ...input.params, modelVariant: variant } });
    }
    await assertLocalRuntimeAdmission("h3");
    return localH3Runner({ ...input, params: { ...input.params, modelVariant: variant } });
  };
  executor.registerNodeRunner("minimax.h3.generate", productionH3Runner);
  executor.registerNodeRunner("local_upscale", async input => {
    await assertLocalRuntimeAdmission("upscale");
    return localUpscaleRunner(input);
  });
  const localVideoUpscaleRunner = createProductionVideoUpscaleNodeRunner();
  executor.registerNodeRunner("local_video_upscale", async input => {
    await assertLocalRuntimeAdmission("upscale");
    return localVideoUpscaleRunner(input);
  });
  executor.registerNodeRunner("polza.text", createPolzaTextNodeRunner());
  executor.registerNodeRunner("polza.image.generate", createPolzaImageNodeRunner());
  executor.registerNodeRunner("polza.video.generate", createPolzaVideoNodeRunner());
  executor.registerNodeRunner("ai.text", createRemoteTextNodeRunner(modelResolver));
  executor.registerNodeRunner("ai.image.generate", createRemoteImageNodeRunner(modelResolver));
  const openRouterVideoRunner = createOpenRouterVideoNodeRunner();
  const polzaVideoRunner = createPolzaVideoNodeRunner();
  const kieVideoRunner = createKieNodeRunner("video.generate");
  const h3VideoRunner = productionH3Runner;
  executor.registerNodeRunner("ai.video.generate", (input) => {
    const executionProvider = String(input.params.executionProvider ?? input.params.provider ?? "openrouter");
    const providerModelId = String(input.params.providerModelId ?? input.params.model ?? "");
    const forwarded = { ...input, params: { ...input.params, model: providerModelId, providerModelId } };
    if (executionProvider === "kie") return kieVideoRunner(forwarded);
    if (executionProvider === "polza") return polzaVideoRunner(forwarded);
    if (executionProvider === "minimax-h3") return h3VideoRunner({ ...forwarded, params: { ...forwarded.params, modelVariant: providerModelId } });
    return openRouterVideoRunner(forwarded);
  });
  return executor;
}
