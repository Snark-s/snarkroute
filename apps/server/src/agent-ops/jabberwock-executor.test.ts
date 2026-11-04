import { describe, expect, it } from "vitest";
import { JabberwockExecutor, type JabberwockRuntime } from "./jabberwock-executor";
import { rankExecutors } from "./router";
import type { ExecutorRunContext } from "./executors";

function fakeRuntime(final: "completed" | "blocked") {
  const calls: Record<string, unknown[]> = { project: [], task: [], route: [] };
  let polls = 0;
  const runtime: JabberwockRuntime = {
    memory: {
      list_projects: () => [{ id: "p-existing", root_path: "C:\\work\\site\\" }],
      create_project: input => { calls.project.push(input); return { id: "p-new" }; },
      create_task: input => { calls.task.push(input); return { id: "jt-1" }; }
    },
    runner: {
      create_route: input => { calls.route.push(input); return { id: "route-1", status: "running" }; },
      get_route_state: () => (++polls < 2 ? { status: "running", completedSteps: 0, totalSteps: 1, changedFiles: [] }
        : final === "completed" ? { status: "completed", summary: "Готово", completedSteps: 1, totalSteps: 1, changedFiles: ["index.html"] }
        : { status: "blocked", blockedReason: { blockedReason: "нужен выбор архитектуры" }, completedSteps: 0, totalSteps: 1, changedFiles: [] }),
      cancel_route: () => undefined
    }
  };
  return { runtime, calls };
}

const context = (workdir: string | undefined): ExecutorRunContext => ({
  task: { id: "t-20261104-aaaaaaaa", spec: { goal: "Собрать страницу\nподробности", acceptance: ["Страница открывается"], permissions: { fileWrite: true } } } as never,
  workdir, prompt: "Собери страницу", brief: "Правила", env: {}, signal: new AbortController().signal, timeoutMs: 60_000, maxTurns: 10,
  log: () => undefined, onPid: () => undefined
});

describe("D5: Jabberwock as an opt-in executor", () => {
  it("runs a one-step route in the project of the workspace and reports changed files", async () => {
    const { runtime, calls } = fakeRuntime("completed");
    const outcome = await new JabberwockExecutor({ runtime: () => runtime, pollMs: 1 }).run(context("C:/work/site"));
    expect(outcome).toMatchObject({ ok: true, provider: "jabberwock" });
    expect(outcome.summary).toContain("index.html");
    expect(calls.project).toHaveLength(0);
    expect(calls.task[0]).toMatchObject({ project_id: "p-existing", title: "Собрать страницу" });
    expect(calls.route[0]).toMatchObject({ taskId: "jt-1", executionConfig: { permissions: "read_write" }, steps: [{ acceptanceCriteria: ["Страница открывается"] }] });
  });

  it("returns a blocked route as a failure with its reason, and needs a workspace and a runtime", async () => {
    const { runtime } = fakeRuntime("blocked");
    const blocked = await new JabberwockExecutor({ runtime: () => runtime, pollMs: 1 }).run(context("C:/other"));
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("нужен выбор архитектуры");
    expect((await new JabberwockExecutor({ runtime: () => runtime }).run(context(undefined))).ok).toBe(false);
    expect(await new JabberwockExecutor({ runtime: () => undefined }).probe()).toMatchObject({ installed: false });
  });

  it("is never picked by ranking unless the task names it", () => {
    const adapter = new JabberwockExecutor({ runtime: () => undefined });
    const base = { adapters: [adapter], probes: new Map(), policy: { allowedExecutors: ["local_route"] } } as never as Parameters<typeof rankExecutors>[0];
    const spec = { goal: "Проанализировать логи", requirements: { kind: "analysis" } };
    expect(rankExecutors({ ...base, spec } as never)[0]).toMatchObject({ executorId: "jabberwock", suitable: false });
    expect(rankExecutors({ ...base, spec: { ...spec, executor: "jabberwock" } } as never)[0]).toMatchObject({ executorId: "jabberwock", suitable: true });
  });
});
