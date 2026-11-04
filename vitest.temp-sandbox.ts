import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every vitest run gets its own temp folder; everything the tests put into os.tmpdir() goes there
 * and the whole folder is removed when the run ends. Tests that forget their own cleanup can no
 * longer leave a growing tail in the owner's %TEMP% (found 04.11.2026: hundreds of test folders).
 */
export default function setup() {
  const sandbox = join(tmpdir(), `snarkroute-vitest-${process.pid}-${Date.now()}`);
  mkdirSync(sandbox, { recursive: true });
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = sandbox;
  return () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}
