export interface Project {
  id: string;
  name: string;
  description: string;
  root_path: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  original_request: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Step {
  id: string;
  task_id: string;
  sequence: number;
  instruction: string;
  status: string;
  result_summary: string | null;
  assessment: string | null;
  accepted: boolean | null;
  created_at: string;
  completed_at: string | null;
}

export interface Fact {
  id: string;
  project_id: string;
  task_id: string | null;
  text: string;
  source: string;
  created_at: string;
}

export interface Decision {
  id: string;
  project_id: string;
  task_id: string | null;
  text: string;
  rationale: string;
  created_at: string;
}

export interface Run {
  id: string;
  step_id: string;
  model: string;
  prompt: string;
  response: string;
  status: string;
  metadata: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
}

export interface Artifact {
  id: string;
  task_id: string;
  step_id: string | null;
  path: string;
  description: string;
  created_at: string;
}

export interface TaskContext {
  project_summary: Pick<Project, "id" | "name" | "description" | "root_path" | "updated_at">;
  task_goal: Pick<Task, "id" | "title" | "original_request" | "status" | "updated_at">;
  relevant_facts: Fact[];
  decisions: Decision[];
  completed_steps: Step[];
  active_pending_steps: Step[];
  artifacts: Artifact[];
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  root_path: string;
}

export interface CreateTaskInput {
  project_id: string;
  title: string;
  original_request: string;
  status?: string;
}

export interface CreateStepInput {
  task_id: string;
  sequence: number;
  instruction: string;
  status?: string;
}

export interface AddFactInput {
  project_id: string;
  task_id?: string | null;
  text: string;
  source: string;
}

export interface AddDecisionInput {
  project_id: string;
  task_id?: string | null;
  text: string;
  rationale: string;
}

export interface AddRunInput {
  step_id: string;
  model: string;
  prompt: string;
  response: string;
  status: string;
  metadata?: Record<string, unknown>;
  started_at?: string;
  finished_at?: string | null;
}

export interface AddArtifactInput {
  task_id: string;
  step_id?: string | null;
  path: string;
  description: string;
}
