import type { AtomicToolCall, AtomicWorkspaceTools } from "./atomic-tools";

export type ToolProtocol = "native" | "json" | "auto";
export type NativeToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type NativeMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: NativeToolCall[]; tool_call_id?: string };
export type NativeToolDefinition = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

const string = { type: "string" };
const path = { ...string, description: "Path relative to the project workspace root." };
const schemas: Record<string, { properties: Record<string, unknown>; required: string[] }> = {
  "fs.list": { properties: { path }, required: [] },
  "fs.search": { properties: { query: { ...string, minLength: 1, maxLength: 500 }, path }, required: ["query"] },
  "fs.read": { properties: { path, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, required: ["path"] },
  "fs.write": { properties: { path, content: string }, required: ["path", "content"] },
  "fs.patch": { properties: { path, old: { ...string, minLength: 1, description: "Exact unique text to replace; inspect the file first." }, new: string }, required: ["path", "old", "new"] },
  "git.status": { properties: {}, required: [] },
  "git.diff": { properties: {}, required: [] },
  "shell.exec": { properties: { script: { type: "string", enum: ["build", "test", "lint", "typecheck"] }, cwd: path }, required: ["script"] }
};

/** Schemas adapt the existing permission-filtered registry, never implement tools. */
export function nativeToolDefinitions(definitions: ReturnType<AtomicWorkspaceTools["definitions"]>): NativeToolDefinition[] {
  return definitions.map(definition => {
    const schema = schemas[definition.name];
    if (!schema) throw new Error(`Missing native schema for atomic tool ${definition.name}.`);
    return { type: "function", function: { name: definition.name.replaceAll(".", "_"), description: definition.description,
      parameters: { type: "object", properties: schema.properties, required: schema.required, additionalProperties: false } } };
  });
}

export function parseNativeTurn(value: unknown): { message: NativeMessage; content: string; actions: Array<AtomicToolCall & { id: string }> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native response is missing assistant message.");
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant" || (message.content !== null && message.content !== undefined && typeof message.content !== "string")) throw new Error("Malformed native assistant message.");
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls) || calls.length > 8) throw new Error("Malformed native tool_calls or more than 8 calls in one turn.");
  const ids = new Set<string>();
  const actions = calls.map(value => {
    const call = value as NativeToolCall;
    if (!call || call.type !== "function" || typeof call.id !== "string" || !call.id.trim() || call.id.length > 300 || ids.has(call.id)
      || !call.function || typeof call.function.name !== "string" || typeof call.function.arguments !== "string" || call.function.arguments.length > 64_000) throw new Error("Malformed native tool call/duplicate ID.");
    ids.add(call.id);
    const name = Object.keys(schemas).find(name => name.replaceAll(".", "_") === call.function.name);
    if (!name) throw new Error(`Unknown native atomic tool ${call.function.name}.`);
    const args: unknown = JSON.parse(call.function.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Native tool arguments must be a JSON object.");
    return { id: call.id, name, arguments: args as Record<string, unknown> };
  });
  const content = typeof message.content === "string" ? message.content : "";
  if (!actions.length) {
    try {
      const object = JSON.parse(content) as Record<string, unknown>;
      if (object && ("tool_actions" in object || "tool_calls" in object)) throw new Error("Native mode received manual JSON tool protocol, not native tool calls.");
    } catch (error) { if (error instanceof Error && error.message.startsWith("Native mode")) throw error; }
  }
  return { message: { role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls as NativeToolCall[] } : {}) }, content, actions };
}
