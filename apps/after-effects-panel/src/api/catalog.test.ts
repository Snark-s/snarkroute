import { describe, expect, it } from "vitest";
import { countModelFamilies, filterExecutableVideoModels } from "./catalog";
import type { VideoModel } from "../types";
const base: VideoModel = { id: "m", provider: "polza", providerModelId: "m", displayName: "M", inputTypes: ["text", "image"], outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"], availability: { status: "available", configured: true }, parameters: [], nodeType: "polza.video.generate", storedModelId: "m" };
describe("filterExecutableVideoModels", () => { it("keeps only configured generator models executable by the current video node", () => { expect(filterExecutableVideoModels([base, { ...base, id: "up", roles: ["upscaler"] }, { ...base, id: "text", outputTypes: ["text"] }, { ...base, id: "off", availability: { status: "unavailable" } }], "image-to-video").map((model) => model.id)).toEqual(["m"]); }); });

describe("endpoint model preservation", () => { it("keeps every executable model family returned by the endpoint", () => { const models = [base, { ...base, id: "happy", providerModelId: "alibaba/happyhorse-1.0", displayName: "HappyHorse" }]; const filtered = filterExecutableVideoModels(models, "image-to-video"); expect(filtered.map((model) => model.id)).toEqual(["m", "happy"]); expect(countModelFamilies(filtered)).toBe(2); }); });

describe("shared compatibility result", () => { it("does not reclassify a runnable model from missing legacy inputTypes", () => { expect(filterExecutableVideoModels([{ ...base, id: "seedance", inputTypes: [], runnableWithSuppliedInputs: true }], "image-to-video").map((model) => model.id)).toEqual(["seedance"]); }); });
