import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCozyClayCli, withCozyClayOpsFile, type CozyClayCli } from "../services/cozyclay-local";

export const COZYCLAY_TOOL_INSTRUCTIONS =
  " CozyClay is the local browser-based 3D previs studio at Y:\\Приложения\\CozyClay. It is not an AI model: use cozyclay_status and cozyclay_inspect before editing, then cozyclay_arrange_objects/characters or cozyclay_frame_shot, verify by cozyclay_capture, undo by receipt if necessary. A CozyClay Studio window with an editor tab must be running; these tools use its live CLI rather than launching a second MCP hub. Never retry an uncertain edit blindly. Send image/video inference to SnarkRoute Model Gateway, not directly to third-party models from CozyClay.";

const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const failed = (error: unknown) => ({
  ...output({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  isError: true
});
const intent = z.enum(["extreme close-up", "close-up", "medium close-up", "medium shot", "medium wide shot", "wide shot", "extreme wide shot"]);
const views = z.enum(["front", "front three-quarter", "profile", "rear three-quarter", "back"]);
const levels = z.enum(["ground", "low", "hip", "eye", "high", "overhead"]);

export function registerCozyClayTools(server: McpServer, cli: CozyClayCli = runCozyClayCli): void {
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("cozyclay_status", {
    description: "Check CozyClay local Studio live-hub readiness and list connected editor tabs. Read this before modifying any scene. No GPU inference.",
    inputSchema: {}, annotations: readOnly
  }, async () => {
    try { return output(await cli(["live", "status"])); }
    catch (error) { return failed(error); }
  });

  server.registerTool("cozyclay_inspect", {
    description: "Inspect the authoritative live CozyClay scene, entities, shot, camera, motion or patchable-field catalogue before editing.",
    inputSchema: { scope: z.enum(["selection", "scene", "entities", "shot", "motion", "catalogue"]).optional() },
    annotations: readOnly
  }, async input => {
    try { return output(await cli(["live", "inspect", "--scope", input.scope ?? "scene"])); }
    catch (error) { return failed(error); }
  });

  server.registerTool("cozyclay_arrange_objects", {
    description: "Create, move, group, or remove CozyClay set objects. Pass official arrange-objects ops (max 100); returns an undoable receipt. Call cozyclay_inspect first. Requires an open Studio tab.",
    inputSchema: { ops: z.array(z.record(z.string(), z.unknown())).min(1).max(100) }
  }, async input => {
    try {
      const result = await withCozyClayOpsFile(input.ops, path => cli(["live", "arrange-objects", "-f", path], 30000));
      return output(result);
    } catch (error) { return failed(error); }
  });

  server.registerTool("cozyclay_arrange_characters", {
    description: "Add, move, or remove CozyClay characters through up to eight official arrange-characters ops. Returns an undoable receipt. Requires a connected Studio tab.",
    inputSchema: { ops: z.array(z.record(z.string(), z.unknown())).min(1).max(8) }
  }, async input => {
    try {
      const result = await withCozyClayOpsFile(input.ops, path => cli(["live", "arrange-characters", "-f", path], 30000));
      return output(result);
    } catch (error) { return failed(error); }
  });

  server.registerTool("cozyclay_frame_shot", {
    description: "Frame a shot in the live CozyClay editor using cinematic framing intent. Returns a revision-checked undoable receipt. Read the scene first.",
    inputSchema: {
      subject: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
      size: intent, view: views, level: levels,
      side: z.enum(["left", "right"]).optional(),
      focal: z.number().min(8).max(300).optional()
    }
  }, async input => {
    try {
      const args = ["live", "frame-shot", "--subject", input.subject, "--size", input.size, "--view", input.view, "--level", input.level];
      if (input.side) args.push("--side", input.side);
      if (input.focal !== undefined) args.push("--focal", String(input.focal));
      return output(await cli(args, 30000));
    } catch (error) { return failed(error); }
  });

  server.registerTool("cozyclay_capture", {
    description: "Render a PNG of the current live shot camera as an MCP image (not a screenshot of the browser). Requires an editor tab. Use after scene or camera edits.",
    inputSchema: { fullResolution: z.boolean().optional() },
    annotations: readOnly
  }, async input => {
    const dir = await mkdtemp(join(tmpdir(), "snarkroute-cozyclay-capture-"));
    const path = join(dir, "shot.png");
    try {
      const args = ["live", "capture", "--out", path];
      if (input.fullResolution !== false) args.push("--framing");
      const result = await cli(args, 60000);
      const bytes = await readFile(path);
      if (bytes.length > 8 * 1024 * 1024) throw new Error("CozyClay capture exceeds 8MB MCP preview limit");
      return { content: [
        { type: "text" as const, text: JSON.stringify(result) },
        { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" }
      ] };
    } catch (error) { return failed(error); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });

  server.registerTool("cozyclay_undo", {
    description: "Undo exactly one CozyClay edit by its receipt ID. Never redo an uncertain edit without inspecting the current scene.",
    inputSchema: { receipt: z.string().min(1).max(128).regex(/^receipt-[a-z0-9-]+$/i) }
  }, async input => {
    try { return output(await cli(["live", "undo", "--receipt", input.receipt], 30000)); }
    catch (error) { return failed(error); }
  });
}
