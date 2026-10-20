import { describe, expect, it } from "vitest";
import { auditGitRepository, compareBackupCoverage, dryRunDeployment } from "./sentinel-audit";

describe("sentinel read-only audits", () => {
  it("reports dirty, stale, diverged and Codex worktree state without mutating git", async () => {
    const calls: string[][] = [];
    const runGit = async (_repository: string, args: string[]) => {
      calls.push(args);
      const command = args.join(" ");
      if (command === "branch --show-current") return "rebuild/2026-10-20\n";
      if (command.startsWith("status ")) return " M apps/server/src/services/sentinel.ts\n?? docs/audit.md\n";
      if (command.startsWith("for-each-ref")) return "main\t2026-10-20T08:00:00+03:00\nold\t2026-10-01T08:00:00+03:00\n";
      if (command.includes("rev-list") && command.includes("old")) return "2\t1\n";
      if (command.startsWith("worktree list")) return "worktree Y:/rebuild/SnarkRoute\nHEAD abc\nbranch refs/heads/rebuild/2026-10-20\n\nworktree Y:/rebuild/codex-copy\nHEAD def\nbranch refs/heads/codex/audit\n";
      throw new Error(`unexpected git command: ${command}`);
    };
    const report = await auditGitRepository("Y:/rebuild/SnarkRoute", { now: new Date("2026-10-20T12:00:00+03:00"), runGit });
    expect(report).toMatchObject({ dirty: true, mainBranch: "main", branch: "rebuild/2026-10-20" });
    expect(report.staleBranches.map(item => item.branch)).toEqual(["old"]);
    expect(report.divergedBranches).toEqual([{ branch: "old", ahead: 1, behind: 2 }]);
    expect(report.codexWorktrees).toHaveLength(1);
    expect(calls.every(args => args[0] !== "merge" && args[0] !== "reset")).toBe(true);
  });

  it("keeps secrets out of coverage and deployment dry run", () => {
    const inventory = [
      { id: "repo", category: "repository" as const, path: "SnarkRoute" },
      { id: "env", category: "config" as const, path: ".env", sensitive: true },
      { id: "sqlite", category: "sqlite" as const, path: "data/app.sqlite" }
    ];
    const coverage = compareBackupCoverage(inventory, new Set(["repo"]));
    expect(coverage.covered.map(item => item.id)).toEqual(["repo"]);
    expect(coverage.notCovered.map(item => item.id)).toEqual(["sqlite"]);
    expect(coverage.secretsExcluded.map(item => item.id)).toEqual(["env"]);
    expect(dryRunDeployment(inventory, "D:/backup")).toMatchObject([
      { id: "repo", action: "restore", executed: false },
      { id: "env", action: "reference-only", executed: false },
      { id: "sqlite", action: "restore", executed: false }
    ]);
  });
});
