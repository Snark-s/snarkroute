// Read-only authoritative audit of an existing bake-off. No model calls or route continuation.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { AtomicWorkspaceTools } from "../apps/server/src/jabberwock-memory/atomic-tools";
import { inspectVerificationPolicy } from "../apps/server/src/jabberwock-memory/verification-policy";
import { reviewGateSources, selectExecutor, type ExecutorProfile } from "../apps/server/src/jabberwock-memory/executor-scout";

const output = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Pass the existing Scout evidence directory");
const read = async (name: string) => JSON.parse((await readFile(join(output, name + ".json"), "utf8")).replace(/^\uFEFF/, ""));
const save = (name: string, value: unknown) => writeFile(join(output, name + ".json"), JSON.stringify(value, null, 2));
const discovery = await read("discovery"); const profiles = await read("profiles");
const reviewContract = "preserve original exported state, helper assignment and event callback implementation; reject recursive helpers, extra files, unrelated mutations and extra registrations; actual full AST review and distinct sequential productive repairs";
const reviewImplementationHash = createHash("sha256").update(await readFile(new URL("../apps/server/src/jabberwock-memory/executor-scout.ts", import.meta.url))).digest("hex");
const gateVersion = "semantic-atomic-v2-" + createHash("sha256").update(JSON.stringify({ trialVersion: discovery.gateVersion, reviewContract, reviewImplementationHash })).digest("hex").slice(0, 16);
if (profiles.length !== discovery.candidates.length) throw new Error("All discovered candidates must finish before final review");
const audits = [];
for (const profile of profiles) {
  const stem = profile.model.replace(/[:]/g, "-"); const available = await readdir(output);
  const levels = [];
  for (const level of [1, 2]) {
    if (!available.includes(`${stem}-level${level}.json`)) continue;
    const raw = await read(`${stem}-level${level}`);
    if (raw.gateVersion !== discovery.gateVersion) throw new Error("Gate version mismatch");
    const policy = raw.route.verificationConfig.policies[0];
    const inspection = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(raw.root, "read_only"), policy, []);
    const problems: string[] = []; const actual: Record<string, string> = {};
    for (const file of ["call.ts", "event.ts", "callback.ts"]) {
      actual[file] = await readFile(join(raw.root, file), "utf8");
      if (actual[file] !== raw.actual[file]) problems.push(`${file}: source changed since recorded gate`);
    }
    problems.push(...reviewGateSources(actual, level));
    const extra = (await readdir(raw.root)).filter(file => !Object.keys(actual).includes(file));
    if (extra.length) problems.push(`Unexpected workspace files: ${extra.join(", ")}`);
    const repairs = raw.runs.filter((r: any) => r.metadata.runtime?.executionKind === "repair");
    const mutations = (r: any) => (r.metadata.runtime?.mutationEvents ?? []).filter((e: any) => e.state === "finished" && e.success && e.beforeHash !== e.afterHash);
    if (repairs.some((r: any) => mutations(r).some((e: any) => e.path !== r.metadata.runtime.repairTarget.path))) problems.push("Mutation outside assigned target");
    const resolved = repairs.filter((r: any) => r.metadata.runtime.targetResolved && mutations(r).some((e: any) => e.path === r.metadata.runtime.repairTarget.path));
    const distinct = new Set(resolved.map((r: any) => r.metadata.runtime.repairTarget.id)).size;
    const accepted = raw.passed && raw.finalReview && inspection.counterevidence.length === 0 && problems.length === 0 && distinct >= (level === 1 ? 1 : 3);
    const promptTokens = raw.modelResponses.flatMap((r: any) => typeof r.metadata?.providerUsage?.metrics?.prompt_tokens === "number" ? [r.metadata.providerUsage.metrics.prompt_tokens] : []);
    const productive = resolved.filter((r: any) => !problems.some(p => p.startsWith(r.metadata.runtime.repairTarget.path))).length;
    levels.push({ level, accepted, productiveRepairs: productive, rawTargetResolvedRepairs: resolved.length, distinctResolved: distinct,
      peakContextTokens: promptTokens.length ? Math.max(...promptTokens) : null, problems, inspection, rawArtifact: `${stem}-level${level}.json` });
  }
  profile.level1 = levels.find(l => l.level === 1)?.accepted ?? false;
  profile.level2 = levels.find(l => l.level === 2)?.accepted ?? false;
  profile.finalReview = profile.level2;
  profile.trialVersion = profile.gateVersion;
  profile.gateVersion = gateVersion;
  profile.capabilities.semanticTopLevelRepair = profile.level1;
  profile.capabilities.sequentialSemanticRepair = profile.level2;
  profile.metrics.peakContext = levels.map(l => ({ level: l.level, promptTokens: l.peakContextTokens }));
  profile.metrics.productiveRepairsAllLevels = levels.reduce((n, l) => n + l.productiveRepairs, 0);
  profile.metrics.productiveRepairs = levels.find(l => l.level === 2)?.productiveRepairs ?? 0;
  const rejectedRecordedRepairs = levels.reduce((n, l) => n + l.rawTargetResolvedRepairs - l.productiveRepairs, 0);
  profile.metrics.authoritativeRejectedRecordedRepairs = rejectedRecordedRepairs;
  profile.metrics.failedAttempts += rejectedRecordedRepairs;
  if (profile.failureReason) profile.failureReason.authoritativeReviewProblems = levels.flatMap(l => l.problems);
  profile.metrics.buildProcessCalls = profile.metrics.unsolicitedProcessCalls.filter((c: any) => c.tool === "shell.exec");
  profile.metrics.gitDiffCalls = profile.metrics.unsolicitedProcessCalls.filter((c: any) => c.tool === "git.diff");
  const native = available.includes(`${stem}-native-smoke.json`) ? await read(`${stem}-native-smoke`) : null;
  profile.metrics.nativeSmokeWallTimeMs = native?.durationMs ?? 0;
  profile.metrics.totalCandidateWallTimeMs = profile.metrics.wallTimeMs + profile.metrics.nativeSmokeWallTimeMs;
  const smokeRuntime = native?.runs[0]?.metadata.runtime;
  profile.metrics.nativeSmoke = smokeRuntime ? { modelCalls: smokeRuntime.modelCalls, toolCalls: smokeRuntime.toolCallCount,
    mutations: (smokeRuntime.mutationEvents ?? []).filter((e: any) => e.state === "finished" && e.success && e.beforeHash !== e.afterHash).length } : null;
  audits.push({ model: profile.model, protocol: profile.protocol, gateVersion, levels });
}
const winner = selectExecutor(profiles as ExecutorProfile[], gateVersion);
await save("authoritative-review", { gateVersion, trialVersion: discovery.gateVersion, reviewContract, reviewImplementationHash, audits, modelCalls: 0, mutations: 0, acceptanceContinued: false });
await save("capability-profiles", profiles);
await save("authoritative-selection", { gateVersion, winner,
  reason: winner ? "Strict full PASS; failures, semantic gate wall time, calls, footprint, stable ID" : "no local executor passed semantic coding gate" });
console.info(JSON.stringify({ output, selected: winner?.model ?? "none", gateVersion, results: profiles.map((p: any) => ({ model: p.model, level1: p.level1, level2: p.level2, peakContext: p.metrics.peakContext })) }));
