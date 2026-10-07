import ts from "typescript";

const subject = "setJabberwockToolbarActive";
const parse = (source: string) => ts.createSourceFile("src/background/index.ts", source, ts.ScriptTarget.Latest, true);
const callee = (node: ts.CallExpression, ast: ts.SourceFile) => node.expression.getText(ast).replace(/\s/g, "");
const relevantVariables = new Set(["pendingKey", "processedKey", "jabberwockLog", "jabberwock", "jabberwockBlinkTimer", "jabberwockBlinkOn"]);
const relevantFunctions = new Set([subject, "isChatGpt", "getPending", "executePendingProtocol", "trimProcessed"]);

export function buildContextPack(source: string, policy: unknown, counterevidence: string[]) {
  const ast = parse(source); const lines = source.split(/\r?\n/);
  const ranges: Array<{ label: string; startLine: number; endLine: number }> = [];
  const line = (pos: number) => ast.getLineAndCharacterOfPosition(pos).line + 1;
  const range = (label: string, node: ts.Node, radius = 0) => ranges.push({ label,
    startLine: Math.max(1, line(node.getStart(ast)) - radius), endLine: Math.min(lines.length, line(node.end) + radius) });
  let helperCallCount = 0, storageListenerCount = 0;
  for (const node of ast.statements) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === subject) range("existing helper definition", node);
    if (ts.isImportDeclaration(node) && /Jabberwock|PendingPersonaProtocol|PersonaProtocolAction/.test(node.getText(ast))) range("relevant original import", node);
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => relevantVariables.has(d.name.getText(ast)))) range("existing surrounding declaration", node);
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = callee(node, ast);
      if (name === subject) helperCallCount++;
      if (name === "chrome.storage.onChanged.addListener") storageListenerCount++;
      if (name === "chrome.storage.session.get") range("existing session read; retain its current purpose", node, 1);
      if (name === "chrome.runtime.onMessage.addListener") {
        const callback = node.arguments[0];
        if (callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body)) {
          ranges.push({ label: "existing message listener and trust declarations", startLine: line(node.getStart(ast)), endLine: line(callback.body.statements[1]?.end ?? callback.body.getStart(ast)) });
          for (const statement of callback.body.statements) if (ts.isIfStatement(statement) && statement.expression.getText(ast).includes("JABBERWOCK_SUPERVISOR'")) range("actual Jabberwock dispatch branch", statement);
        }
      }
    }
    ts.forEachChild(node, visit);
  }; visit(ast);
  ranges.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const regions = ranges.filter((r, i) => !ranges.slice(0, i).some(p => p.startLine === r.startLine && p.endLine === r.endLine))
    .map(r => ({ ...r, path: "src/background/index.ts", text: lines.slice(r.startLine - 1, r.endLine).join("\n") }));
  const observations = { helperCallCount, storageListenerCount, sourceLines: lines.length };
  const text = ["READ-ONLY DETERMINISTIC CONTEXT PACK. These are original source facts, not patch instructions.",
    `Observed source counts: ${JSON.stringify(observations)}`,
    "Original source-policy requirements (background context; repair only the assigned target): " + JSON.stringify(policy),
    "Exact current verifier counterevidence: " + JSON.stringify(counterevidence),
    ...regions.map(r => `${r.path}:${r.startLine}-${r.endLine}; ${r.label}\n${r.text}`)].join("\n\n");
  return { text, regions, observations, chars: text.length };
}

export function buildRelevantSlice(source: string) {
  const ast = parse(source); const pieces: string[] = []; const origins: Array<{ label: string; start: number; end: number; startLine: number; endLine: number; text: string }> = [];
  const add = (label: string, start: number, end: number) => {
    const text = source.slice(start, end); pieces.push(text); origins.push({ label, start, end,
      startLine: ast.getLineAndCharacterOfPosition(start).line + 1, endLine: ast.getLineAndCharacterOfPosition(end).line + 1, text });
  };
  for (const node of ast.statements) {
    const start = node.getStart(ast);
    if (ts.isImportDeclaration(node)
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => relevantVariables.has(d.name.getText(ast)))
      || ts.isFunctionDeclaration(node) && node.name && relevantFunctions.has(node.name.text)) add("original declaration", start, node.end);
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && callee(node.expression, ast) === "chrome.runtime.onMessage.addListener") {
      const callback = node.expression.arguments[0];
      if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) throw new Error("Actual listener callback shape required");
      add("original listener opening", start, callback.body.getStart(ast) + 1);
      for (const statement of callback.body.statements) {
        if (ts.isVariableStatement(statement) || ts.isIfStatement(statement) && statement.expression.getText(ast).includes("JABBERWOCK_")) add("original Jabberwock handler statement", statement.getStart(ast), statement.end);
      }
      add("original listener closing", callback.body.end - 1, node.end);
    }
  }
  const result = pieces.join("\n");
  if ((parse(result) as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length) throw new Error("Slice must retain complete actual syntax");
  return { source: result, origins, chars: result.length, originalChars: source.length };
}
