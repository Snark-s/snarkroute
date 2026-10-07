import ts from "typescript";

/** Structured evidence only: this selector never changes routing or starts a route. */
export interface ExecutorProfile {
  model: string;
  protocol: "native" | "json";
  gateVersion: string;
  testedAt: string;
  level1: boolean;
  level2: boolean;
  finalReview: boolean;
  capabilities: { read: boolean; mutation: boolean; semanticTopLevelRepair: boolean; sequentialSemanticRepair: boolean };
  metrics: { failedAttempts: number; noProgressAttempts: number; wallTimeMs: number; modelCalls: number; toolCalls: number; productiveRepairs: number; resourceBytes: number };
}

export function selectExecutor(profiles: ExecutorProfile[], gateVersion: string): ExecutorProfile | null {
  const eligible = profiles.filter(p => p.gateVersion === gateVersion && p.level1 && p.level2 && p.finalReview
    && Object.values(p.capabilities).every(Boolean) && p.metrics.productiveRepairs >= 3
    && [p.metrics.failedAttempts, p.metrics.noProgressAttempts, p.metrics.wallTimeMs, p.metrics.modelCalls,
      p.metrics.toolCalls, p.metrics.productiveRepairs, p.metrics.resourceBytes].every(n => Number.isFinite(n) && n >= 0));
  return eligible.sort((a, b) => {
    const rank = (p: ExecutorProfile) => [p.metrics.failedAttempts + p.metrics.noProgressAttempts,
      p.metrics.wallTimeMs, p.metrics.modelCalls + p.metrics.toolCalls, p.metrics.resourceBytes];
    const left = rank(a), right = rank(b);
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i];
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  })[0] ?? null;
}

/** Complements the full AST verifier: existing fixture behavior cannot be replaced with dummy code. */
export function reviewGateSources(actual: Record<string, string>, level: number): string[] {
  const problems: string[] = [];
  for (const file of ["call.ts", "event.ts", "callback.ts"]) {
    const source = ts.createSourceFile(file, actual[file] ?? "", ts.ScriptTarget.Latest, true);
    const compact = (n: ts.Node) => n.getText(source).replace(/\s/g, "");
    const exported = (n: ts.FunctionDeclaration | ts.VariableStatement | undefined) => n?.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    const stateName = file === "event.ts" ? "started" : "active";
    const state = source.statements.find((n): n is ts.VariableStatement => ts.isVariableStatement(n)
      && n.declarationList.declarations.some(d => compact(d.name) === stateName && d.initializer?.getText(source) === (stateName === "active" ? "false" : "0")));
    const name = file === "event.ts" ? "onStarted" : "setActive";
    const helper = source.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
    const statement = helper?.body?.statements.length === 1 ? helper.body.statements[0] : null;
    if (!exported(state) || !exported(helper) || !statement || !ts.isExpressionStatement(statement)
      || compact(statement.expression) !== (name === "setActive" ? "active=value" : "started+=1")) problems.push(`${file}: original exported state/helper implementation not preserved`);
    if (name === "setActive" && (helper?.parameters.length !== 1 || compact(helper.parameters[0].name) !== "value")) problems.push(`${file}: original helper argument not preserved`);
    const registrations: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && compact(n.expression) === "events.addEventListener") registrations.push(n);
      if (ts.isFunctionDeclaration(n) && n.name?.text === "setActive" && n.body) {
        const scan = (v: ts.Node) => { if (ts.isCallExpression(v) && compact(v.expression) === "setActive") problems.push(`${file}: recursive helper call`); ts.forEachChild(v, scan); };
        scan(n.body);
      }
      ts.forEachChild(n, visit);
    }; visit(source);
    if (file !== "call.ts" && registrations.length !== 1) problems.push(`${file}: expected exactly one existing event registration, observed ${registrations.length}`);
    if (file === "event.ts" && (!registrations[0]?.arguments[1] || compact(registrations[0].arguments[1]) !== "onStarted")) problems.push(`${file}: original onStarted callback wiring not preserved`);
    if (file === "callback.ts" && level === 2) {
      const callback = registrations[0]?.arguments[1];
      const body = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback.body : null;
      const call = body && ts.isBlock(body) && body.statements.length === 1 && ts.isExpressionStatement(body.statements[0]) ? body.statements[0].expression : null;
      if (!call || !ts.isCallExpression(call) || compact(call.expression) !== "setActive" || call.arguments.length !== 1 || call.arguments[0].kind !== ts.SyntaxKind.TrueKeyword) problems.push(`${file}: existing callback call was not repaired in place`);
    }
  }
  return problems;
}
