import { createExecutor } from "@snarkroute/executor";
import { createGeminiLlmNodeRunner, createNanoBanana2NodeRunner } from "@snarkroute/gemini";
import { createH3HostedNodeRunner, createH3NodeRunner, parseH3ModelVariant } from "@snarkroute/h3";
import { createLocalUpscaleNodeRunner } from "@snarkroute/local-upscale";
import { createNativeFlux3NodeRunner } from "../providers/flux3-native";
import { createProductionVideoUpscaleNodeRunner } from "../services/video-upscale";
import { registerBuiltInNodeRunners } from "@snarkroute/nodes";
import { createClarityUpscalerNodeRunner, createReplicate3DNodeRunner, createReplicateNodeRunner } from "@snarkroute/replicate";
import { createModelResolver, createOpenRouterVideoNodeRunner } from "@snarkroute/openrouter";
import { createPolzaImageNodeRunner, createPolzaTextNodeRunner, createPolzaVideoNodeRunner } from "@snarkroute/polza";
import { createKieNodeRunner } from "@snarkroute/kie";
import { createTripoRetopologyNodeRunner, createTripoSegmentNodeRunner, createTripoTextureNodeRunner, createTripoRigNodeRunner } from "@snarkroute/tripo";
import { createRemoteImageNodeRunner, createRemoteTextNodeRunner, guardProviderRunner, loadModelRouteMappings } from "./model-gateway-runners";
import { getCanvasActionsDirectory } from "../canvas-actions/service";
import { withLocalRuntimeLease } from "../agent-ops";
import { registerPolicyGuardedInstalledNodeRunners } from "./installed-runner-policy";

export async function createRouteExecutor() {
  const executor = createExecutor();
  registerBuiltInNodeRunners(executor);
  await registerPolicyGuardedInstalledNodeRunners(executor);
  await registerPolicyGuardedInstalledNodeRunners(executor, getCanvasActionsDirectory());
  executor.registerNodeRunner("output.text", ({ params, inputs }) => {
    const from = params.from ?? Object.values(inputs)[0] ?? "";
    const text = typeof from === "string" ? from : JSON.stringify(from, null, 2);
    return { output: { text } };
  });
  const modelResolver = createModelResolver(await loadModelRouteMappings());
  executor.registerNodeRunner("replicate.model", guardProviderRunner("replicate", createReplicateNodeRunner()));
  executor.registerNodeRunner("replicate.clarity-upscaler", guardProviderRunner("replicate", createClarityUpscalerNodeRunner()));
  executor.registerNodeRunner("ai.3d.generate", guardProviderRunner("replicate", createReplicate3DNodeRunner()));
  executor.registerNodeRunner("ai.model.retopology", guardProviderRunner("tripo", createTripoRetopologyNodeRunner()));
  executor.registerNodeRunner("ai.model.segment", guardProviderRunner("tripo", createTripoSegmentNodeRunner()));
  executor.registerNodeRunner("ai.model.texture", guardProviderRunner("tripo", createTripoTextureNodeRunner()));
  executor.registerNodeRunner("ai.model.rig", guardProviderRunner("tripo", createTripoRigNodeRunner()));
  executor.registerNodeRunner("gemini.llm", guardProviderRunner("gemini", createGeminiLlmNodeRunner()));
  executor.registerNodeRunner("gemini.nano-banana-2", guardProviderRunner("gemini", createNanoBanana2NodeRunner()));
  const localH3Runner = createH3NodeRunner();
  const hostedH3Runner = createH3HostedNodeRunner();
  const localUpscaleRunner = createLocalUpscaleNodeRunner();
  const productionH3Runner = async (input: Parameters<typeof localH3Runner>[0]) => {
    const variant = parseH3ModelVariant(input.params.modelVariant ?? input.params.providerModelId ?? input.params.model);
    if (variant === "h3_max" || variant === "h3_max_turbo") {
      return guardProviderRunner("minimax-h3", hostedH3Runner)({ ...input, params: { ...input.params, model: variant, modelVariant: variant } });
    }
    return withLocalRuntimeLease("h3", undefined, async () => localH3Runner({ ...input, params: { ...input.params, modelVariant: variant } }));
  };
  executor.registerNodeRunner("minimax.h3.generate", productionH3Runner);
  executor.registerNodeRunner("local_upscale", async input => {
    return withLocalRuntimeLease("upscale", undefined, async () => localUpscaleRunner(input));
  });
  const localVideoUpscaleRunner = createProductionVideoUpscaleNodeRunner();
  executor.registerNodeRunner("local_video_upscale", async input => {
    return withLocalRuntimeLease("upscale", undefined, async () => localVideoUpscaleRunner(input));
  });
  executor.registerNodeRunner("polza.text", guardProviderRunner("polza", createPolzaTextNodeRunner()));
  executor.registerNodeRunner("polza.image.generate", guardProviderRunner("polza", createPolzaImageNodeRunner()));
  executor.registerNodeRunner("polza.video.generate", guardProviderRunner("polza", createPolzaVideoNodeRunner()));
  executor.registerNodeRunner("ai.text", createRemoteTextNodeRunner(modelResolver));
  executor.registerNodeRunner("ai.image.generate", createRemoteImageNodeRunner(modelResolver));
  executor.registerNodeRunner("flux3.native.generate", createNativeFlux3NodeRunner());
  const openRouterVideoRunner = guardProviderRunner("openrouter", createOpenRouterVideoNodeRunner());
  const polzaVideoRunner = guardProviderRunner("polza", createPolzaVideoNodeRunner());
  const kieVideoRunner = guardProviderRunner("kie", createKieNodeRunner("video.generate"));
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
