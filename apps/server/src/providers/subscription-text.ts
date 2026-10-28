/** Prompt shaping shared by the subscription text providers (Claude Code CLI, Codex CLI). */

type ChatMessage = { role: string; content: string };

export function promptFromParams(params: Record<string, unknown>, inputs: Record<string, unknown>, conversation: boolean): { systemPrompt?: string; prompt: string } {
  const messages = (Array.isArray(params.messages) ? params.messages : [])
    .map(item => recordValue(item))
    .map((item): ChatMessage => ({ role: stringValue(item.role) ?? "user", content: contentText(item.content) }))
    .filter(item => item.content);
  const system = [stringValue(params.system), stringValue(params.systemPrompt), ...messages.filter(item => item.role === "system").map(item => item.content)]
    .filter((item): item is string => Boolean(item)).join("\n\n") || undefined;
  const turns = messages.filter(item => item.role !== "system");
  if (!turns.length) return { systemPrompt: system, prompt: stringValue(params.prompt) ?? stringValue(inputs.prompt) ?? stringValue(inputs.text) ?? "" };
  // A persisted conversation already holds earlier turns; only the newest user turn is sent.
  if (conversation || turns.length === 1) return { systemPrompt: system, prompt: turns[turns.length - 1].content };
  const transcript = turns.slice(0, -1).map(item => `<${item.role}>\n${item.content}\n</${item.role}>`).join("\n");
  return { systemPrompt: system, prompt: `Earlier conversation:\n${transcript}\n\nReply to the latest message:\n${turns[turns.length - 1].content}` };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part => recordValue(part)).filter(part => part.type === "text" || typeof part.text === "string").map(part => String(part.text ?? "")).join("");
}
export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
