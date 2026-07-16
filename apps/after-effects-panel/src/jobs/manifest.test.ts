import { describe, expect, it } from "vitest";
import { serializeGenerationManifest } from "./manifest";
describe("manifest", () => { it("serializes stable generation metadata", () => { const text = serializeGenerationManifest({ jobId: "j", modelId: "m", provider: "polza", capability: "video.generate", prompt: "move", params: {}, inputs: [], createdAt: "now", estimatedCost: null, actualCost: null, manifestPath: "x.json" }); expect(JSON.parse(text)).toMatchObject({ jobId: "j", modelId: "m", estimatedCost: null }); }); });
