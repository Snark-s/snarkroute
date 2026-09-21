import { describe, expect, it } from "vitest";
import { insertAtSelection } from "./H3QueuePanel";

describe("H3 prompt tag insertion", () => {
  it("inserts a media tag at the cursor", () => {
    expect(insertAtSelection("Use  for motion", "<Video 1>", 4, 4)).toEqual({
      value: "Use <Video 1> for motion",
      cursor: 13,
    });
  });

  it("replaces the selected prompt text", () => {
    expect(insertAtSelection("Use placeholder here", "<Picture 1>", 4, 15)).toEqual({
      value: "Use <Picture 1> here",
      cursor: 15,
    });
  });
});
