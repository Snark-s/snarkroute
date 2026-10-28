import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appMode } from "../services/env";
import { errorMessage } from "../services/errors";
import { techRadarService, type TechRadarService } from "../services/tech-radar/service";

export const TECH_RADAR_INSTRUCTIONS = " Tech Radar: tech_radar_research queues public GitHub source-only research, tech_radar_catalog reads projects and workshop capabilities. No installations or paid API calls. Registry entries are declared capabilities, not proof of working tools; preserve the owner's decisions separately from recommendations.";
export function registerTechRadarTools(server: McpServer, service?: TechRadarService) {
  const run = async (work: (radar: TechRadarService) => Promise<unknown>) => {
    try {
      if (appMode() !== "local") throw new Error("Технорадар доступен только локально.");
      return { content: [{ type: "text" as const, text: JSON.stringify(await work(service ?? techRadarService())) }] };
    } catch (error) { return { isError: true, content: [{ type: "text" as const, text: errorMessage(error) }] }; }
  };
  server.registerTool("tech_radar_research", { description: "Queue durable public GitHub research, compare functional capabilities with workshop tools, and prepare a test plan. Uses subscription model without tools or paid API fallback. Never installs or runs the researched project. Pass repeat=true to re-research; normal duplicate URLs return the known project.", inputSchema: { url: z.string().max(2048), repeat: z.boolean().optional() } }, async input => run(radar => radar.enqueue(input.url, input.repeat)));
  server.registerTool("tech_radar_catalog", { description: "Read Tech Radar projects, research results, queue, decisions, sources and persistent capability map. Registry presence does not prove local readiness.", inputSchema: { projectId: z.string().optional() }, annotations: { readOnlyHint: true } }, async input => run(async radar => {
    const state = await radar.catalog();
    return { projects: state.projects.filter(p => !input.projectId || p.id === input.projectId).map(p => ({ ...p, research: p.research.slice(-1).map(r => ({ ...r, snapshot: { ...r.snapshot, sources: r.snapshot.sources.map(({ text, ...s }) => s) } })) })), jobs: state.jobs.filter(j => !input.projectId || j.projectId === input.projectId).map(({ snapshot, ...job }) => job), capabilities: await radar.capabilities() };
  }));
}
