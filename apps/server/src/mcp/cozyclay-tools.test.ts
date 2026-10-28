import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { registerCozyClayTools } from "./cozyclay-tools";

const sessions: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => {
  for (const { client, server } of sessions.splice(0)) {
    await client.close(); await server.close();
  }
});

describe("CozyClay tools", () => {
  it("exposes local previs tools and reads status without spawning a process", async () => {
    const calls: string[][] = [];
    const server = new McpServer({ name: "cozy-test", version: "1" });
    registerCozyClayTools(server, async args => {
      calls.push(args); return { ok: true, editors: [{ handle: "editor-1" }] };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cozy-test-client", version: "1" });
    sessions.push({ client, server });
    await server.connect(b); await client.connect(a);

    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "cozyclay_status", "cozyclay_inspect", "cozyclay_arrange_objects",
      "cozyclay_arrange_characters", "cozyclay_frame_shot",
      "cozyclay_capture", "cozyclay_undo"
    ]));
    const status = await client.callTool({ name: "cozyclay_status", arguments: {} });
    expect(JSON.stringify(status)).toContain("editor-1");
    await client.callTool({ name: "cozyclay_inspect", arguments: { scope: "scene" } });
    expect(calls).toEqual([["live", "status"], ["live", "inspect", "--scope", "scene"]]);
  });

  it("passes structured scene ops through a temp file, not a shell argument", async () => {
    const calls: string[][] = [];
    const server = new McpServer({ name: "cozy-test", version: "1" });
    registerCozyClayTools(server, async args => {
      calls.push(args); return { ok: true, receiptId: "receipt-test-1" };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cozy-test-client", version: "1" });
    sessions.push({ client, server });
    await server.connect(b); await client.connect(a);
    const result = await client.callTool({
      name: "cozyclay_arrange_objects",
      arguments: { ops: [{ op: "create", source: { kind: "cube" }, name: "Bench & lamp" }] }
    });
    expect(JSON.stringify(result)).toContain("receipt-test-1");
    expect(calls[0]?.slice(0, 3)).toEqual(["live", "arrange-objects", "-f"]);
    expect(calls[0]).toHaveLength(4);
  });
});
