import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { errorMark } from "./service-logs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function mark(path: string) {
  const stat = statSync(path);
  return errorMark(path, stat.size, stat.mtimeMs).mark;
}

describe("log error mark", () => {
  it("stays the same while a CRLF log grows with non-error lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "logmark-")); dirs.push(dir);
    const path = join(dir, "watchdog.log");
    writeFileSync(path, "checks passed\r\nsnarkbridge_tunnel is listening but unhealthy (1/2)\r\n+ FullyQualifiedErrorId : tunnel unhealthy\r\n");
    const first = mark(path);
    expect(first).toBeTruthy();
    for (let index = 0; index < 5; index++) appendFileSync(path, `checks passed ${index}\r\n`);
    expect(mark(path)).toBe(first);
  });

  it("changes when a new error is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "logmark-")); dirs.push(dir);
    const path = join(dir, "server.log");
    writeFileSync(path, "ok\nError: first failure\nok\n");
    const first = mark(path);
    appendFileSync(path, "Error: first failure\n");
    expect(mark(path)).not.toBe(first);
  });

  it("is stable when the error sits beyond a moving tail window", () => {
    const dir = mkdtempSync(join(tmpdir(), "logmark-")); dirs.push(dir);
    const path = join(dir, "big.log");
    writeFileSync(path, "x".repeat(70 * 1024) + "\r\nError: deep failure\r\n");
    const first = mark(path);
    appendFileSync(path, "fine\r\n".repeat(200));
    expect(mark(path)).toBe(first);
  });
});
