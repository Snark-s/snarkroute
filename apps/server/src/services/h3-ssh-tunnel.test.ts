import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveH3SshPrivateKeyPath } from "./h3-ssh-tunnel";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("H3 SSH tunnel", () => {
  it("accepts an existing explicitly configured private key", () => {
    const directory = mkdtempSync(join(tmpdir(), "h3-ssh-key-"));
    directories.push(directory);
    const key = join(directory, "id_ed25519");
    writeFileSync(key, "test key");
    expect(existsSync(key)).toBe(true);
    expect(resolveH3SshPrivateKeyPath(key)).toBe(key);
  });

  it("fails closed for a missing explicitly configured private key", () => {
    expect(resolveH3SshPrivateKeyPath(join(tmpdir(), "missing-h3-key"))).toBe("");
  });
});
