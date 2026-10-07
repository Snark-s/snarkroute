import { join } from "node:path";
import { JabberwockMemoryStorage } from "./storage";
import type { CreateRouteInput, RouteStepUpdate, RouteUpdate, WorkingRoute } from "./route-types";
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

export class JabberwockMemoryService {
  private readonly storage: JabberwockMemoryStorage;

  constructor(database: string | JabberwockMemoryStorage = default_database_path()) {
    this.storage = typeof database === "string" ? new JabberwockMemoryStorage(database) : database;
  }

  close(): void {
    this.storage.close();
  }

  create_route(input: CreateRouteInput): WorkingRoute { return this.storage.create_route(input); }
  get_route(id: string): WorkingRoute | null { return this.storage.get_route(id); }
  update_route(id: string, update: RouteUpdate): void { this.storage.update_route(id, update); }
  update_route_step(id: string, update: RouteStepUpdate): void { this.storage.update_route_step(id, update); }
  update_run(id: string, update: Parameters<JabberwockMemoryStorage["update_run"]>[1]): void { this.storage.update_run(id, update); }
  claim_route(id: string): boolean { return this.storage.claim_route(id); }
  project_has_running_route(taskId: string, exceptRouteId?: string): boolean { return this.storage.project_has_running_route(taskId, exceptRouteId); }
  recover_routes(ownedRoutes?: ReadonlySet<string>): string[] { return this.storage.recover_routes(ownedRoutes); }

  get_setting(key: string): string | null {
    return this.storage.get_setting(key);
  }

  set_setting(key: string, value: string): void {
    this.storage.set_setting(key, value);
  }

  create_project(input: CreateProjectInput): Project {
    return this.storage.create_project({
      name: required(input.name, "Project name"),
      description: input.description?.trim() ?? "",
      root_path: required(input.root_path, "Project root path")
    });
  }

  get_project(project_id: string): Project | null {
    return this.storage.get_project(required(project_id, "Project id"));
  }

  list_projects(): Project[] {
    return this.storage.list_projects();
  }

  create_task(input: CreateTaskInput): Task {
    return this.storage.create_task({
      project_id: required(input.project_id, "Project id"),
      title: required(input.title, "Task title"),
      original_request: required(input.original_request, "Original request"),
      status: optional_status(input.status)
    });
  }

  get_task(task_id: string): Task | null {
    return this.storage.get_task(required(task_id, "Task id"));
  }

  create_step(input: CreateStepInput): Step {
    if (!Number.isInteger(input.sequence) || input.sequence < 0) throw new Error("Step sequence must be a non-negative integer.");
    return this.storage.create_step({
      task_id: required(input.task_id, "Task id"),
      sequence: input.sequence,
      instruction: required(input.instruction, "Step instruction"),
      status: optional_status(input.status)
    });
  }

  complete_step(step_id: string, result_summary: string): Step {
    return this.storage.complete_step(required(step_id, "Step id"), required(result_summary, "Step result summary"));
  }

  fail_step(step_id: string, result_summary: string): Step {
    return this.storage.fail_step(required(step_id, "Step id"), required(result_summary, "Step failure summary"));
  }

  get_step(step_id: string): Step | null {
    return this.storage.get_step(required(step_id, "Step id"));
  }

  list_task_steps(task_id: string): Step[] {
    return this.storage.list_task_steps(required(task_id, "Task id"));
  }

  next_step_sequence(task_id: string): number {
    return this.storage.next_step_sequence(required(task_id, "Task id"));
  }

  record_step_assessment(step_id: string, assessment: string, accepted: boolean): Step {
    return this.storage.record_step_assessment(
      required(step_id, "Step id"),
      required(assessment, "Step assessment"),
      accepted
    );
  }

  add_fact(input: AddFactInput): Fact {
    return this.storage.add_fact({
      project_id: required(input.project_id, "Project id"),
      task_id: optional_id(input.task_id),
      text: required(input.text, "Fact text"),
      source: required(input.source, "Fact source")
    });
  }

  add_decision(input: AddDecisionInput): Decision {
    return this.storage.add_decision({
      project_id: required(input.project_id, "Project id"),
      task_id: optional_id(input.task_id),
      text: required(input.text, "Decision text"),
      rationale: required(input.rationale, "Decision rationale")
    });
  }

  add_run(input: AddRunInput): Run {
    return this.storage.add_run({
      step_id: required(input.step_id, "Step id"),
      model: required(input.model, "Run model"),
      prompt: required(input.prompt, "Run prompt"),
      response: input.response,
      status: required(input.status, "Run status"),
      metadata: input.metadata,
      started_at: input.started_at,
      finished_at: input.finished_at
    });
  }

  list_runs_for_step(step_id: string): Run[] {
    return this.storage.list_runs_for_step(required(step_id, "Step id"));
  }

  add_artifact(input: AddArtifactInput): Artifact {
    return this.storage.add_artifact({
      task_id: required(input.task_id, "Task id"),
      step_id: optional_id(input.step_id),
      path: required(input.path, "Artifact path"),
      description: input.description.trim()
    });
  }

  get_task_context(task_id: string): TaskContext | null {
    return this.storage.get_task_context(required(task_id, "Task id"));
  }
}

export function default_database_path(): string {
  return process.env.JABBERWOCK_MEMORY_PATH?.trim() || join(process.cwd(), "data", "jabberwock", "working-memory.sqlite");
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function optional_id(value: string | null | undefined): string | null {
  return value == null ? null : required(value, "Related id");
}

function optional_status(value: string | undefined): string | undefined {
  return value === undefined ? undefined : required(value, "Status");
}
