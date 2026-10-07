import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { JabberwockMemoryStorage } from "./storage";

describe("Jabberwock memory startup", () => {
  it("migrates an old working-memory database additively without replacing legacy steps or runs", () => {
    const directory = mkdtempSync(join(tmpdir(), "jabberwock-legacy-"));
    const path = join(directory, "working-memory.sqlite");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, root_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, original_request TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE steps (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL, instruction TEXT NOT NULL, status TEXT NOT NULL, result_summary TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(task_id, sequence));
      CREATE TABLE runs (id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES steps(id), model TEXT NOT NULL, prompt TEXT NOT NULL, response TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
      INSERT INTO projects VALUES ('p', 'Old project', '', '.', '2026-01-01', '2026-01-01');
      INSERT INTO tasks VALUES ('t', 'p', 'Old task', 'Goal', 'pending', '2026-01-01', '2026-01-01');
      INSERT INTO steps VALUES ('s', 't', 1, 'Old step', 'completed', 'Old result', '2026-01-01', '2026-01-01');
      INSERT INTO runs VALUES ('r', 's', 'bonsai', 'Old prompt', 'Old response', 'completed', '2026-01-01', '2026-01-01');`);
    legacy.close();
    const memory = new JabberwockMemoryStorage(path);
    try {
      expect(memory.get_step("s")).toMatchObject({ instruction: "Old step", result_summary: "Old result", accepted: null });
      expect(memory.list_runs_for_step("s")[0]).toMatchObject({ response: "Old response", metadata: {} });
      const route = memory.create_route({ taskId: "t", steps: [{ title: "New", instruction: "New instruction", acceptanceCriteria: ["New criterion"] }] });
      expect(route.steps[0].sequence).toBe(2); expect(memory.list_task_steps("t")).toHaveLength(2);
    } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("initializes all tables and preserves settings and artifacts across restarts", () => {
    const fresh = new JabberwockMemoryStorage(":memory:");
    fresh.close();
    const directory = mkdtempSync(join(tmpdir(), "snarkroute-memory-"));
    const databasePath = join(directory, "memory.sqlite");
    let memory: JabberwockMemoryStorage | undefined;

    try {
      memory = new JabberwockMemoryStorage(databasePath);
      const project = memory.create_project({ name: "Startup", root_path: directory });
      const task = memory.create_task({ project_id: project.id, title: "Startup", original_request: "Start SnarkRoute" });
      memory.set_setting("model", "initial-model");
      memory.set_setting("model", "selected-model");
      const artifact = memory.add_artifact({ task_id: task.id, path: "result.txt", description: "Startup result" });
      memory.close();
      memory = undefined;

      memory = new JabberwockMemoryStorage(databasePath);
      expect(memory.get_setting("model")).toBe("selected-model");
      expect(memory.get_setting("missing")).toBeNull();
      expect(memory.get_task_context(task.id)?.artifacts).toEqual([artifact]);
    } finally {
      memory?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
