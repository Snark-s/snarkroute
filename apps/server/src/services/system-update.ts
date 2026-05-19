import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const gitTimeoutMs = 120_000;

export type SystemUpdateStatus = {
  ok: boolean;
  repoRoot: string;
  branch: string | null;
  commit: string | null;
  remote: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  changes: string[];
};

export type SystemUpdateResult = {
  ok: boolean;
  before: SystemUpdateStatus;
  after: SystemUpdateStatus;
  output: string;
};

async function runGit(args: string[], options: { allowFailure?: boolean } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoRoot(),
      timeout: gitTimeoutMs,
      maxBuffer: 1024 * 1024
    });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const maybe = error as { stdout?: string; stderr?: string; message?: string };
    const details = `${maybe.stdout ?? ""}${maybe.stderr ?? ""}`.trim();
    throw new Error(details || maybe.message || "Git command failed.");
  }
}

export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export async function readSystemUpdateStatus(): Promise<SystemUpdateStatus> {
  await runGit(["rev-parse", "--is-inside-work-tree"]);
  const [branch, commit, remote, upstream, statusText] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true }),
    runGit(["rev-parse", "--short", "HEAD"], { allowFailure: true }),
    runGit(["config", "--get", "remote.origin.url"], { allowFailure: true }),
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFailure: true }),
    runGit(["status", "--porcelain"], { allowFailure: true })
  ]);
  const divergence = upstream
    ? await runGit(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], { allowFailure: true })
    : "";
  const [behindText, aheadText] = divergence.trim().split(/\s+/);
  const behind = behindText && Number.isFinite(Number(behindText)) ? Number(behindText) : null;
  const ahead = aheadText && Number.isFinite(Number(aheadText)) ? Number(aheadText) : null;
  const changes = statusText.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return {
    ok: true,
    repoRoot: repoRoot(),
    branch: branch || null,
    commit: commit || null,
    remote: remote || null,
    upstream: upstream || null,
    ahead,
    behind,
    dirty: changes.length > 0,
    changes
  };
}

export async function updateFromGitHub(): Promise<SystemUpdateResult> {
  const before = await readSystemUpdateStatus();
  if (before.dirty) {
    throw new Error("Local changes are present. Commit, stash, or discard them before updating.");
  }
  if (!before.remote) {
    throw new Error("Git remote 'origin' is not configured.");
  }
  if (!before.branch || before.branch === "HEAD") {
    throw new Error("Cannot update while the repository is in detached HEAD state.");
  }

  const fetchOutput = await runGit(["fetch", "--prune", "origin"]);
  const pullArgs = before.upstream ? ["pull", "--ff-only"] : ["pull", "--ff-only", "origin", before.branch];
  const pullOutput = await runGit(pullArgs);
  const after = await readSystemUpdateStatus();
  return {
    ok: true,
    before,
    after,
    output: [fetchOutput, pullOutput].filter(Boolean).join("\n")
  };
}
