import { describe, expect, it } from "vitest";
import { resolveSessionMediaUrls, serializeToolInputs, type SessionRunResponse } from "./api.js";

describe("Brandeshmyg session media URLs", () => {
  it("resolves server-relative API media URLs against apiBase", () => {
    const response: SessionRunResponse = {
      status: "completed",
      previews: [
        { kind: "panorama360", src: "/api/assets/preview?kind=image&path=preview.png" }
      ],
      results: [
        { id: "image:0", outputId: "image", type: "image", label: "image", url: "/api/assets/preview?kind=image&path=result.png" },
        { id: "image:1", outputId: "image", type: "image", label: "remote", url: "https://cdn.example/result.png" },
        { id: "text:0", outputId: "text", type: "text", label: "text", text: "done" }
      ]
    };

    expect(resolveSessionMediaUrls(response, "http://127.0.0.1:4317/")).toEqual({
      ...response,
      previews: [
        { kind: "panorama360", src: "http://127.0.0.1:4317/api/assets/preview?kind=image&path=preview.png" }
      ],
      results: [
        { ...response.results[0], url: "http://127.0.0.1:4317/api/assets/preview?kind=image&path=result.png" },
        response.results[1],
        response.results[2]
      ]
    });
  });
});

describe("Brandeshmyg session inputs", () => {
  it("serializes every named action input", async () => {
    await expect(serializeToolInputs({
      prompt: { kind: "text", type: "text", text: "Move from first frame to last frame" },
      negativePrompt: { kind: "text", type: "text", text: "blur" }
    })).resolves.toEqual({
      prompt: { type: "text", text: "Move from first frame to last frame" },
      negativePrompt: { type: "text", text: "blur" }
    });
  });
});
