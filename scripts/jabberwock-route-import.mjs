import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Explicit additive adoption of a legacy acceptance Task into configured working memory. */
export function importAcceptanceRoute(sourcePath, targetPath, routeId) {
  if (resolve(sourcePath) === resolve(targetPath)) throw new Error("Source and target must differ.");
  const db = new DatabaseSync(targetPath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  try {
    db.prepare("ATTACH DATABASE ? AS acceptance").run(resolve(sourcePath));
    const route = db.prepare("SELECT * FROM acceptance.supervisor_routes WHERE id=?").get(routeId);
    if (!route || route.status !== "blocked") throw new Error("Only an existing BLOCKED acceptance route can be imported.");
    const task = db.prepare("SELECT * FROM acceptance.tasks WHERE id=?").get(route.task_id);
    if (!task) throw new Error("Acceptance Task is missing.");
    if (db.prepare("SELECT id FROM main.tasks WHERE id=?").get(task.id)) throw new Error("Target already contains this Task; no history will be overwritten.");
    if (db.prepare("SELECT id FROM acceptance.supervisor_routes WHERE task_id=? AND id<>?").get(task.id, routeId)) throw new Error("Task has another route; explicit migration review is required.");
    const imported = {};
    db.exec("BEGIN IMMEDIATE;");
    try {
      const copy = (table, filter, args) => {
        const sourceColumns = db.prepare(`PRAGMA acceptance.table_info(${table})`).all().map(column => column.name);
        const targetColumns = db.prepare(`PRAGMA main.table_info(${table})`).all().map(column => column.name);
        if (sourceColumns.length !== targetColumns.length || sourceColumns.some(column => !targetColumns.includes(column))) throw new Error(`Schema mismatch in ${table}; import stopped.`);
        const columns = targetColumns.map(column => `"${column}"`).join(",");
        imported[table] = Number(db.prepare(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM acceptance.${table} WHERE ${filter}`).run(...args).changes);
      };
      const existingProject = db.prepare("SELECT root_path FROM main.projects WHERE id=?").get(task.project_id);
      const sourceProject = db.prepare("SELECT root_path FROM acceptance.projects WHERE id=?").get(task.project_id);
      if (!sourceProject || (existingProject && existingProject.root_path !== sourceProject.root_path)) throw new Error("Project identity conflict.");
      if (!existingProject) copy("projects", "id=?", [task.project_id]);
      copy("tasks", "id=?", [task.id]);
      copy("supervisor_routes", "id=?", [routeId]);
      copy("steps", "task_id=?", [task.id]);
      for (const table of ["facts", "decisions"]) copy(table, "task_id=? OR (task_id IS NULL AND project_id=?)", [task.id, task.project_id]);
      copy("runs", "step_id IN (SELECT id FROM acceptance.steps WHERE task_id=?)", [task.id]);
      copy("artifacts", "task_id=?", [task.id]);
      db.exec("COMMIT;");
    } catch (error) { db.exec("ROLLBACK;"); throw error; }
    return { routeId, taskId: task.id, imported };
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, target, routeId] = process.argv.slice(2);
  if (!source || !target || !routeId) throw new Error("Usage: source.sqlite target.sqlite routeId (backup target first)");
  console.log(JSON.stringify(importAcceptanceRoute(source, target, routeId)));
}
