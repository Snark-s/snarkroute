import { readLocalRuntimeSnapshot, stopLocalRuntime } from "./local-runtime-supervisor";
import { errorMessage } from "./errors";

type StopAllDeps = {
  snapshot: () => Promise<{ runtimes: Array<{ id: string; control: { canStop: boolean } }> }>;
  stop: (id: string) => Promise<unknown>;
};

/** Every controller rechecks ownership. Never kill by a port or guessed PID. */
export async function stopAllLocalRuntimes(deps: StopAllDeps = { snapshot: readLocalRuntimeSnapshot, stop: stopLocalRuntime }) {
  const targets = (await deps.snapshot()).runtimes.filter(runtime => runtime.control.canStop);
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const target of targets) {
    try { await deps.stop(target.id); results.push({ id: target.id, ok: true }); }
    catch (error) { results.push({ id: target.id, ok: false, error: errorMessage(error) }); }
  }
  return results;
}
