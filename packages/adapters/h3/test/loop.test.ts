import { describe, expect, it } from "vitest";
import { serializeH3Request } from "../src/index";

describe("H3 seamless loop adapter", () => {
  it("is disabled by default and explicitly serialized when selected", () => {
    expect(serializeH3Request({ prompt: "a rotating moon", duration: 5 }))
      .not.toHaveProperty("seamless_loop");
    expect(serializeH3Request({
      prompt: "a rotating moon", duration: 5, seamlessLoop: true,
    })).toMatchObject({
      task: "t2va", seamless_loop: true, loop_views: 2, loop_pad_clips: 1,
    });
  });

  it("passes supported view and pad settings", () => {
    expect(serializeH3Request({
      prompt: "continuous nebula", duration: 6, seamlessLoop: true,
      loopViews: 1, loopPadClips: 2,
    })).toMatchObject({ seamless_loop: true, loop_views: 1, loop_pad_clips: 2 });
  });

  it("rejects incompatible inputs before sending a job", () => {
    expect(() => serializeH3Request({
      prompt: "an animated wave", duration: 13, seamlessLoop: true,
    })).toThrow("up to 12.75");
    expect(() => serializeH3Request({
      prompt: "a still moon", duration: 5, seamlessLoop: true, outputMode: "still",
    })).toThrow("seamless loops");
    expect(() => serializeH3Request({
      prompt: "a doorway", duration: 5, seamlessLoop: true,
      references: [{ kind: "image", role: "firstFrame", uri: "file:///data/first.png" }],
    })).toThrow("seamless loops");
  });
});
