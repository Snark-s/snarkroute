import { describe, expect, it } from "vitest";
import { ENGINE_CAPABILITIES, EngineRequirementsSchema } from "../src/index";

describe("EngineRequirements protocol", () => {
  it("parses provider-independent hard and preferred capabilities", () => {
    const requirements = EngineRequirementsSchema.parse({
      domain: "video",
      operation: "edit",
      inputs: { text: true, videoCount: 1, imageCount: 2 },
      requiredCapabilities: ["video.edit", "video.reference"],
      preferredCapabilities: ["video.preserve_motion"],
      constraints: { referenceCount: 2, durationSeconds: 15 }
    });

    expect(requirements.requiredCapabilities).toEqual(["video.edit", "video.reference"]);
    expect(ENGINE_CAPABILITIES).toContain("video.first_last_frame");
  });

  it("rejects an unknown capability instead of accepting arbitrary taxonomy drift", () => {
    expect(EngineRequirementsSchema.safeParse({
      requiredCapabilities: ["vendor.special_mode"],
      preferredCapabilities: []
    }).success).toBe(false);
  });
});
