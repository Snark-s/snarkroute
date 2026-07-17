import { describe, expect, it } from "vitest";
import { gatewayParameters, parameterDiagnostics, parameterValidationReasons } from "./parameters";
describe("gatewayParameters", () => {
  it("drops unknown and invalid values while preserving schema ids", () => { expect(gatewayParameters([{ id: "duration", type: "number" }, { id: "enabled", type: "boolean" }, { id: "resolution", type: "select", options: [{ value: "720p" }] }], { duration: "5", enabled: true, resolution: "4k", secret: "no" })).toEqual({ duration: 5, enabled: true }); });
  it("blocks any missing schema-derived required parameter", () => { expect(parameterValidationReasons([{ id: "aspect_ratio", label: "Aspect ratio", type: "select", required: true, options: [{ value: "16:9" }] }, { id: "sound", type: "select", required: true, options: [{ value: "true" }, { value: "false" }] }], { sound: "false" })).toEqual(["Aspect ratio is required"]); });
  it("redacts secret-like schema fields from diagnostics", () => { expect(parameterDiagnostics({ aspect_ratio: "16:9", api_key: "secret" })).toEqual({ aspect_ratio: "16:9", api_key: "[redacted]" }); });
});
