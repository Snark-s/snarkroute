import type { NodeRunner, RouteExecutor } from "@snarkroute/executor";
import { getInstalledNodesDirectory, loadInstalledNodeManifests, registerInstalledNodeRunners, type SnarkNodeManifest } from "@snarkroute/nodes";
import { assertModelInvocationPolicy, ModelRoutingPolicyError } from "../services/model-routing-policy";

export function guardInstalledNodeRunner(manifest: SnarkNodeManifest, runner: NodeRunner): NodeRunner {
  if (manifest.executor.type === "plugin") return async () => {
    throw new ModelRoutingPolicyError("UNSAFE_PLUGIN_EXECUTION_DISABLED", `Installed node "${manifest.id}" requires arbitrary JavaScript execution. Use a declarative node with explicit permissions.`);
  };
  const modelOperation = manifest.capabilities?.some(capability => /^(text|image|video|audio|model)\.(generate|edit|upscale|retopology|segment|texture|rig|transcribe)/.test(capability.id));
  if (manifest.executor.type !== "declarative.http" || !modelOperation) return runner;
  return async input => {
    // An installed manifest cannot acquire the identity/trust of a built-in
    // local provider by setting executionProvider or client-supplied pricing.
    await assertModelInvocationPolicy(`installed:${manifest.id}`, String(input.params.model ?? manifest.id), input.params, input.node.type, async () => []);
    return runner(input);
  };
}

export async function registerPolicyGuardedInstalledNodeRunners(executor: RouteExecutor, directory = getInstalledNodesDirectory()): Promise<void> {
  const manifests = new Map((await loadInstalledNodeManifests(directory)).map(manifest => [manifest.id, manifest]));
  await registerInstalledNodeRunners({ ...executor, registerNodeRunner(type, runner) {
    const manifest = manifests.get(type);
    executor.registerNodeRunner(type, manifest ? guardInstalledNodeRunner(manifest, runner) : runner);
  } }, directory);
}
