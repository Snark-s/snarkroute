import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicWorkspaceTools } from "./atomic-tools";
import { inspectVerificationPolicy } from "./verification-policy";
import { selectRepairTarget } from "./repair-target";
import { routeVerificationConfigSchema } from "./route-input";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function inspect(source: string, requiredCalls: any[] = [], requiredLiterals: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "semantic-target-")); roots.push(root);
  await writeFile(join(root, "source.ts"), source);
  return inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"), { stepIndex: 0, sources: [{ path: "source.ts", requiredCalls, requiredLiterals }] }, []);
}
it("gives a missing call an exact resolution predicate and actual AST evidence", async () => {
  const result = await inspect("function setActive(active: boolean) { return active; }", ["setActive"]);
  expect(selectRepairTarget(result.repairTargets)).toMatchObject({ repairability: "auto", expectedCondition: { type: "call_count", callee: "setActive", min: 1 }, actualEvidence: { observedCount: 0, sourceHash: expect.any(String) } });
});
it("rejects a wrong argument and dead constant despite the desired literal appearing elsewhere", async () => {
  const predicate = { callee: "events.addEventListener", arguments: [{ index: 0, equals: "started" }] };
  const wrong = await inspect('const events = new EventTarget(); const marker = "started"; events.addEventListener("wrong-event", () => {});', [predicate]);
  expect(wrong.counterevidence).toHaveLength(1);
  expect(selectRepairTarget(wrong.repairTargets)).toMatchObject({ kind: "call_predicate", repairability: "auto", expectedCondition: { type: "call_count", callee: predicate.callee, arguments: predicate.arguments }, actualEvidence: { observedCount: 0, totalCount: 1 }, supportingFailures: [expect.objectContaining({ argumentIndex: 0, expectedCondition: { equals: "started" } })] });
  const fixed = await inspect('const events = new EventTarget(); events.addEventListener("started", () => {});', [predicate]);
  expect(fixed.counterevidence).toEqual([]);
});
it("checks helper argument inside the actual listener callback, not a top-level call or dummy literal", async () => {
  const predicate = { callee: "setActive", arguments: [{ index: 0, equals: true }], within: { callee: "events.addEventListener", callbackArgument: 1, arguments: [{ index: 0, equals: "started" }] } };
  const wrong = await inspect('function setActive(a: boolean) {} const events = new EventTarget(); setActive(true); events.addEventListener("started", () => setActive(false));', [predicate]);
  expect(wrong.counterevidence).toHaveLength(1);
  expect(selectRepairTarget(wrong.repairTargets)?.semanticAnchor).toMatchObject({ callee: "events.addEventListener", callbackArgument: 1 });
  const fixed = await inspect('function setActive(a: boolean) {} const events = new EventTarget(); events.addEventListener("started", () => setActive(true));', [predicate]);
  expect(fixed.counterevidence).toEqual([]);
});
it("keeps bare missing literal counterevidence but forbids its selection and process work behind it", async () => {
  const result = await inspect('const events = new EventTarget();', [], ["job:"]);
  expect(result.counterevidence).toEqual(["source.ts: lifecycle literal job: absent."]);
  expect(result.repairTargets[0]).toMatchObject({ repairability: "evidence_only" });
  expect(selectRepairTarget(result.repairTargets)).toBeUndefined();
  const process = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(roots[0], "read_only"), { stepIndex: 0, requiredCommands: ["build"], sources: [{ path: "source.ts", requiredLiterals: ["job:"] }] }, []);
  expect(selectRepairTarget(process.repairTargets)).toBeUndefined();
});
it("groups argument constraints as supporting failures under one stable semantic primary", async () => {
  const predicate = { callee: "storage.set", arguments: [{ index: 0, stringContains: "job:" }, { index: 1, equals: "started" }] };
  const absent = await inspect("const storage = { set: (key: string, value: string) => {} };", [predicate]);
  const wrong = await inspect('const storage = { set: (key: string, value: string) => {} }; storage.set("other", "stopped"); const marker = "job:started";', [predicate]);
  expect(absent.repairTargets).toHaveLength(1); expect(wrong.repairTargets).toHaveLength(1);
  expect(wrong.repairTargets[0].supportingFailures).toHaveLength(2);
  expect(wrong.repairTargets[0].id).toBe(absent.repairTargets[0].id);
  const fixed = await inspect('const storage = { set: (key: string, value: string) => {} }; storage.set("job:1", "started");', [predicate]);
  expect(fixed.counterevidence).toEqual([]);
});
it("accepts new call predicates while preserving existing string policies and rejects malformed constraints", () => {
  const policy = { policies: [{ stepIndex: 0, sources: [{ path: "source.ts", requiredCalls: ["legacy", { callee: "events.addEventListener", arguments: [{ index: 0, equals: "started" }] }] }] }] };
  expect(routeVerificationConfigSchema.safeParse(policy).success).toBe(true);
  const malformed = structuredClone(policy); (malformed.policies[0].sources[0].requiredCalls[1] as any).arguments[0].index = -1;
  expect(routeVerificationConfigSchema.safeParse(malformed).success).toBe(false);
});
it("requires all argument constraints on the same call and supports used template prefixes", async () => {
  const predicate = { callee: "storage.set", arguments: [{ index: 0, stringContains: "job:" }, { index: 1, equals: "started" }] };
  const wrong = await inspect('storage.set("job:1", "stopped"); storage.set("other", "started");', [predicate]);
  expect(wrong.counterevidence).toHaveLength(1);
  const fixed = await inspect('const id = 1; storage.set(`job:${id}`, "started");', [predicate]);
  expect(fixed.counterevidence).toEqual([]);
});
it("handles a uniquely defined named callback but excludes unused nested helper functions", async () => {
  const predicate = { callee: "setActive", arguments: [{ index: 0, equals: true }], within: { callee: "events.addEventListener", callbackArgument: 1 } };
  const correct = await inspect('function setActive(value: boolean) {} function onStarted() { setActive(true); } events.addEventListener("started", onStarted);', [predicate]);
  expect(correct.counterevidence).toEqual([]);
  const wrong = await inspect('function setActive(value: boolean) {} events.addEventListener("started", () => { const unused = () => setActive(true); });', [predicate]);
  expect(wrong.counterevidence).toHaveLength(1);
});
it("does not accept an unused wrapper as module initialization when topLevel is required", async () => {
  const predicate = { callee: "setActive", topLevel: true as const, arguments: [{ index: 0, equals: true }] };
  const wrong = await inspect('let active = false; function setActive(value: boolean) { active = value; } export function ensureActive() { setActive(true); }', [predicate]);
  expect(wrong.counterevidence).toHaveLength(1);
  const correct = await inspect('let active = false; function setActive(value: boolean) { active = value; } setActive(true);', [predicate]);
  expect(correct.counterevidence).toEqual([]);
});
