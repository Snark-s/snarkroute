import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { CreateRouteInput, RouteStep, RouteStepUpdate, RouteUpdate, WorkingRoute } from "./route-types";
import type {
  AddArtifactInput,
  AddDecisionInput,
  AddFactInput,
  AddRunInput,
  Artifact,
  CreateProjectInput,
  CreateStepInput,
  CreateTaskInput,
  Decision,
  Fact,
  Project,
  Run,
  Step,
  Task,
  TaskContext
} from "./types";

interface SQLiteStatement {
  run(...parameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Record<string, unknown>[];
}

interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (location: string) => SQLiteDatabase;
};

export class JabberwockMemoryStorage {
  private readonly database: SQLiteDatabase;

  constructor(database_path: string) {
    if (database_path !== ":memory:") mkdirSync(dirname(database_path), { recursive: true });
    this.database = new DatabaseSync(database_path);
    this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (database_path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
    // Concurrent local clients must see the complete additive migration, never race an ALTER TABLE.
    this.transaction(() => this.migrate());
  }

  close(): void {
    this.database.close();
  }

  create_project(input: CreateProjectInput): Project {
    const now = timestamp();
    const project: Project = {
      id: id("project"),
      name: input.name,
      description: input.description ?? "",
      root_path: input.root_path,
      created_at: now,
      updated_at: now
    };
    this.database.prepare(`
      INSERT INTO projects (id, name, description, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(project.id, project.name, project.description, project.root_path, project.created_at, project.updated_at);
    return project;
  }

  get_project(project_id: string): Project | null {
    return row<Project>(this.database.prepare("SELECT * FROM projects WHERE id = ?").get(project_id));
  }

  list_projects(): Project[] {
    return rows<Project>(this.database.prepare("SELECT * FROM projects ORDER BY updated_at DESC, id ASC").all());
  }

  create_task(input: CreateTaskInput): Task {
    this.require_project(input.project_id);
    const now = timestamp();
    const task: Task = {
      id: id("task"),
      project_id: input.project_id,
      title: input.title,
      original_request: input.original_request,
      status: input.status ?? "pending",
      created_at: now,
      updated_at: now
    };
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO tasks (id, project_id, title, original_request, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(task.id, task.project_id, task.title, task.original_request, task.status, task.created_at, task.updated_at);
      this.touch_project(task.project_id, now);
    });
    return task;
  }

  get_task(task_id: string): Task | null {
    return row<Task>(this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id));
  }

  create_step(input: CreateStepInput): Step {
    const task = this.require_task(input.task_id);
    const now = timestamp();
    const step: Step = {
      id: id("step"),
      task_id: input.task_id,
      sequence: input.sequence,
      instruction: input.instruction,
      status: input.status ?? "pending",
      result_summary: null,
      assessment: null,
      accepted: null,
      created_at: now,
      completed_at: null
    };
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO steps (id, task_id, sequence, instruction, status, result_summary, assessment, accepted, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(step.id, step.task_id, step.sequence, step.instruction, step.status, step.result_summary, step.assessment, step.accepted, step.created_at, step.completed_at);
      this.touch_task(task.id, now);
      this.touch_project(task.project_id, now);
    });
    return step;
  }

  complete_step(step_id: string, result_summary: string): Step {
    const relation = this.require_step_relation(step_id);
    const now = timestamp();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE steps SET status = 'completed', result_summary = ?, completed_at = ? WHERE id = ?
      `).run(result_summary, now, step_id);
      this.touch_task(relation.task_id, now);
      this.touch_project(relation.project_id, now);
    });
    return this.require_step(step_id);
  }

  fail_step(step_id: string, result_summary: string): Step {
    const relation = this.require_step_relation(step_id);
    const now = timestamp();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE steps SET status = 'failed', result_summary = ?, completed_at = ? WHERE id = ?
      `).run(result_summary, now, step_id);
      this.touch_task(relation.task_id, now);
      this.touch_project(relation.project_id, now);
    });
    return this.require_step(step_id);
  }

  get_step(step_id: string): Step | null {
    return step_row(this.database.prepare("SELECT * FROM steps WHERE id = ?").get(step_id));
  }

  list_task_steps(task_id: string): Step[] {
    this.require_task(task_id);
    return step_rows(this.database.prepare(`
      SELECT * FROM steps WHERE task_id = ? ORDER BY sequence ASC, created_at ASC, id ASC
    `).all(task_id));
  }

  next_step_sequence(task_id: string): number {
    this.require_task(task_id);
    const value = this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM steps WHERE task_id = ?
    `).get(task_id)?.sequence;
    return Number(value ?? 1);
  }

  record_step_assessment(step_id: string, assessment: string, accepted: boolean): Step {
    const relation = this.require_step_relation(step_id);
    const now = timestamp();
    this.transaction(() => {
      this.database.prepare("UPDATE steps SET assessment = ?, accepted = ? WHERE id = ?")
        .run(assessment, accepted ? 1 : 0, step_id);
      this.touch_task(relation.task_id, now);
      this.touch_project(relation.project_id, now);
    });
    return this.require_step(step_id);
  }

  add_fact(input: AddFactInput): Fact {
    this.assert_task_in_project(input.project_id, input.task_id ?? null);
    const fact: Fact = {
      id: id("fact"),
      project_id: input.project_id,
      task_id: input.task_id ?? null,
      text: input.text,
      source: input.source,
      created_at: timestamp()
    };
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO facts (id, project_id, task_id, text, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(fact.id, fact.project_id, fact.task_id, fact.text, fact.source, fact.created_at);
      this.touch_project(fact.project_id, fact.created_at);
      if (fact.task_id) this.touch_task(fact.task_id, fact.created_at);
    });
    return fact;
  }

  add_decision(input: AddDecisionInput): Decision {
    this.assert_task_in_project(input.project_id, input.task_id ?? null);
    const decision: Decision = {
      id: id("decision"),
      project_id: input.project_id,
      task_id: input.task_id ?? null,
      text: input.text,
      rationale: input.rationale,
      created_at: timestamp()
    };
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO decisions (id, project_id, task_id, text, rationale, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(decision.id, decision.project_id, decision.task_id, decision.text, decision.rationale, decision.created_at);
      this.touch_project(decision.project_id, decision.created_at);
      if (decision.task_id) this.touch_task(decision.task_id, decision.created_at);
    });
    return decision;
  }

  add_run(input: AddRunInput): Run {
    const relation = this.require_step_relation(input.step_id);
    const run: Run = {
      id: id("run"),
      step_id: input.step_id,
      model: input.model,
      prompt: input.prompt,
      response: input.response,
      status: input.status,
      metadata: input.metadata ?? {},
      started_at: input.started_at ?? timestamp(),
      finished_at: input.finished_at ?? null
    };
    const now = timestamp();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO runs (id, step_id, model, prompt, response, status, metadata, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(run.id, run.step_id, run.model, run.prompt, run.response, run.status, JSON.stringify(run.metadata), run.started_at, run.finished_at);
      this.touch_task(relation.task_id, now);
      this.touch_project(relation.project_id, now);
    });
    return run;
  }

  list_runs_for_step(step_id: string): Run[] {
    this.require_step(step_id);
    return this.database.prepare(`
      SELECT * FROM runs WHERE step_id = ? ORDER BY started_at ASC, id ASC
    `).all(step_id).map(run_row);
  }

  add_artifact(input: AddArtifactInput): Artifact {
    const task = this.require_task(input.task_id);
    if (input.step_id) {
      const step = this.require_step(input.step_id);
      if (step.task_id !== input.task_id) throw new Error(`Step "${input.step_id}" does not belong to task "${input.task_id}".`);
    }
    const artifact: Artifact = {
      id: id("artifact"),
      task_id: input.task_id,
      step_id: input.step_id ?? null,
      path: input.path,
      description: input.description,
      created_at: timestamp()
    };
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO artifacts (id, task_id, step_id, path, description, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(artifact.id, artifact.task_id, artifact.step_id, artifact.path, artifact.description, artifact.created_at);
      this.touch_task(task.id, artifact.created_at);
      this.touch_project(task.project_id, artifact.created_at);
    });
    return artifact;
  }

  get_task_context(task_id: string): TaskContext | null {
    const task = this.get_task(task_id);
    if (!task) return null;
    const project = this.require_project(task.project_id);
    const facts = rows<Fact>(this.database.prepare(`
      SELECT * FROM facts WHERE project_id = ? AND (task_id IS NULL OR task_id = ?) ORDER BY created_at ASC, id ASC
    `).all(project.id, task.id));
    const decisions = rows<Decision>(this.database.prepare(`
      SELECT * FROM decisions WHERE project_id = ? AND (task_id IS NULL OR task_id = ?) ORDER BY created_at ASC, id ASC
    `).all(project.id, task.id));
    const steps = step_rows(this.database.prepare(`
      SELECT * FROM steps WHERE task_id = ? ORDER BY sequence ASC, created_at ASC, id ASC
    `).all(task.id));
    const artifacts = rows<Artifact>(this.database.prepare(`
      SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC, id ASC
    `).all(task.id));
    return {
      project_summary: {
        id: project.id,
        name: project.name,
        description: project.description,
        root_path: project.root_path,
        updated_at: project.updated_at
      },
      task_goal: {
        id: task.id,
        title: task.title,
        original_request: task.original_request,
        status: task.status,
        updated_at: task.updated_at
      },
      relevant_facts: facts,
      decisions,
      completed_steps: steps.filter((step) => step.status === "completed"),
      active_pending_steps: steps.filter((step) => !["completed", "failed", "cancelled", "rejected"].includes(step.status)),
      artifacts
    };
  }

  get_setting(key: string): string | null {
    const row = this.database.prepare(`
      SELECT value FROM settings WHERE "key" = ?
    `).get(key);
    return row ? row.value as string : null;
  }

  set_setting(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO settings ("key", "value") VALUES (?, ?)
      ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"
    `).run(key, value);
  }

  create_route(input: CreateRouteInput): WorkingRoute {
    const task = this.require_task(input.taskId);
    const routeId = id("route");
    const now = timestamp();
    this.transaction(() => {
      this.database.prepare(`INSERT INTO supervisor_routes (id, task_id, status, created_at, execution_config, auto_start, verification_config)
        VALUES (?, ?, 'pending', ?, ?, ?, ?)`).run(routeId, task.id, now, JSON.stringify(input.executionConfig ?? {}), input.autoStart === false ? 0 : 1, JSON.stringify(input.verificationConfig ?? {}));
      const sequence = this.next_step_sequence(task.id);
      input.steps.forEach((step, index) => {
        this.database.prepare(`INSERT INTO steps (id, task_id, sequence, instruction, status, created_at,
          route_id, route_index, title, acceptance_criteria, max_attempts, dependencies)
          VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`)
          .run(id("step"), task.id, sequence + index, step.instruction, now, routeId, index, step.title,
            JSON.stringify(step.acceptanceCriteria), step.maxAttempts ?? 3, JSON.stringify(step.dependencies ?? []));
      });
      this.touch_task(task.id, now);
      this.touch_project(task.project_id, now);
    });
    return this.get_route(routeId)!;
  }

  get_route(routeId: string): WorkingRoute | null {
    const value = this.database.prepare("SELECT * FROM supervisor_routes WHERE id = ?").get(routeId);
    if (!value) return null;
    const steps = this.database.prepare("SELECT * FROM steps WHERE route_id = ? ORDER BY route_index").all(routeId).map(route_step_row);
    return { id: String(value.id), taskId: String(value.task_id), status: value.status as WorkingRoute["status"],
      currentStep: value.current_step as string | null, createdAt: String(value.created_at), startedAt: value.started_at as string | null,
      completedAt: value.completed_at as string | null, blockedReason: value.blocked_reason ? JSON.parse(String(value.blocked_reason)) : null,
      summary: value.summary as string | null, executionConfig: json_record(value.execution_config), verificationConfig: json_record(value.verification_config), steps };
  }

  update_route(routeId: string, update: RouteUpdate): void {
    const columns = { status: "status", currentStep: "current_step", startedAt: "started_at", completedAt: "completed_at", blockedReason: "blocked_reason", summary: "summary", executionConfig: "execution_config", verificationConfig: "verification_config" };
    this.update_fields("supervisor_routes", routeId, update, columns, new Set(["blockedReason", "executionConfig", "verificationConfig"]));
  }

  update_route_step(stepId: string, update: RouteStepUpdate): void {
    const columns = { status: "status", attempts: "attempts", maxAttempts: "max_attempts", needsVerification: "needs_verification", error: "route_error", recoveryResolution: "recovery_resolution" };
    this.update_fields("steps", stepId, update, columns);
    if (update.status && update.status !== "completed") this.database.prepare("UPDATE steps SET completed_at = NULL, accepted = NULL WHERE id = ?").run(stepId);
  }

  update_run(runId: string, update: { response?: string; status?: string; metadata?: Record<string, unknown>; model?: string; finished_at?: string | null }): void {
    this.update_fields("runs", runId, update, { response: "response", status: "status", metadata: "metadata", model: "model", finished_at: "finished_at" }, new Set(["metadata"]));
  }

  /** SQLite claim also excludes another route or standalone execution in the same project. */
  claim_route(routeId: string): boolean {
    const projectScope = project_scope_sql("supervisor_routes.task_id");
    const result = this.database.prepare(`UPDATE supervisor_routes SET status = 'running', started_at = COALESCE(started_at, ?), auto_start = 1, owner_pid = ?
      WHERE id = ? AND status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM supervisor_routes r JOIN tasks t ON t.id = r.task_id
        WHERE r.status = 'running' AND t.project_id IN (${projectScope}))
      AND NOT EXISTS (SELECT 1 FROM steps s JOIN tasks t ON t.id = s.task_id
        WHERE s.route_id IS NULL AND s.status = 'active' AND t.project_id IN (${projectScope}))
      AND NOT EXISTS (SELECT 1 FROM runs run JOIN steps s ON s.id = run.step_id JOIN tasks t ON t.id = s.task_id
        WHERE run.status = 'running' AND t.project_id IN (${projectScope}))`)
      .run(timestamp(), process.pid, routeId);
    return Number(result.changes) === 1;
  }

  project_has_running_route(taskId: string, exceptRouteId = ""): boolean {
    const projectScope = project_scope_sql("?");
    return Boolean(this.database.prepare(`SELECT r.id FROM supervisor_routes r JOIN tasks t ON t.id = r.task_id
      WHERE r.status = 'running' AND r.id != ? AND t.project_id IN (${projectScope})
      UNION ALL SELECT s.route_id FROM runs run JOIN steps s ON s.id = run.step_id JOIN tasks t ON t.id = s.task_id
      WHERE run.status = 'running' AND s.route_id IS NOT NULL AND s.route_id != ? AND t.project_id IN (${projectScope}) LIMIT 1`)
      .get(exceptRouteId, taskId, exceptRouteId, taskId));
  }

  recover_routes(ownedRoutes: ReadonlySet<string> = new Set()): string[] {
    return this.transaction(() => {
      const candidates = this.database.prepare("SELECT id, status, owner_pid FROM supervisor_routes WHERE status = 'running' OR (status = 'pending' AND auto_start = 1) OR status = 'cancelled'").all();
      const resume: string[] = [];
      for (const candidate of candidates) {
        const routeId = String(candidate.id);
        const owner = Number(candidate.owner_pid);
        if (ownedRoutes.has(routeId) || (owner && owner !== process.pid && processAlive(owner))) continue;
        this.database.prepare(`UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'
          AND step_id IN (SELECT id FROM steps WHERE route_id = ?)`).run(timestamp(), routeId);
        if (candidate.status === "cancelled") continue;
        this.database.prepare("UPDATE steps SET status = 'retrying', needs_verification = 1 WHERE route_id = ? AND status IN ('running', 'retrying')").run(routeId);
        this.database.prepare("UPDATE supervisor_routes SET status = 'pending', owner_pid = NULL WHERE id = ?").run(routeId);
        resume.push(routeId);
      }
      return resume;
    });
  }

  private update_fields(table: string, idValue: string, update: object, columns: Record<string, string>, json = new Set<string>()): void {
    const entries = Object.entries(update).filter(([key, value]) => Object.hasOwn(columns, key) && value !== undefined);
    if (!entries.length) return;
    this.database.prepare(`UPDATE ${table} SET ${entries.map(([key]) => `${columns[key]} = ?`).join(", ")} WHERE id = ?`)
      .run(...entries.map(([key, value]) => json.has(key) && value !== null ? JSON.stringify(value) : typeof value === "boolean" ? Number(value) : value), idValue);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        original_request TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        result_summary TEXT,
        assessment TEXT,
        accepted INTEGER,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(task_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        rationale TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        step_id TEXT REFERENCES steps(id) ON DELETE SET NULL,
        path TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS steps_task_idx ON steps(task_id, sequence);
      CREATE INDEX IF NOT EXISTS facts_context_idx ON facts(project_id, task_id, created_at);
      CREATE INDEX IF NOT EXISTS decisions_context_idx ON decisions(project_id, task_id, created_at);
      CREATE INDEX IF NOT EXISTS runs_step_idx ON runs(step_id, started_at);
      CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts(task_id, created_at);
    `);
    this.ensure_column("steps", "assessment", "TEXT");
    this.ensure_column("steps", "accepted", "INTEGER");
    this.ensure_column("runs", "metadata", "TEXT NOT NULL DEFAULT '{}'");
    // Additive migration: standalone steps and historical runs remain untouched.
    this.database.exec(`CREATE TABLE IF NOT EXISTS supervisor_routes (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL, current_step TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
      blocked_reason TEXT, summary TEXT, execution_config TEXT NOT NULL DEFAULT '{}', auto_start INTEGER NOT NULL DEFAULT 1, owner_pid INTEGER
    );`);
    this.ensure_column("supervisor_routes", "auto_start", "INTEGER NOT NULL DEFAULT 1");
    this.ensure_column("supervisor_routes", "owner_pid", "INTEGER");
    this.ensure_column("supervisor_routes", "verification_config", "TEXT NOT NULL DEFAULT '{}'");
    for (const [column, declaration] of Object.entries({
      route_id: "TEXT REFERENCES supervisor_routes(id) ON DELETE CASCADE", route_index: "INTEGER", title: "TEXT",
      acceptance_criteria: "TEXT NOT NULL DEFAULT '[]'", attempts: "INTEGER NOT NULL DEFAULT 0",
      max_attempts: "INTEGER NOT NULL DEFAULT 3", dependencies: "TEXT NOT NULL DEFAULT '[]'",
      needs_verification: "INTEGER NOT NULL DEFAULT 0", route_error: "TEXT", recovery_resolution: "TEXT"
    })) this.ensure_column("steps", column, declaration);
    this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS steps_route_idx ON steps(route_id, route_index);
      CREATE INDEX IF NOT EXISTS supervisor_routes_task_idx ON supervisor_routes(task_id, status);`);
  }

  private ensure_column(table: "steps" | "runs" | "supervisor_routes", column: string, declaration: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration};`);
  }

  private require_project(project_id: string): Project {
    const project = this.get_project(project_id);
    if (!project) throw new Error(`Project "${project_id}" was not found.`);
    return project;
  }

  private require_task(task_id: string): Task {
    const task = this.get_task(task_id);
    if (!task) throw new Error(`Task "${task_id}" was not found.`);
    return task;
  }

  private require_step(step_id: string): Step {
    const step = this.get_step(step_id);
    if (!step) throw new Error(`Step "${step_id}" was not found.`);
    return step;
  }

  private require_step_relation(step_id: string): { task_id: string; project_id: string } {
    const relation = row<{ task_id: string; project_id: string }>(this.database.prepare(`
      SELECT steps.task_id, tasks.project_id
      FROM steps JOIN tasks ON tasks.id = steps.task_id
      WHERE steps.id = ?
    `).get(step_id));
    if (!relation) throw new Error(`Step "${step_id}" was not found.`);
    return relation;
  }

  private assert_task_in_project(project_id: string, task_id: string | null): void {
    this.require_project(project_id);
    if (!task_id) return;
    const task = this.require_task(task_id);
    if (task.project_id !== project_id) throw new Error(`Task "${task_id}" does not belong to project "${project_id}".`);
  }

  private touch_project(project_id: string, at: string): void {
    this.database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(at, project_id);
  }

  private touch_task(task_id: string, at: string): void {
    this.database.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at, task_id);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function timestamp(): string {
  return new Date().toISOString();
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

// Also protect the same workspace registered under a second project ID.
function project_scope_sql(taskExpression: "?" | "supervisor_routes.task_id"): string {
  const normalize = (alias: string) => process.platform === "win32"
    ? `RTRIM(REPLACE(LOWER(${alias}.root_path), char(92), '/'), '/')` : `RTRIM(${alias}.root_path, '/')`;
  return `SELECT p.id FROM projects p JOIN projects target ON ${normalize("p")} = ${normalize("target")}
    JOIN tasks target_task ON target_task.project_id = target.id WHERE target_task.id = ${taskExpression}`;
}

function row<T>(value: Record<string, unknown> | undefined): T | null {
  return (value as T | undefined) ?? null;
}

function rows<T>(value: Record<string, unknown>[]): T[] {
  return value as T[];
}

function step_row(value: Record<string, unknown> | undefined): Step | null {
  if (!value) return null;
  return {
    id: String(value.id), task_id: String(value.task_id), sequence: Number(value.sequence), instruction: String(value.instruction),
    status: String(value.status), result_summary: value.result_summary as string | null, assessment: value.assessment as string | null,
    created_at: String(value.created_at), completed_at: value.completed_at as string | null,
    accepted: value.accepted == null ? null : Boolean(value.accepted)
  };
}

function step_rows(value: Record<string, unknown>[]): Step[] {
  return value.map((entry) => step_row(entry) as Step);
}

function run_row(value: Record<string, unknown>): Run {
  return {
    ...(value as unknown as Run),
    metadata: json_record(value.metadata)
  };
}

function route_step_row(value: Record<string, unknown>): RouteStep {
  const { route_id, route_index, title, acceptance_criteria, attempts, max_attempts, dependencies, needs_verification, route_error, recovery_resolution, ...base } = value;
  return { ...step_row(base)!, status: value.status as RouteStep["status"], routeId: String(route_id), index: Number(route_index),
    title: String(title), acceptanceCriteria: JSON.parse(String(acceptance_criteria)), attempts: Number(attempts),
    maxAttempts: Number(max_attempts), dependencies: JSON.parse(String(dependencies)), needsVerification: Boolean(needs_verification), error: route_error as string | null, recoveryResolution: recovery_resolution as string | null };
}

function json_record(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
