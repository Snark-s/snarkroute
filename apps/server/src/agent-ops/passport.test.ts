import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry, agentBrief } from "./agents";
import { DECISIONS_DOC, PASSPORT_DOC, passportBriefLine, readPassportVersion } from "./passport";
import { AGENT_OPS_INSTRUCTIONS } from "../mcp/agent-ops-tools";

const dirs: string[] = [];
async function fixture(content?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "passport-"));
  dirs.push(root);
  if (content !== undefined) {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "workshop-passport.json"), content);
  }
  return root;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("workshop passport in the agent brief (D-12)", () => {
  it("reads the version from docs/workshop-passport.json at runtime", async () => {
    expect(readPassportVersion(await fixture(JSON.stringify({ passportVersion: "9.9.9-test" })))).toBe("9.9.9-test");
  });

  it("returns null instead of throwing when the file is missing or malformed", async () => {
    expect(readPassportVersion(await fixture())).toBeNull();
    expect(readPassportVersion(await fixture("{ not json"))).toBeNull();
    expect(readPassportVersion(await fixture(JSON.stringify({ passportVersion: "  " })))).toBeNull();
  });

  it("names both documents and the version, and says so when the version is unknown", () => {
    const line = passportBriefLine("9.9.9-test");
    expect(line).toContain(PASSPORT_DOC);
    expect(line).toContain(DECISIONS_DOC);
    expect(line).toContain("passport version 9.9.9-test");
    expect(passportBriefLine(null)).toContain("passport version unavailable");
  });

  it("every agent brief carries the passport pointer with the repository's real version", () => {
    const registry = new AgentRegistry([]);
    const brief = agentBrief(registry.app("tove", "Tove"));
    expect(brief).toContain("WORKSHOP-PASSPORT.md");
    const version = readPassportVersion();
    expect(version).not.toBeNull();
    expect(brief).toContain(`passport version ${version}`);
  });

  it("MCP server instructions point every client at the passport", () => {
    expect(AGENT_OPS_INSTRUCTIONS).toContain("WORKSHOP-PASSPORT.md");
  });
});
