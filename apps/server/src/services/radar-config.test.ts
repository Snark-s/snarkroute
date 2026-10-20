import { describe, expect, it } from "vitest";
import { configuredRadars, DEFAULT_RADARS } from "./radar-config";

describe("configuredRadars", () => {
  it("keeps every radar off unless SNARKROUTE_RADARS names it", () => {
    expect(configuredRadars({}).every(radar => !radar.enabled)).toBe(true);
    expect(configuredRadars({ SNARKROUTE_RADARS: "all" }).every(radar => radar.enabled)).toBe(true);
    const one = configuredRadars({ SNARKROUTE_RADARS: "filmfreeway-festival-radar" });
    expect(one.filter(radar => radar.enabled).map(radar => radar.id)).toEqual(["filmfreeway-festival-radar"]);
    expect(DEFAULT_RADARS.every(radar => !radar.enabled)).toBe(true);
  });
});
