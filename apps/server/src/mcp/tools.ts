import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { aeBridgeService, type AeBridgeService, type ExecuteJsxCommand } from "../ae-bridge/service";

const session = z.string().min(1).optional().describe("Optional AE session id; omitted when exactly one session is connected.");

export function registerAeTools(server: McpServer, bridge: AeBridgeService = aeBridgeService): void {
  server.registerTool("ae_list_sessions", { description: "List active local After Effects CEP sessions.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, async () => output({ ok: true, sessions: bridge.listSessions() }));

  server.registerTool("ae_get_project", { description: "Read the open After Effects project summary.", inputSchema: { sessionId: session }, annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ sessionId }) => run(bridge, sessionId, projectJsx()));
  server.registerTool("ae_get_active_comp", { description: "Read active composition parameters.", inputSchema: { sessionId: session }, annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ sessionId }) => run(bridge, sessionId, activeCompJsx()));
  server.registerTool("ae_list_layers", { description: "List active composition layers and their basic transform properties; does not dump the full property tree.", inputSchema: { sessionId: session, includeProperties: z.boolean().default(false) }, annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ sessionId, includeProperties }) => run(bridge, sessionId, listLayersJsx(includeProperties)));

  server.registerTool("ae_run_arbitrary_jsx", {
    description: "Execute unrestricted ExtendScript/JSX directly in the open After Effects project, or preview it without execution.",
    inputSchema: { sessionId: session, code: z.string().min(1), mode: z.enum(["execute", "preview"]).default("execute"), timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000), undoGroup: z.union([z.string(), z.literal(false)]).default("MCP: arbitrary JSX") }
  }, async ({ sessionId, code, mode, timeoutMs, undoGroup }) => {
    if (mode === "preview") return output({ ok: true, mode, preparedJsx: code, undoGroup, timeoutMs, note: "Preview only; JSX was not sent to After Effects." });
    return execute(bridge, sessionId, { code, mode, timeoutMs, undoGroup });
  });

  server.registerTool("ae_create_text", { description: "Create an editable text layer in the active composition.", inputSchema: { sessionId: session, text: z.string(), name: z.string().optional() } }, async ({ sessionId, text, name }) => run(bridge, sessionId, `var c=activeComp(); var l=c.layers.addText(${q(text)}); ${name ? `l.name=${q(name)};` : ""} return {layerName:l.name,layerIndex:l.index,compName:c.name};`));
  server.registerTool("ae_import_file", { description: "Import a local file into the After Effects project.", inputSchema: { sessionId: session, path: z.string().min(1), name: z.string().optional() } }, async ({ sessionId, path, name }) => run(bridge, sessionId, `var f=new File(${q(path)}); if(!f.exists) throw new Error("File not found: "+f.fsName); var item=app.project.importFile(new ImportOptions(f)); ${name ? `item.name=${q(name)};` : ""} return {id:item.id,name:item.name,path:f.fsName};`));
  server.registerTool("ae_set_property", { description: "Set an AE layer property by match-name/display-name path.", inputSchema: { sessionId: session, layerIndex: z.number().int().positive(), propertyPath: z.array(z.string()).min(1), value: z.any() } }, async ({ sessionId, layerIndex, propertyPath, value }) => run(bridge, sessionId, propertyLookup(layerIndex, propertyPath, `p.setValue(${q(value)}); return {layerIndex:${layerIndex},property:p.name,value:p.value};`)));
  server.registerTool("ae_apply_expression", { description: "Apply an expression to an AE layer property.", inputSchema: { sessionId: session, layerIndex: z.number().int().positive(), propertyPath: z.array(z.string()).min(1), expression: z.string(), enabled: z.boolean().default(true) } }, async ({ sessionId, layerIndex, propertyPath, expression, enabled }) => run(bridge, sessionId, propertyLookup(layerIndex, propertyPath, `if(!p.canSetExpression) throw new Error("Property cannot use expressions"); p.expression=${q(expression)}; p.expressionEnabled=${enabled}; return {layerIndex:${layerIndex},property:p.name,expressionEnabled:p.expressionEnabled};`)));
  server.registerTool("ae_precompose", { description: "Precompose selected layer indices in the active composition.", inputSchema: { sessionId: session, layerIndices: z.array(z.number().int().positive()).min(1), name: z.string().min(1), moveAllAttributes: z.boolean().default(true) } }, async ({ sessionId, layerIndices, name, moveAllAttributes }) => run(bridge, sessionId, `var c=activeComp(); var item=c.layers.precompose(${q(layerIndices)},${q(name)},${moveAllAttributes}); return {id:item.id,name:item.name,numLayers:item.numLayers};`));
  server.registerTool("ae_add_to_render_queue", { description: "Add the active composition to the After Effects render queue.", inputSchema: { sessionId: session, outputPath: z.string().optional() } }, async ({ sessionId, outputPath }) => run(bridge, sessionId, `var c=activeComp(); var item=app.project.renderQueue.items.add(c); ${outputPath ? `item.outputModule(1).file=new File(${q(outputPath)});` : ""} return {renderQueueIndex:item.index,status:String(item.status),outputPath:item.outputModule(1).file?item.outputModule(1).file.fsName:null};`));
  server.registerTool("ae_import_subtitles", { description: "Import SRT as one editable text layer with timed layer markers and a Source Text expression.", inputSchema: { sessionId: session, srt: z.string().min(1).optional(), path: z.string().min(1).optional(), layerName: z.string().default("SnarkRoute Subtitles") } }, async ({ sessionId, srt, path, layerName }) => {
    const content = srt ?? (path ? await readFile(path, "utf8") : "");
    if (!content) throw new Error("Provide srt content or path.");
    const cues = parseSrt(content);
    return run(bridge, sessionId, subtitlesJsx(cues, layerName));
  });
}

async function execute(bridge: AeBridgeService, sessionId: string | undefined, command: ExecuteJsxCommand) {
  try { const result = await bridge.execute(sessionId, command); return output(result, !result.ok); }
  catch (error) { return output({ ok: false, error: { message: error instanceof Error ? error.message : String(error) }, logs: [], durationMs: 0 }, true); }
}
function run(bridge: AeBridgeService, sessionId: string | undefined, body: string) { return execute(bridge, sessionId, { code: `(function(){function activeComp(){var c=app.project&&app.project.activeItem;if(!(c instanceof CompItem))throw new Error("No active composition.");return c;} ${body}})()` }); }
function output(value: unknown, isError = false) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], isError }; }
function q(value: unknown): string { return JSON.stringify(value); }

function projectJsx(): string { return `var p=app.project;if(!p)throw new Error("No project is open.");var a=p.activeItem;return {name:p.file?p.file.name:"Untitled Project",path:p.file?p.file.fsName:null,numItems:p.numItems,activeComposition:a instanceof CompItem?a.name:null,dirty:typeof p.dirty==="boolean"?p.dirty:null,appVersion:app.version};`; }
function activeCompJsx(): string { return `var c=activeComp();return {name:c.name,id:c.id,width:c.width,height:c.height,duration:c.duration,frameRate:c.frameRate,currentTime:c.time,workAreaStart:c.workAreaStart,workAreaDuration:c.workAreaDuration,numLayers:c.numLayers};`; }
function listLayersJsx(include: boolean): string { return `var c=activeComp(),out=[];function val(p){try{return p.value;}catch(_){return null;}}for(var i=1;i<=c.numLayers;i++){var l=c.layer(i),t=l.property("ADBE Transform Group"),row={index:l.index,name:l.name,type:l.matchName||l.constructor.name,enabled:l.enabled,selected:l.selected,inPoint:l.inPoint,outPoint:l.outPoint,startTime:l.startTime,parent:l.parent?{index:l.parent.index,name:l.parent.name}:null,transform:{anchorPoint:val(t&&t.property("ADBE Anchor Point")),position:val(t&&t.property("ADBE Position")),scale:val(t&&t.property("ADBE Scale")),rotation:val(t&&(t.property("ADBE Rotate Z")||t.property("ADBE Rotation"))),opacity:val(t&&t.property("ADBE Opacity"))}};${include ? `row.properties=[];for(var j=1;j<=l.numProperties;j++){var p=l.property(j);row.properties.push({name:p.name,matchName:p.matchName,numProperties:p.numProperties});}` : ""}out.push(row);}return out;`; }
function propertyLookup(layerIndex: number, path: string[], action: string): string { return `var c=activeComp(),l=c.layer(${layerIndex});if(!l)throw new Error("Layer not found");var p=l,parts=${q(path)};for(var i=0;i<parts.length;i++){p=p.property(parts[i]);if(!p)throw new Error("Property not found: "+parts.slice(0,i+1).join(" > "));}${action}`; }

export type SubtitleCue = { start: number; duration: number; text: string };
export function parseSrt(source: string): SubtitleCue[] {
  const blocks = source.replace(/\r/g, "").trim().split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split("\n");
    if (/^\d+$/.test(lines[0]?.trim())) lines.shift();
    const timing = lines.shift()?.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!timing) throw new Error(`Invalid SRT timing block: ${block.slice(0, 80)}`);
    const seconds = (offset: number) => Number(timing[offset]) * 3600 + Number(timing[offset + 1]) * 60 + Number(timing[offset + 2]) + Number(timing[offset + 3]) / 1000;
    const start = seconds(1); const end = seconds(5);
    return { start, duration: Math.max(0, end - start), text: lines.join("\r") };
  }).filter((cue) => cue.text.length > 0);
}
function subtitlesJsx(cues: SubtitleCue[], layerName: string): string { return `var c=activeComp(),l=c.layers.addText("");l.name=${q(layerName)};var m=l.property("ADBE Marker"),cues=${q(cues)};for(var i=0;i<cues.length;i++){var v=new MarkerValue(cues[i].text);v.duration=cues[i].duration;m.setValueAtTime(cues[i].start,v);}var st=l.property("ADBE Text Properties").property("ADBE Text Document");st.expression='var m=thisLayer.marker; var s=""; for(var i=1;i<=m.numKeys;i++){var k=m.key(i);if(time>=k.time&&time<k.time+k.duration)s=k.comment;} var d=value;d.text=s;d;';return {layerName:l.name,layerIndex:l.index,markerCount:m.numKeys};`; }
