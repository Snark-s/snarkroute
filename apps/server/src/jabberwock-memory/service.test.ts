import { describe, expect, it } from "vitest";
import { JabberwockMemoryService } from "./service";

describe("Jabberwock project working memory", () => {
  it("smoke: creates a project, task and step, completes it, then builds compact task context", () => {
    const memory = new JabberwockMemoryService(":memory:");

    try {
      const project = memory.create_project({
        name: "Jabberwock",
        description: "Separate project working memory",
        root_path: "Y:\\Process\\Jabberwock"
      });
      const task = memory.create_task({
        project_id: project.id,
        title: "Add working memory",
        original_request: "Persist the active project task state."
      });
      const step = memory.create_step({
        task_id: task.id,
        sequence: 1,
        instruction: "Create the SQLite schema"
      });
      const pendingStep = memory.create_step({
        task_id: task.id,
        sequence: 2,
        instruction: "Connect the memory to an agent later"
      });

      memory.add_fact({ project_id: project.id, text: "No vector database is used.", source: "user_request" });
      memory.add_decision({ project_id: project.id, task_id: task.id, text: "Use SQLite first.", rationale: "Keep the first iteration local and simple." });
      memory.add_run({ step_id: step.id, model: "test-model", prompt: "Create schema", response: "Schema created", status: "completed", finished_at: new Date().toISOString() });
      memory.add_artifact({ task_id: task.id, step_id: step.id, path: "apps/server/src/jabberwock-memory/storage.ts", description: "SQLite storage" });
      memory.complete_step(step.id, "Created the SQLite schema and storage operations.");

      const context = memory.get_task_context(task.id);

      expect(memory.list_projects()).toHaveLength(1);
      expect(memory.get_project(project.id)?.name).toBe("Jabberwock");
      expect(memory.get_task(task.id)?.original_request).toBe("Persist the active project task state.");
      expect(context).toMatchObject({
        project_summary: { id: project.id, name: "Jabberwock" },
        task_goal: { id: task.id, status: "pending" },
        relevant_facts: [{ text: "No vector database is used.", task_id: null }],
        decisions: [{ text: "Use SQLite first.", task_id: task.id }],
        completed_steps: [{ id: step.id, status: "completed", result_summary: "Created the SQLite schema and storage operations." }],
        active_pending_steps: [{ id: pendingStep.id, status: "pending" }],
        artifacts: [{ task_id: task.id, step_id: step.id, description: "SQLite storage" }]
      });
    } finally {
      memory.close();
    }
  });
});
