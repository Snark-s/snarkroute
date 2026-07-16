import { describe, expect, it } from "vitest";
import { filterExecutableVideoModels } from "./catalog";
import type { VideoModel } from "../types";
const base: VideoModel = { id: "m", provider: "polza", providerModelId: "m", displayName: "M", inputTypes: ["text", "image"], outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"], availability: { status: "available", configured: true }, parameters: [], nodeType: "polza.video.generate", storedModelId: "m" };
describe("filterExecutableVideoModels", () => { it("keeps only configured generator models executable by the current video node", () => { expect(filterExecutableVideoModels([base, { ...base, id: "up", roles: ["upscaler"] }, { ...base, id: "text", outputTypes: ["text"] }, { ...base, id: "off", availability: { status: "unavailable" } }], "image-to-video").map((model) => model.id)).toEqual(["m"]); }); });
