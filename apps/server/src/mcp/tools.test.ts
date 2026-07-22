import { describe, expect, it } from "vitest";
import { parseSrt } from "./tools";

describe("SRT parser", () => {
  it("keeps unicode and cue duration", () => expect(parseSrt("1\n00:00:01,000 --> 00:00:03,500\nПривет, мир!\n")).toEqual([{ start: 1, duration: 2.5, text: "Привет, мир!" }]));
});
