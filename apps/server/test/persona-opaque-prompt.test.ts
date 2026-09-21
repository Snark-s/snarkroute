import { describe, expect, it } from "vitest";
import { extractTemplateReferences } from "@snarkroute/executor";
import { decodeOpaquePromptParams } from "../src/execution/model-gateway-runners";

describe("Jabberwock opaque prompts", () => {
  it("keeps user template-like code out of route interpolation", () => {
    const prompt = "Keep {{input.output.text}} as literal user code.";
    const params = { promptBase64: Buffer.from(prompt, "utf8").toString("base64"), model: "example" };
    expect(extractTemplateReferences(params)).toEqual([]);
    expect(decodeOpaquePromptParams(params)).toEqual({ prompt, model: "example" });
  });

  it("rejects malformed opaque prompt data", () => {
    expect(() => decodeOpaquePromptParams({ promptBase64: "%%%" })).toThrow(/Invalid opaque prompt/);
  });
});
