import { describe, expect, it } from "vitest";
import { providerNodeManifests } from "../src/providers/provider-node-manifests";
import { canvasActionParams } from "../src/routes/nodes";

describe("provider node manifests", () => {
  it("publishes select options used by the Polza video parameter UI", () => {
    const manifest = providerNodeManifests().find((candidate) => candidate.id === "polza.video.generate");
    expect(manifest?.params?.find((param) => param.id === "resolution")?.options).toEqual([
      { value: "720p" },
      { value: "1080p" }
    ]);
    expect(manifest?.params?.find((param) => param.id === "duration")?.options).toEqual([
      { value: "5", label: "5s" },
      { value: "10", label: "10s" }
    ]);
  });

  it("hydrates select options for existing generated actions", () => {
    const providers = providerNodeManifests();
    const source = providers.find((candidate) => candidate.id === "polza.video.generate")!;
    const action = {
      ...source,
      id: "existing.kling.action",
      params: [{
        id: "kling.resolution",
        type: "text",
        default: "720p",
        binding: { nodeId: "kling", paramId: "resolution" }
      }],
      generatedWith: {
        kind: "compound.subroute",
        subroute: { nodes: [{ id: "kling", type: "polza.video.generate" }] }
      }
    };

    expect(canvasActionParams(action, providers)[0]?.options).toEqual([
      { value: "720p" },
      { value: "1080p" }
    ]);
  });
});
