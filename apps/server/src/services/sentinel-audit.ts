import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitRunner = (repository: string, args: string[]) => Promise<string>;

export type GitAuditReport = {
  repository: string;
  branch?: string;
  dirty: boolean;
  dirtyPaths: string[];
  staleBranches: Array<{ branch: string; lastCommitAt: string }>;
  divergedBranches: Array<{ branch: string; ahead: number; behind: number }>;
  worktrees: Array<{ path: string; branch?: string }>;
  codexWorktrees: Array<{ path: string; branch?: string }>;
  mainBranch?: string;
  error?: string;
};

export type BackupInventoryItem = {
  id: string;
  category: "repository" | "service-data" | "sqlite" | "config" | "model" | "schedule";
  path: string;
  sensitive?: boolean;
};

export type BackupCoverage = {
  covered: BackupInventoryItem[];
  notCovered: BackupInventoryItem[];
  secretsExcluded: BackupInventoryItem[];
};

export type DeploymentDryRunStep = {
  id: string;
  action: "restore" | "reference-only" | "verify";
  source: string;
  destination: string;
  executed: false;
  note?: string;
};

export const defaultGitRunner: GitRunner = async (repository, args) => {
  const result = await execFileAsync("git", args, { cwd: repository, windowsHide: true, maxBuffer: 1_000_000 });
  return result.stdout;
};

export async function auditGitRepository(
  repository: string,
  options: { now?: Date; staleAfterDays?: number; runGit?: GitRunner } = {}
): Promise<GitAuditReport> {
  const runGit = options.runGit ?? defaultGitRunner;
  const now = options.now ?? new Date();
  const staleAfterDays = options.staleAfterDays ?? 14;
  try {
    const branch = clean(await runGit(repository, ["branch", "--show-current"]));
    const dirtyPaths = (await runGit(repository, ["status", "--porcelain", "--untracked-files=all"]))
      .split(/\r?\n/).filter(Boolean).map(line => line.slice(3).trim() || line.trim());
    const branchRows = parseBranchRows(await runGit(repository, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:iso-strict)", "refs/heads"]));
    const mainBranch = branchRows.some(row => row.branch === "main") ? "main" : branchRows.some(row => row.branch === "master") ? "master" : undefined;
    const staleBranches = branchRows.filter(row => now.getTime() - Date.parse(row.lastCommitAt) > staleAfterDays * 86_400_000);
    const divergedBranches: GitAuditReport["divergedBranches"] = [];
    if (mainBranch) {
      for (const row of branchRows) {
        if (row.branch === mainBranch) continue;
        const counts = clean(await runGit(repository, ["rev-list", "--left-right", "--count", `${mainBranch}...${row.branch}`])).split(/\s+/).map(Number);
        if (counts.length === 2 && counts.every(Number.isFinite) && (counts[0] !== 0 || counts[1] !== 0)) {
          divergedBranches.push({ branch: row.branch, behind: counts[0], ahead: counts[1] });
        }
      }
    }
    const worktrees = parseWorktrees(await runGit(repository, ["worktree", "list", "--porcelain"]));
    const codexWorktrees = worktrees.filter(worktree => /codex/i.test(`${worktree.path} ${worktree.branch ?? ""}`));
    return { repository, branch: branch || undefined, dirty: dirtyPaths.length > 0, dirtyPaths,
      staleBranches, divergedBranches, worktrees, codexWorktrees, ...(mainBranch ? { mainBranch } : {}) };
  } catch (error) {
    return { repository, dirty: false, dirtyPaths: [], staleBranches: [], divergedBranches: [], worktrees: [], codexWorktrees: [], error: errorMessage(error) };
  }
}

export function compareBackupCoverage(inventory: readonly BackupInventoryItem[], backedUpIds: ReadonlySet<string>): BackupCoverage {
  const covered: BackupInventoryItem[] = [];
  const notCovered: BackupInventoryItem[] = [];
  const secretsExcluded: BackupInventoryItem[] = [];
  for (const item of inventory) {
    if (item.sensitive) { secretsExcluded.push(item); continue; }
    (backedUpIds.has(item.id) ? covered : notCovered).push(item);
  }
  return { covered, notCovered, secretsExcluded };
}

/** Plans a restore without touching files, credentials, processes, or schedules. */
export function dryRunDeployment(inventory: readonly BackupInventoryItem[], destinationRoot: string): DeploymentDryRunStep[] {
  return inventory.map(item => ({
    id: item.id,
    action: item.sensitive ? "reference-only" : "restore",
    source: item.path,
    destination: `${destinationRoot.replace(/[\\/]$/, "")}/${item.path.replace(/^[\\/]+/, "")}`,
    executed: false,
    ...(item.sensitive ? { note: "Secret stays outside the backup and must be provisioned by the owner." } : {})
  }));
}

export function renderGitAuditMarkdown(reports: readonly GitAuditReport[], capturedAt = new Date().toISOString()): string {
  const lines = [`# Git audit`, ``, `Captured: ${capturedAt}`, ``];
  for (const report of reports) {
    lines.push(`## ${report.repository}`);
    if (report.error) { lines.push(`- Error: ${report.error}`, ``); continue; }
    lines.push(`- Branch: ${report.branch ?? "(detached)"}`, `- Dirty: ${report.dirty ? "yes" : "no"}`);
    if (report.dirtyPaths.length) lines.push(`- Uncommitted paths: ${report.dirtyPaths.join(", ")}`);
    lines.push(`- Main: ${report.mainBranch ?? "not found"}`, `- Stale branches (>14d): ${report.staleBranches.map(item => item.branch).join(", ") || "none"}`);
    lines.push(`- Diverged from main: ${report.divergedBranches.map(item => `${item.branch} (ahead ${item.ahead}, behind ${item.behind})`).join(", ") || "none"}`);
    lines.push(`- Codex worktrees: ${report.codexWorktrees.map(item => item.path).join(", ") || "none"}`, ``);
  }
  return `${lines.join("\n")}\n`;
}

export function renderBackupCoverageMarkdown(coverage: BackupCoverage, dryRun: readonly DeploymentDryRunStep[]): string {
  const itemLine = (item: BackupInventoryItem) => `- ${item.id} (${item.category}): ${item.path}`;
  return [
    `# Backup coverage`, ``, `## Covered`, ``, ...(coverage.covered.length ? coverage.covered.map(itemLine) : [`- none`]),
    ``, `## Not covered`, ``, ...(coverage.notCovered.length ? coverage.notCovered.map(itemLine) : [`- none`]),
    ``, `## Secrets excluded from open backup`, ``, ...(coverage.secretsExcluded.length ? coverage.secretsExcluded.map(itemLine) : [`- none`]),
    ``, `## Deployment dry run`, ``, ...(dryRun.length ? dryRun.map(step => `- ${step.id}: ${step.action} ${step.source} -> ${step.destination} (executed: no)`) : [`- none`]), ``,
  ].join("\n");
}

function parseBranchRows(value: string): Array<{ branch: string; lastCommitAt: string }> {
  return value.split(/\r?\n/).filter(Boolean).flatMap(line => {
    const [branch, lastCommitAt] = line.split("\t");
    return branch && lastCommitAt ? [{ branch, lastCommitAt }] : [];
  });
}

function parseWorktrees(value: string): Array<{ path: string; branch?: string }> {
  return value.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    return { path: path ?? "unknown", ...(branch ? { branch } : {}) };
  });
}

function clean(value: string): string { return value.trim(); }

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
