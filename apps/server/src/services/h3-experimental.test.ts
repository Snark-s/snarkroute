import { describe, expect, it } from "vitest";
import { H3_QUEUE_OPERATIONS } from "./h3-queue";
import { generationInputForH3QueueItem } from "./h3-session-runtime";

describe("H3 experimental queue mapping", () => {
  it("supports local still operation without modifying stock video", () => {
    expect(H3_QUEUE_OPERATIONS).toContain("still_image");
    const still = generationInputForH3QueueItem({
      operation: "still_image", prompt: "blue sphere", duration: 4,
      aspectRatio: "16:9", variants: 1, renderMode: "preview",
      modelVariant: "h3_base"
    }, []);
    expect(still.outputMode).toBe("still");
    expect(still.vaeMode).toBe("stock");
    const video = generationInputForH3QueueItem({
      operation: "text_to_video", prompt: "blue sphere", duration: 5,
      aspectRatio: "16:9", variants: 1, renderMode: "preview",
      modelVariant: "h3_base"
    }, []);
    expect(video.outputMode).toBe("video");
    expect(video.vaeMode).toBe("stock");
  });
  it("preserves opt-in X2 selection for video rendering", () => {
    const request = generationInputForH3QueueItem({
      operation: "text_to_video", prompt: "blue sphere", duration: 5,
      aspectRatio: "16:9", variants: 1, renderMode: "preview",
      modelVariant: "h3_base", vaeMode: "x2"
    }, []);
    expect(request.vaeMode).toBe("x2");
  });
});
