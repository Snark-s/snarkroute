import { describe, expect, it } from "vitest";
import { serializeH3Request } from "../src/index";

describe("MiniMax H3 optional image and X2 output modes", () => {
  const input = { prompt: "Blue glass sphere on black", duration: 4, renderMode: "preview" as const, inferenceSteps: 4 };
  it("preserves stock video request by default", () => {
    const request = serializeH3Request(input);
    expect(request.task).toBe("t2va");
    expect(request.output_mode).toBeUndefined();
    expect(request.vae_mode).toBeUndefined();
  });
  it("can request still image output with stock VAE", () => {
    const request = serializeH3Request({ ...input, outputMode: "still" });
    expect(request.output_mode).toBe("still");
    expect(request.vae_mode).toBeUndefined();
  });
  it("can request an opt-in X2 VAE for videos", () => {
    const request = serializeH3Request({ ...input, vaeMode: "x2" });
    expect(request.vae_mode).toBe("x2");
    expect(request.output_mode).toBeUndefined();
  });
  it("refuses untested X2-still combination", () => {
    expect(() => serializeH3Request({ ...input, outputMode: "still", vaeMode: "x2" })).toThrow("requires separate validation");
  });
});
