import { describe, expect, it } from "vitest";
import { BUZHA_EXTERNAL_SCHEDULES, buzhaSchedules } from "./schedules";
describe("external Buzha schedules", () => {
  it("keeps external IDs, source timezone and disabled local ownership", () => {
    const value = buzhaSchedules(JSON.stringify(BUZHA_EXTERNAL_SCHEDULES));
    expect(value.owner).toBe("chatgpt"); expect(value.localEnabled).toBe(false);
    expect(value.flows[1].automationId).toBe("6ae3454528e881919edcc240c68fa2f9");
    expect(value.flows[1].schedule.sourceTimezone).toBe("Europe/Stockholm");
    expect(value.flows[1].schedule.mode).toBe("flexible_schedule");
  });
  it("represents Stockholm in Moscow through winter, summer and DST transition", () => {
    expect(buzhaSchedules(null, new Date("2026-10-30T10:00Z")).flows[1].schedule.currentMoscow).toContain("31.10.2026, 00:30");
    expect(buzhaSchedules(null, new Date("2026-07-01T10:00Z")).flows[1].schedule.currentMoscow).toContain("01.07.2026, 23:30");
    expect(buzhaSchedules(null, new Date("2026-10-25T10:00Z")).flows[1].schedule.currentMoscow).toContain("26.10.2026, 00:30");
  });
});
