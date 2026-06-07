import { describe, expect, it } from "vitest";
import { modelLogoFor } from "../src/modelLogos";

describe("Living Canvas model logos", () => {
  it("uses the actual model owner logo when models are routed through Polza", () => {
    expect(modelLogoFor("polza", "wan/2.6").label).toBe("Wan");
    expect(modelLogoFor("polza", "bytedance/seedance-2").label).toBe("ByteDance");
    expect(modelLogoFor("polza", "topaz/video-upscale").label).toBe("Topaz Labs");
    expect(modelLogoFor("polza", "black-forest-labs/flux.2-pro").label).toBe("Black Forest Labs");
  });
});
