import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";
import ts from "typescript";

// Review only captured disposable output. No model, Atomic tools, real project or memory service.
const output = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Diagnostic evidence directory required");
async function probe(source: string, mode: "success" | "error" | "overlap-success" | "overlap-error") {
  const ast = ts.createSourceFile("captured.ts", source, ts.ScriptTarget.Latest, true);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "chrome.runtime.onMessage.addListener") callback = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!callback) throw new Error("Actual registered message callback required");
  const pending: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  const activations: boolean[] = [], replies: unknown[] = [];
  const sandbox = createContext({
    isSupportedProviderChat: () => true, isChatGpt: () => true, jabberwockLog: () => {},
    setJabberwockToolbarActive: (active: boolean) => { activations.push(active); },
    jabberwock: { execute: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
  });
  const code = ts.transpileModule(`globalThis.capturedListener = ${callback.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  // Executes just the captured listener with stubs. It cannot touch Chrome, storage or files.
  runInContext(code, sandbox, { timeout: 1000 });
  const listener = sandbox.capturedListener as (message: unknown, sender: unknown, reply: (value: unknown) => void) => unknown;
  const start = (requestId: string) => listener({ type: "JABBERWOCK_SUPERVISOR", command: { requestId } }, { tab: { id: 1 }, url: "https://chatgpt.com/" }, value => replies.push(value));
  start("one");
  if (mode.startsWith("overlap")) start("two");
  const afterStart = activations.at(-1) ?? false;
  if (mode.endsWith("error")) pending[0].reject(new Error("controlled rejection"));
  else pending[0].resolve({ ok: true });
  await nextTurn();
  const afterFirstSettlement = activations.at(-1) ?? false;
  const repliesAfterFirst = replies.length;
  if (pending[1]) { pending[1].resolve({ ok: true }); await nextTurn(); }
  const afterAllSettled = activations.at(-1) ?? false;
  const expectedActiveAfterFirst = mode.startsWith("overlap");
  return { mode, activations, afterStart, afterFirstSettlement, afterAllSettled, repliesAfterFirst, replies: replies.length,
    startActivationObserved: afterStart === true,
    settlementStateCorrect: afterFirstSettlement === expectedActiveAfterFirst,
    allSettledInactive: afterAllSettled === false,
    method: "actual callback; helper mocked as activity-state recorder; dispatcher uses controllable promises" };
}
const reviews = [];
for (const name of ["B", "D"]) {
  let result: any;
  try { result = JSON.parse(await readFile(join(output, `${name}-result.json`), "utf8")); }
  catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
  const final = result.attempts.at(-1);
  await writeFile(join(output, `${name}-captured-index.ts`), final.actual);
  const cases = [];
  for (const mode of ["success", "error", "overlap-success", "overlap-error"] as const) cases.push(await probe(final.actual, mode));
  reviews.push({ experiment: name, attempt: final.attempt, actualHash: final.actualHash, primaryTargetResolved: final.targetResolved,
    fullSourcePolicyAccepted: final.fullVerifierAccepted, cases,
    limitation: "Focused listener wiring probes. No extension integration, live browser, persisted session restoration or arbitrary lifecycle proof." });
}
await writeFile(join(output, "lifecycle-review.json"), JSON.stringify(reviews, null, 2));
console.info(JSON.stringify(reviews, null, 2));
