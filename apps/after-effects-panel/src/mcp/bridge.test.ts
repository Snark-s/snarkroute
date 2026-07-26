import { afterEach, describe, expect, it } from "vitest";
import { buildAeBridgeWebSocketUrl, buildEvalScript, evalJson } from "./bridge";

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe("CEP MCP bridge serialization", () => {
  it("builds the exact local WebSocket bridge URL", () => {
    expect(buildAeBridgeWebSocketUrl("http://127.0.0.1:4317")).toBe("ws://127.0.0.1:4317/api/ae-bridge");
  });
  it("passes large multiline unicode JSX as JSON data rather than raw concatenation", () => {
    const message = { requestId: "r1", code: "var путь = \\\"C:\\\\тест\\\\x\\\";\nreturn { текст: путь };", undoGroup: "MCP: тест" };
    const script = buildEvalScript(message);
    const encoded = script.slice("SnarkRouteMCP.execute(".length, -1);
    expect(JSON.parse(encoded)).toEqual(message);
  });

  it("uses mocked evalScript and parses its JSON response", async () => {
    (globalThis as { window?: unknown }).window = { __adobe_cep__: { evalScript: (_script: string, callback: (value: string) => void) => callback(JSON.stringify({ ok: true, result: "Привет" })) } };
    await expect(evalJson<{ result: string }>("SnarkRouteMCP.execute({})")).resolves.toMatchObject({ result: "Привет" });
  });
});
