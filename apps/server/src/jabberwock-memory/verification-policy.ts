import type ts from "typescript";
import type { AtomicWorkspaceTools, AtomicToolResult } from "./atomic-tools";
import { makeRepairTarget, type RepairTarget, type CallArgument, type CallPredicate } from "./repair-target";

export interface VerificationPolicy {
  stepIndex: number;
  commandScope?: "step" | "route";
  requiredCommands?: Array<"build" | "test" | "lint" | "typecheck">;
  sources?: Array<{ path: string; uniqueSymbol?: string; requiredCalls?: Array<string | CallPredicate>; requiredLiterals?: string[] }>;
}
export async function inspectVerificationPolicy(tools: AtomicWorkspaceTools, policy: VerificationPolicy | undefined, commands: any[]) {
  const evidence: string[] = [], counterevidence: string[] = [], toolEvidence: AtomicToolResult[] = [];
  const repairTargets: RepairTarget[] = [];
  const fail = (target: Omit<RepairTarget, "id">) => { counterevidence.push(target.failure); repairTargets.push(makeRepairTarget(policy!.stepIndex, target)); };
  for (const [probeIndex, probe] of (policy?.sources ?? []).entries()) {
    const reference = `verificationPolicy.sources[${probeIndex}]`;
    // Load the parser only for an explicit source probe, not on every API server import.
    const compiler = (await import("typescript")).default;
    const source = await tools.readForVerification(probe.path);
    const ast = compiler.createSourceFile(probe.path, source.content, compiler.ScriptTarget.Latest, true);
    const diagnostics = (ast as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics?.length) fail({ kind: "source_syntax", path: probe.path, subject: "syntax", criterionReference: reference, observedCount: diagnostics.length, expectedCount: 0,
      failure: `${probe.path}: source contains ${diagnostics.length} syntax parse errors.`, actualEvidence: { sourceHash: source.hash, observedCount: diagnostics.length, details: ["Actual TypeScript parse diagnostics"] } });
    const calls = new Map<string, number>(), declarations = new Map<string, number>(), literals = new Set<string>();
    const callNodes: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (compiler.isCallExpression(node)) { const name = node.expression.getText(ast).replace(/\s/gu, ""); calls.set(name, (calls.get(name) ?? 0) + 1); callNodes.push(node); }
      if (compiler.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, (declarations.get(node.name.text) ?? 0) + 1);
      if (compiler.isVariableDeclaration(node) && compiler.isIdentifier(node.name) && node.initializer && (compiler.isArrowFunction(node.initializer) || compiler.isFunctionExpression(node.initializer))) declarations.set(node.name.text, (declarations.get(node.name.text) ?? 0) + 1);
      if (compiler.isStringLiteralLike(node)) literals.add(node.text);
      compiler.forEachChild(node, visit);
    };
    visit(ast);
    const observations: string[] = [];
    if (probe.uniqueSymbol) {
      const count = declarations.get(probe.uniqueSymbol) ?? 0;
      observations.push(`${probe.uniqueSymbol}: ${count} implementations`);
      if (count !== 1) fail({ kind: "symbol_count", path: probe.path, subject: probe.uniqueSymbol, criterionReference: `${reference}.uniqueSymbol`, observedCount: count, expectedCount: 1,
        failure: `${probe.path}: ${probe.uniqueSymbol} has ${count} implementations, expected exactly 1.`, actualEvidence: { sourceHash: source.hash, observedCount: count, details: ["Actual function/arrow implementation declarations"] } });
    }
    const callee = (call: ts.CallExpression) => call.expression.getText(ast).replace(/\s/gu, "");
    const argumentMatches = (call: ts.CallExpression, constraint: CallArgument): boolean => {
      let argument = call.arguments[constraint.index];
      if (!argument) return false;
      while (compiler.isParenthesizedExpression(argument)) argument = argument.expression;
      if ("stringContains" in constraint) {
        if (compiler.isStringLiteralLike(argument)) return argument.text.includes(constraint.stringContains);
        // Static string fragments of a used template argument, without evaluating expressions/dataflow.
        return compiler.isTemplateExpression(argument) && [argument.head.text, ...argument.templateSpans.map(span => span.literal.text)].some(fragment => fragment.includes(constraint.stringContains));
      }
      const value = compiler.isStringLiteralLike(argument) ? argument.text
        : compiler.isNumericLiteral(argument) ? Number(argument.text)
        : argument.kind === compiler.SyntaxKind.TrueKeyword ? true
        : argument.kind === compiler.SyntaxKind.FalseKeyword ? false
        : argument.kind === compiler.SyntaxKind.NullKeyword ? null
        : compiler.isPrefixUnaryExpression(argument) && argument.operator === compiler.SyntaxKind.MinusToken && compiler.isNumericLiteral(argument.operand) ? -Number(argument.operand.text) : undefined;
      return value !== undefined && value === constraint.equals;
    };
    const argumentsMatch = (call: ts.CallExpression, args: CallArgument[] | undefined) => (args ?? []).every(arg => argumentMatches(call, arg));
    const moduleCall = (call: ts.CallExpression) => {
      for (let node: ts.Node | undefined = call.parent; node && node !== ast; node = node.parent) {
        if (compiler.isFunctionLike(node) || compiler.isClassDeclaration(node) || compiler.isClassExpression(node)) return false;
      }
      return true;
    };
    const callbacks = new Map<string, Array<ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>>();
    const addCallback = (name: string, callback: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression) => callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
    for (const statement of ast.statements) {
      if (compiler.isFunctionDeclaration(statement) && statement.name) addCallback(statement.name.text, statement);
      if (compiler.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (compiler.isIdentifier(declaration.name) && declaration.initializer && (compiler.isArrowFunction(declaration.initializer) || compiler.isFunctionExpression(declaration.initializer))) addCallback(declaration.name.text, declaration.initializer);
      }
    }
    const callbackCalls = (argument: ts.Expression | undefined): ts.CallExpression[] => {
      if (!argument) return [];
      const callback = compiler.isArrowFunction(argument) || compiler.isFunctionExpression(argument) ? argument
        : compiler.isIdentifier(argument) && callbacks.get(argument.text)?.length === 1 ? callbacks.get(argument.text)![0] : undefined;
      const result: ts.CallExpression[] = [];
      const visitBody = (node: ts.Node) => {
        // Owned callback body only: an unused nested function is not the callback's helper call.
        if (compiler.isFunctionDeclaration(node) || compiler.isArrowFunction(node) || compiler.isFunctionExpression(node)) return;
        if (compiler.isCallExpression(node)) result.push(node);
        compiler.forEachChild(node, visitBody);
      };
      if (callback?.body) visitBody(callback.body);
      return result;
    };
    for (const [callIndex, requirement] of (probe.requiredCalls ?? []).entries()) {
      if (typeof requirement !== "string") {
        const predicate = requirement, min = predicate.minCount ?? 1;
        const anchors = predicate.within ? callNodes.filter(call => callee(call) === predicate.within!.callee) : [];
        const candidates = predicate.within ? anchors.filter(call => argumentsMatch(call, predicate.within!.arguments))
          .flatMap(call => callbackCalls(call.arguments[predicate.within!.callbackArgument])) : callNodes.filter(call => !predicate.topLevel || moduleCall(call));
        const relevant = [...new Set(candidates)].filter(call => callee(call) === predicate.callee);
        const count = relevant.filter(call => argumentsMatch(call, predicate.arguments)).length;
        const expectedCondition = { type: "call_count" as const, callee: predicate.callee, min,
          ...(predicate.arguments ? { arguments: predicate.arguments } : {}), ...(predicate.within ? { within: predicate.within } : {}), ...(predicate.topLevel ? { topLevel: true as const } : {}) };
        observations.push(`${predicate.callee}: ${count} calls matching ${JSON.stringify(expectedCondition)} (${relevant.length} eligible call sites)`);
        if (count < min) {
          const supportingFailures: NonNullable<RepairTarget["supportingFailures"]> = [];
          const support = (args: CallArgument[] | undefined, candidates: ts.CallExpression[], location: "call" | "anchor") => {
            for (const arg of args ?? []) if (!candidates.some(call => argumentMatches(call, arg))) {
              const { index, ...condition } = arg;
              supportingFailures.push({ argumentIndex: index, location, expectedCondition: condition,
                failure: `${location} argument ${index} has no eligible AST expression satisfying ${JSON.stringify(condition)}.` });
            }
          };
          support(predicate.arguments, relevant, "call"); support(predicate.within?.arguments, anchors, "anchor");
          fail({ kind: "call_predicate", path: probe.path, subject: predicate.callee, criterionReference: `${reference}.requiredCalls[${callIndex}]`,
            expectedCondition, semanticAnchor: predicate.within ?? { callee: predicate.callee, ...(predicate.topLevel ? { topLevel: true as const } : {}) }, observedCount: count, expectedCount: min,
            actualEvidence: { sourceHash: source.hash, observedCount: count, totalCount: relevant.length, details: [observations.at(-1)!] }, supportingFailures,
            failure: `${probe.path}: ${predicate.callee} has ${count} matching semantic calls, expected at least ${min}; predicate ${JSON.stringify(expectedCondition)}.` });
        }
        continue;
      }
      const name = requirement;
      const count = calls.get(name) ?? 0; observations.push(`${name}: ${count} actual calls`);
      if (!count) fail({ kind: "missing_call", path: probe.path, subject: name, criterionReference: `${reference}.requiredCalls`,
        semanticAnchor: { callee: name }, actualEvidence: { sourceHash: source.hash, observedCount: count, totalCount: count, details: [observations.at(-1)!] },
        failure: `${probe.path}: ${name} has 0 actual calls (definitions/comments/strings are not call sites).` });
    }
    for (const literal of probe.requiredLiterals ?? []) {
      if (![...literals].some(value => value.includes(literal))) fail({ kind: "missing_literal", path: probe.path, subject: literal, criterionReference: `${reference}.requiredLiterals`,
        failure: `${probe.path}: lifecycle literal ${literal} absent.`, actualEvidence: { sourceHash: source.hash, observedCount: 0, details: ["Absent source literal; no semantic anchor in this legacy policy"] } });
      else observations.push(`Lifecycle literal present: ${literal}`);
    }
    evidence.push(`${probe.path} SHA256 ${source.hash}; ${observations.join("; ")}`);
    toolEvidence.push({ name: "fs.inspect", path: probe.path, success: true, output: observations.join("\n") });
  }
  for (const script of policy?.requiredCommands ?? []) {
    const receipt = commands.filter(command => command.source === "package_process" && command.script === script).at(-1);
    const valid = receipt && receipt.success === true && receipt.exitCode === 0 && typeof receipt.command === "string" && typeof receipt.durationMs === "number"
      && typeof receipt.stdoutSummary === "string" && typeof receipt.stderrSummary === "string";
    if (!valid) fail({ kind: "process_receipt", subject: script, criterionReference: "verificationPolicy.requiredCommands",
      failure: `No actual successful ${script} process receipt with command, exitCode, stdout/stderr and duration.` });
    else {
      evidence.push(`${receipt.command}: exit ${receipt.exitCode}, ${receipt.durationMs}ms; ${receipt.stdoutSummary.slice(-400)} ${receipt.stderrSummary.slice(-200)}`);
      toolEvidence.push({ name: "command.receipt", success: true, exitCode: 0, output: evidence.at(-1) });
    }
  }
  if (!evidence.length) evidence.push("Actual process receipt inspection found no completed successful required command.");
  return { evidence, counterevidence, toolEvidence, repairTargets };
}
