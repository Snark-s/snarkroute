import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OWNER_REASONS } from "./types";

/**
 * D-03 guard: a task may stop for the owner only through TaskService.block(), which accepts one of
 * the four allowed reasons. Any direct transition to "blocked" elsewhere would reopen dead ends.
 */
describe("D-03: no dead ends", () => {
  const source = readFileSync(join(__dirname, "tasks.ts"), "utf8");

  it("enters the blocked state only inside block()", () => {
    const direct = [...source.matchAll(/setState\([^,()]+,\s*"blocked"|\.state\s*=\s*"blocked"/g)].map(match => source.slice(0, match.index).split("\n").length);
    expect(direct).toHaveLength(1);
    const blockStart = source.indexOf("private async block(");
    const blockEnd = source.indexOf("\n  }", blockStart);
    const line = (offset: number) => source.slice(0, offset).split("\n").length;
    expect(direct[0]).toBeGreaterThan(line(blockStart));
    expect(direct[0]).toBeLessThan(line(blockEnd + 1));
  });

  it("allows exactly the four owner reasons", () => {
    expect([...OWNER_REASONS].sort()).toEqual(["external_barrier", "needs_money", "owner_decision", "unobtainable_info"]);
  });
});
