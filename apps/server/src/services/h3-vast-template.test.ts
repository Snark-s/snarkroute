import { describe, expect, it } from "vitest";
import { buildH3VastTemplateInput, H3_VAST_IMAGE_TAG, H3_VAST_SOURCE_REVISION } from "./h3-vast-template";

describe("H3 Vast template", () => {
  it("pins the source and runtime without embedding secrets or ComfyUI", () => {
    const template = buildH3VastTemplateInput();
    expect(template.tag).toBe(H3_VAST_IMAGE_TAG);
    expect(template.onstart).toContain(H3_VAST_SOURCE_REVISION);
    expect(template.onstart).toContain("bootstrap_vast_fl2va.sh");
    expect(template.onstart).toContain("H3_ACCEPT_MODEL_LICENSE");
    expect(template.extraFilters).toMatchObject({ cuda_max_good: { gte: 13.2 }, gpu_ram: { gte: 49_152 } });
    expect(`${template.env}\n${template.onstart}`).not.toMatch(/hf_[A-Za-z0-9]{10}|H3_WORKER_SERVICE_TOKEN=[A-Za-z0-9]/);
    expect(JSON.stringify(template)).not.toMatch(/ComfyUI|custom_nodes/i);
  });
});
