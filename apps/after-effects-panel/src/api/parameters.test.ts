import { describe, expect, it } from "vitest";
import { gatewayParameters } from "./parameters";
describe("gatewayParameters", () => { it("drops unknown and invalid values while preserving schema ids", () => { expect(gatewayParameters([{ id: "duration", type: "number" }, { id: "enabled", type: "boolean" }, { id: "resolution", type: "select", options: [{ value: "720p" }] }], { duration: "5", enabled: true, resolution: "4k", secret: "no" })).toEqual({ duration: 5, enabled: true }); }); });
