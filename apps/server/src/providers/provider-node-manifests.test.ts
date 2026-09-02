import { describe, expect, it } from "vitest";
import { portableToolFromManifest } from "@snarkroute/nodes";
import { providerNodeManifests } from "./provider-node-manifests";

describe("provider portable tool manifests", () => {
  it("publishes a valid host-neutral MiniMax H3 schema without secrets", () => {
    const manifest = providerNodeManifests().find((candidate) => candidate.id === "minimax.h3.generate");
    expect(manifest).toBeDefined();
    const result = portableToolFromManifest(manifest!);
    expect(result.issues).toEqual([]);
    expect(result.tool).toMatchObject({ id: "minimax.h3.generate", metadata: { comfyUiRequired: false }, job: { selectableResults: true } });
    expect(JSON.stringify(result.tool)).not.toMatch(/H3_WORKER_SERVICE_TOKEN|MINIMAX_API_KEY/);
  });

  it("publishes local upscale for BoojumRoute and After Effects without secrets", () => {
    const manifest = providerNodeManifests().find((candidate) => candidate.id === "local_upscale");
    expect(manifest).toBeDefined();
    const result = portableToolFromManifest(manifest!);
    expect(result.issues).toEqual([]);
    expect(result.tool).toMatchObject({
      id: "local_upscale",
      metadata: { provider: "local_upscale", apiCost: 0, comfyUiRequired: false },
      hosts: expect.arrayContaining([expect.objectContaining({ host: "boojumroute" }), expect.objectContaining({ host: "after_effects" })]),
      job: { cancellable: true }
    });
    expect(JSON.stringify(result.tool)).not.toMatch(/LOCAL_UPSCALE_WORKER_TOKEN/);
  });

});
