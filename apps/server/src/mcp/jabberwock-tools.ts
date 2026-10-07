import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { continueRouteSchema, createRouteSchema } from "../jabberwock-memory/route-input";
import type { RouteRunner } from "../jabberwock-memory/route-runner";
import type { JabberwockMemoryService } from "../jabberwock-memory/service";
import type { SupervisorBridge } from "../jabberwock-memory/supervisor-bridge";

export interface JabberwockMcpContext { memory: JabberwockMemoryService; bridge: SupervisorBridge; runner: RouteRunner }

/** Same persistent Supervisor and runner as HTTP. No chat composer or browser transport. */
export function registerJabberwockTools(server: McpServer, { memory, bridge, runner }: JabberwockMcpContext): void {
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const id = z.string().trim().min(1).max(200);
  const register = (name: string, description: string, inputSchema: z.ZodRawShape, operation: (input: any) => unknown, readonly = false) => {
    server.registerTool(name, { description, inputSchema, ...(readonly ? { annotations: readOnly } : {}) }, async input => {
      try { return output({ ok: true, data: await operation(input) }); }
      catch (error) { return { ...output({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } }), isError: true }; }
    });
  };
  register("jabberwock_capabilities", "Discover autonomous persistent Route Runner operations.", {}, () => ({
    routeRunner: true, operations: ["create_route", "start_route", "get_route_state", "get_escalation", "continue_route", "cancel_route"],
    autoStart: true, defaultMaxAttempts: 3
  }), true);
  register("jabberwock_find_project", "Find a Supervisor project by name.", { name: z.string().trim().min(1).max(200) }, input => memory.list_projects().find(project => project.name.toLowerCase() === input.name.toLowerCase()) ?? null, true);
  register("jabberwock_create_project", "Create a local Supervisor project with an allowed filesystem root.", { name: z.string().min(1).max(200), rootPath: z.string().min(1).max(2_000), description: z.string().max(4_000).optional() }, input => memory.create_project({ name: input.name, root_path: input.rootPath, description: input.description }));
  register("jabberwock_create_task", "Create a task in existing working memory.", { projectId: id, title: z.string().min(1).max(300), originalRequest: z.string().min(1).max(16_000) }, input => memory.create_task({ project_id: input.projectId, title: input.title, original_request: input.originalRequest }));
  register("jabberwock_get_state", "Read compact task state without raw model runs.", { taskId: id }, input => bridge.supervisorGetState(input.taskId), true);
  register("jabberwock_create_route", "Create ordered verifiable steps and start autonomous execution by default. Returns immediately; get_route_state reads progress. Execution never depends on an open browser.", createRouteSchema.innerType().shape, input => {
    const route = runner.create_route(createRouteSchema.parse(input)); return runner.get_route_state(route.id);
  });
  register("jabberwock_start_route", "Start a pending route created with autoStart=false.", { routeId: id }, input => { runner.start_route(input.routeId); return runner.get_route_state(input.routeId); });
  register("jabberwock_get_route_state", "Read compact progress, blockers, artifacts, changed files and validation results.", { routeId: id }, input => runner.get_route_state(input.routeId), true);
  register("jabberwock_get_escalation", "Read the coding escalation packet for an existing blocked route. Apply the fix externally, then submit evidence through continue_route.externalResolution for independent verification.", { routeId: id }, input => runner.get_escalation(input.routeId), true);
  register("jabberwock_continue_route", "Persist an external decision and resume a BLOCKED route from its current step. An optional executionConfig applies explicitly approved changes to the existing routing/runtime settings.", { routeId: id, ...continueRouteSchema.shape }, input => { runner.continue_route(input); return runner.get_route_state(input.routeId); });
  register("jabberwock_cancel_route", "Abort the running execution and stop launching pending steps.", { routeId: id }, input => { runner.cancel_route(input.routeId); return runner.get_route_state(input.routeId); });
}
function output(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
