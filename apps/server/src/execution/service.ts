import { createExecutor } from "@snarkroute/executor";
import { createGeminiLlmNodeRunner, createNanoBanana2NodeRunner } from "@snarkroute/gemini";
import { registerBuiltInNodeRunners, registerInstalledNodeRunners } from "@snarkroute/nodes";
import { createClarityUpscalerNodeRunner, createReplicateNodeRunner } from "@snarkroute/replicate";
import { createModelResolver } from "@snarkroute/openrouter";
import { createRemoteImageNodeRunner, createRemoteTextNodeRunner, loadOpenRouterMappings } from "../providers/openrouter";
export async function createRouteExecutor() {
  const executor = createExecutor();
  registerBuiltInNodeRunners(executor);
  await registerInstalledNodeRunners(executor);
  executor.registerNodeRunner("output.text", ({ params, inputs }) => {
    const from = params.from ?? Object.values(inputs)[0] ?? "";
    const text = typeof from === "string" ? from : JSON.stringify(from, null, 2);
    return { output: { text } };
  });
  const modelResolver = createModelResolver(await loadOpenRouterMappings());
  executor.registerNodeRunner("replicate.model", createReplicateNodeRunner());
  executor.registerNodeRunner("replicate.clarity-upscaler", createClarityUpscalerNodeRunner());
  executor.registerNodeRunner("gemini.llm", createGeminiLlmNodeRunner());
  executor.registerNodeRunner("gemini.nano-banana-2", createNanoBanana2NodeRunner());
  executor.registerNodeRunner("ai.text", createRemoteTextNodeRunner(modelResolver));
  executor.registerNodeRunner("ai.image.generate", createRemoteImageNodeRunner(modelResolver));
  return executor;
}