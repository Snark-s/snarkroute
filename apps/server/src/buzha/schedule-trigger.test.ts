import { describe, expect, it } from "vitest";
import { BUZHA_EXTERNAL_SCHEDULES, normalizeBuzhaOccurrence, nextBuzhaRun } from "./schedules";
describe("one external trigger occurrence", () => {
  it("normalizes the same Moscow/UTC occurrence to one stable source key", () => {
    const id=BUZHA_EXTERNAL_SCHEDULES.flows[0].automationId;
    expect(normalizeBuzhaOccurrence(id,"2026-10-30T03:07:50+03:00")).toEqual(normalizeBuzhaOccurrence(id,"2026-10-30T00:07:50Z"));
    expect(()=>normalizeBuzhaOccurrence(id,"2026-10-30T00:08:50Z")).toThrow();
    expect(()=>normalizeBuzhaOccurrence("foreign","2026-10-30T00:07:50Z")).toThrow();
  });
  it("preserves Stockholm nominal time including winter, summer and DST", () => {
    const id=BUZHA_EXTERNAL_SCHEDULES.flows[1].automationId;
    expect(normalizeBuzhaOccurrence(id,"2026-10-30T21:30:00Z").occurrence).toBe("2026-10-30T21:30:00.000Z");
    expect(normalizeBuzhaOccurrence(id,"2027-07-01T20:30:00Z").occurrence).toBe("2027-07-01T20:30:00.000Z");
    expect(()=>normalizeBuzhaOccurrence(id,"2027-07-01T21:30:00Z")).toThrow();
    expect(nextBuzhaRun("orders",new Date("2026-10-30T00:07:50Z"))).toBe("2026-10-30T01:07:50.000Z");
    expect(nextBuzhaRun("replies",new Date("2026-10-30T22:00:00Z"))).toBe("2026-10-31T21:30:00.000Z");
    expect(nextBuzhaRun("replies",new Date("2027-10-31T00:00:00Z"))).toBe("2027-10-31T21:30:00.000Z");
  });
});
