import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "../src/server-paths";
import { TechRadarService } from "../src/services/tech-radar/service";

// Live source-only smoke. No installations, GPU, paid APIs or running-service restart.
const radar = new TechRadarService();
try {
  await radar.init();
  const input = process.argv.find(arg => arg.startsWith("https://")) ?? "https://github.com/Blizaine/Maestro";
  const submitted = await radar.enqueue(input, process.argv.includes("--repeat"));
  console.log(JSON.stringify({ submitted }));
  await radar.drain();
  const state = await radar.catalog(); const project = state.projects.find(p => p.id === submitted.projectId)!;
  const research = project.research.at(-1); const job = state.jobs.filter(j => j.projectId === project.id).at(-1);
  const report = { canonicalUrl: project.canonicalUrl, job, research };
  const directory = join(repoRoot, "data", "radars", "tech-radar"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "last-smoke.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: job?.status, error: job?.error, sources: research?.snapshot.sources.length ?? job?.snapshot?.sources.length ?? 0, recommendation: research?.recommendation, capabilities: research?.comparison.map(c => ({ name: c.name, newToCatalog: c.newToCatalog, overlaps: c.overlaps.map(t => t.name) })) }, null, 2));
  if (job?.status !== "completed") process.exitCode = 1;
} finally { await radar.close(); }
