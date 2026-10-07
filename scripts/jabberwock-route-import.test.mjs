import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAcceptanceRoute } from "./jabberwock-route-import.mjs";

test("adopts the same blocked route additively and refuses duplicate history", () => {
  const root = mkdtempSync(join(tmpdir(), "route-adoption-"));
  const source = join(root, "source.sqlite"), target = join(root, "target.sqlite");
  const schema = `CREATE TABLE projects(id TEXT PRIMARY KEY,root_path TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT);
    CREATE TABLE supervisor_routes(id TEXT PRIMARY KEY,task_id TEXT,status TEXT);
    CREATE TABLE steps(id TEXT PRIMARY KEY,task_id TEXT,status TEXT,attempts INTEGER);
    CREATE TABLE facts(id TEXT PRIMARY KEY,task_id TEXT,project_id TEXT);
    CREATE TABLE decisions(id TEXT PRIMARY KEY,task_id TEXT,project_id TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,step_id TEXT,metadata TEXT);
    CREATE TABLE artifacts(id TEXT PRIMARY KEY,task_id TEXT);`;
  try {
    for (const path of [source, target]) { const db = new DatabaseSync(path); db.exec(schema); db.close(); }
    const src = new DatabaseSync(source);
    src.exec(`INSERT INTO projects VALUES('project','root'); INSERT INTO tasks VALUES('task','project');
      INSERT INTO supervisor_routes VALUES('route','task','blocked'); INSERT INTO steps VALUES('step','task','completed',3);
      INSERT INTO runs VALUES('run','step','{"evidence":"retained"}');`); src.close();
    const dst = new DatabaseSync(target); dst.exec("INSERT INTO projects VALUES('existing','existing-root'); INSERT INTO tasks VALUES('existing-task','existing');"); dst.close();
    const mismatch = new DatabaseSync(target); mismatch.exec("ALTER TABLE facts ADD COLUMN extra TEXT;"); mismatch.close();
    assert.throws(() => importAcceptanceRoute(source, target, "route"), /Schema mismatch/);
    const rollback = new DatabaseSync(target);
    assert.equal(rollback.prepare("SELECT COUNT(*) n FROM tasks").get().n, 1);
    assert.equal(rollback.prepare("SELECT COUNT(*) n FROM steps").get().n, 0);
    rollback.exec("ALTER TABLE facts DROP COLUMN extra;"); rollback.close();
    assert.equal(importAcceptanceRoute(source, target, "route").imported.runs, 1);
    const check = new DatabaseSync(target);
    assert.equal(check.prepare("SELECT COUNT(*) n FROM tasks").get().n, 2);
    assert.equal(check.prepare("SELECT attempts FROM steps WHERE id='step'").get().attempts, 3);
    assert.equal(check.prepare("SELECT metadata FROM runs WHERE id='run'").get().metadata, '{"evidence":"retained"}'); check.close();
    assert.throws(() => importAcceptanceRoute(source, target, "route"), /already contains/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
