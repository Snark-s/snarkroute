import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeGithubUrl, GithubSources } from "./github";
import { analyseProject, groundAnalysis, recommend, validateAnalysis } from "./analysis";
import { TechRadarService } from "./service";
import type { Analysis, Snapshot } from "./types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "tech-radar-")); roots.push(root); return root; }
export const snapshot: Snapshot = {
  canonicalUrl: "https://github.com/demo/studio", name: "studio", description: "Local studio", branch: "main", version: "v1", updatedAt: "2026-10-01", archived: false, license: "MIT", fetchedAt: "2026-10-25T00:00:00Z", warnings: [],
  sources: [{ id: "readme", url: "https://github.com/demo/studio/blob/main/README.md", title: "README", kind: "readme", text: "Director plans shots aligned to music. Requires NVIDIA 16 GB. MIT license." }]
};
const finding = { text: "Режиссёр планирует кадры под музыку", kind: "claim" as const, citations: [{ sourceId: "readme", quote: "Director plans shots aligned to music." }] };
export const analysis: Analysis = {
  description: finding, capabilities: [{ id: "music-shot-planning", name: "Планирование кадров под музыку", finding, evidence: "declared" }], requirements: [finding], integration: [finding], licensing: [finding], risks: [finding], maturity: [finding], practicalValue: { ...finding, kind: "inference" }, superiority: { text: "Неизвестно", kind: "unknown", citations: [] }, suggestedStatus: "test", rationale: finding,
  testPlan: { goal: "Проверить планирование под музыку", steps: ["Разметить такты тестового трека", "Сравнить план кадров с тактами"], success: ["Склейки совпадают с тактами"], resources: ["Тестовый трек"], risks: ["Непроверенная лицензия весов"], cleanup: ["Удалить отдельную папку эксперимента"] }
};
function service(root: string, extra: Partial<ConstructorParameters<typeof TechRadarService>[0]> = {}) {
  return new TechRadarService({ directory: root, collect: vi.fn(async () => structuredClone(snapshot)), analyse: vi.fn(async () => structuredClone(analysis)), inventory: async () => [], ...extra });
}

describe("GitHub intake and sources", () => {
  it("canonicalizes repository links without duplicates", () => {
    expect(normalizeGithubUrl("https://www.github.com/Demo/Studio.git/tree/main?tab=readme#x").sourceKey).toBe("github:demo/studio");
  });
  it.each(["http://github.com/a/b", "https://github.com.evil/a/b", "https://user@github.com/a/b", "https://127.0.0.1/a/b", "https://github.com/a/%2e%2e", "file:///etc/passwd", "https://github.com:444/a/b", "https://github.com/a/b/../../c/d"])('rejects unsafe URL %s', url => expect(() => normalizeGithubUrl(url)).toThrow());
  it("caches public API results and handles API failures without executing anything", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ name: "studio" }), { headers: { etag: '"v1"' } }));
    const client = new GithubSources({ directory: await directory(), fetchImpl: fetcher as typeof fetch });
    await client.request("/repos/demo/studio"); await client.request("/repos/demo/studio");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toBeDefined();
    const denied = new GithubSources({ directory: await directory(), fetchImpl: vi.fn(async () => new Response("secret", { status: 404 })) as typeof fetch });
    await expect(denied.collect("https://github.com/demo/private")).rejects.toThrow(/приватн|доступ/i);
  });
  it("respects rate limiting and rejects redirects and malformed API JSON", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }));
    const client = new GithubSources({ directory: await directory(), fetchImpl: fetcher as typeof fetch });
    await expect(client.request("/repos/a/b")).rejects.toThrow(/лимит/i);
    await expect(client.request("/repos/c/d")).rejects.toThrow(/лимит/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const bad = new GithubSources({ directory: await directory(), fetchImpl: vi.fn(async () => new Response("<html>")) as typeof fetch });
    await expect(bad.request("/repos/a/b")).rejects.toThrow(/JSON/i);
    await expect(bad.request("https://evil.test")).rejects.toThrow();
  });
  it("prioritizes root licenses, manifests and Director documentation over vendored licenses", async () => {
    const files: Record<string, string> = { "README.md": "Local studio with Director Mode", "LICENSE": "Non-commercial evaluation only", "THIRD_PARTY_NOTICES.md": "Model licenses vary", "VERSION": "v1.2.3", "app/package.json": '{"dependencies":{"test":"1"}}', "docs/Director-controls.md": "Plans music shots" };
    for (let i = 0; i < 20; i++) files[`app/vendor-${i}/LICENSE`] = "MIT";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = decodeURIComponent(new URL(String(input)).pathname); let value: unknown;
      const file = path.endsWith("/readme") ? "README.md" : path.includes("/contents/") ? path.split("/contents/")[1] : undefined;
      if (file) value = { path: file, encoding: "base64", size: files[file].length, content: Buffer.from(files[file]).toString("base64") };
      else if (path.includes("/git/trees/")) value = { tree: Object.keys(files).map(path => ({ path, type: "blob" })) };
      else if (/\/(releases|issues)$/.test(path)) value = [];
      else value = { name: "studio", default_branch: "main", private: false, license: { spdx_id: "NOASSERTION" } };
      return new Response(JSON.stringify(value));
    });
    const result = await new GithubSources({ directory: await directory(), fetchImpl: fetcher as typeof fetch }).collect("https://github.com/demo/studio");
    expect(result.sources.map(s => s.title)).toEqual(expect.arrayContaining(["LICENSE", "THIRD_PARTY_NOTICES.md", "docs/Director-controls.md", "app/package.json"]));
    expect(result.version).toBe("v1.2.3"); expect(fetcher.mock.calls.length).toBeLessThanOrEqual(13);
  });
  it.each([302, 500])("reports GitHub HTTP %s without following unsafe redirects", async status => {
    const fetcher = vi.fn(async () => new Response("", { status }));
    const client = new GithubSources({ directory: await directory(), fetchImpl: fetcher as typeof fetch });
    await expect(client.request("/repos/demo/studio")).rejects.toThrow(`(${status})`);
    expect(fetcher.mock.calls[0]).toBeDefined(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("revalidates cached responses with ETag on an explicit repeat", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"name":"studio"}', { headers: { etag: '"one"' } })).mockResolvedValueOnce(new Response(null, { status: 304 }));
    const client = new GithubSources({ directory: await directory(), fetchImpl: fetcher });
    await client.request("/repos/demo/studio"); expect(await client.request("/repos/demo/studio", true)).toEqual({ name: "studio" });
    expect(fetcher.mock.calls[1][1].headers["If-None-Match"]).toBe('"one"');
  });
});

describe("grounded analysis", () => {
  it("rejects invented citations and local verification from an LLM", () => {
    expect(() => validateAnalysis({ ...analysis, description: { ...finding, citations: [{ sourceId: "invented", quote: "abc" }] } }, snapshot)).toThrow();
    expect(() => validateAnalysis({ ...analysis, description: { ...finding, citations: [{ sourceId: "readme", quote: "Fabricated" }] } }, snapshot)).toThrow();
    const result = validateAnalysis({ ...analysis, capabilities: [{ ...analysis.capabilities[0], evidence: "local_test" }] }, snapshot);
    expect(result.capabilities[0].evidence).toBe("declared");
  });
  it("does not turn a README assertion into a verified fact", () => {
    expect(validateAnalysis({ ...analysis, description: { ...finding, kind: "fact" } }, snapshot).description.kind).toBe("claim");
    expect(() => validateAnalysis({} , snapshot)).toThrow();
  });
  it("retries a malformed answer with the same public sources and does not send local paths", async () => {
    const invoker = vi.fn().mockResolvedValueOnce({ text: "invalid", provider: "codex-subscription", model: "test" }).mockResolvedValueOnce({ text: JSON.stringify(analysis), provider: "codex-subscription", model: "test" });
    const result = await analyseProject(snapshot, { schemaVersion: 1, projects: [], jobs: [], inventory: [{ id: "local", name: "Image", source: "C:/private/secret.env", capabilityIds: ["image-generation"], evidence: "declared", availability: "unverified" }] }, invoker);
    expect(result.model.providerCost).toBe(0); expect(invoker).toHaveBeenCalledTimes(2);
    expect(invoker.mock.calls[0][0]).toMatchObject({ readOnlyJson: true, outputSchema: expect.any(Object) });
    expect(invoker.mock.calls[0][0].prompt).not.toContain("C:/private");
  });
  it("marks an unsupported finding unknown and removes an unsupported capability", () => {
    const invalid = { ...finding, citations: [{ sourceId: "readme", quote: "Missing evidence" }] };
    const result = groundAnalysis({ ...analysis, requirements: [invalid], capabilities: [...analysis.capabilities, { id: "invented-feature", name: "Недоказанная функция", finding: invalid }] }, snapshot);
    expect(result.analysis.requirements[0].kind).toBe("unknown"); expect(result.analysis.capabilities).toHaveLength(1); expect(result.warnings).toHaveLength(1);
  });
  it("never recommends implementation without a locally verified improvement", () => {
    const comparison = [{ capabilityId: "music-shot-planning", name: "Планирование", newToCatalog: true, overlaps: [] }];
    expect(recommend({ ...analysis, suggestedStatus: "implement" }, comparison, snapshot).status).toBe("test");
    expect(recommend(analysis, [{ ...comparison[0], newToCatalog: false }], snapshot).status).toBe("watch");
  });
});

describe("durable research queue", () => {
  it("deduplicates concurrently, persists decisions independently and survives reopening", async () => {
    const root = await directory(); const radar = service(root); await radar.init();
    const results = await Promise.all([radar.enqueue("https://github.com/demo/studio"), radar.enqueue("https://github.com/DEMO/STUDIO.git")]);
    expect(results.filter(r => r.duplicate)).toHaveLength(1);
    await radar.drain();
    let state = await radar.catalog(); expect(state.projects).toHaveLength(1); expect(state.jobs[0].status).toBe("completed");
    expect(state.projects[0].research[0].recommendation.status).toBe("test");
    await radar.decide(state.projects[0].id, "watch", "Вернуться позже"); await radar.close();
    const reopened = service(root); await reopened.init(); state = await reopened.catalog();
    expect(state.projects[0].decisions[0].status).toBe("watch"); expect(state.projects[0].research).toHaveLength(1);
    expect(state.projects[0].watch.enabled).toBe(false); await reopened.close();
  });
  it("keeps sources and the previous analysis after a failed repeat", async () => {
    const radar = service(await directory()); await radar.init(); const first = await radar.enqueue(snapshot.canonicalUrl); await radar.drain();
    const failing = service((radar as any).directory, { analyse: async () => { throw new Error("Model unavailable"); } });
    await radar.close(); await failing.init(); await failing.enqueue(snapshot.canonicalUrl, true); await failing.drain();
    const state = await failing.catalog(); expect(state.projects[0].research).toHaveLength(1); expect(state.jobs.at(-1)?.status).toBe("failed"); expect(state.jobs.at(-1)?.snapshot?.sources.length).toBeGreaterThan(0);
    expect(first.duplicate).toBe(false); await failing.close();
  });
  it("recovers an interrupted job and reports only meaningful changes", async () => {
    const root = await directory(); const radar = service(root); await radar.init(); await radar.enqueue(snapshot.canonicalUrl); await radar.drain(); await radar.close();
    const path = join(root, "catalog.json"); const saved = JSON.parse(await readFile(path, "utf8"));
    saved.jobs.push({ ...saved.jobs[0], id: "interrupted", status: "analysing", snapshot }); await writeFile(path, JSON.stringify(saved));
    const recovered = service(root); await recovered.init(); await recovered.drain();
    let state = await recovered.catalog(); expect(state.jobs.at(-1)?.status).toBe("completed"); expect(state.projects[0].research.at(-1)?.changes).toEqual([]); expect(state.projects[0].notification).toBeUndefined(); await recovered.close();
    const changed = service(root, { collect: async () => ({ ...snapshot, license: "Non-commercial" }) }); await changed.init(); await changed.enqueue(snapshot.canonicalUrl, true); await changed.drain();
    state = await changed.catalog(); expect(state.projects[0].notification?.changes.join(" ")).toMatch(/лиценз/i); await changed.close();
  });
  it("retains a last good file and refuses a corrupt catalog", async () => {
    const root = await directory(); const radar = service(root); await radar.init(); await radar.enqueue(snapshot.canonicalUrl); await radar.drain(); await radar.close();
    await writeFile(join(root, "catalog.json"), "broken");
    await expect(service(root).init()).rejects.toThrow(/каталог/i);
  });
  it("prevents a second process owner from overwriting the live catalog", async () => {
    const root = await directory(); const first = service(root); await first.init();
    const second = service(root); await expect(second.init()).rejects.toThrow(/другим процессом/);
    await first.close(); const reopened = service(root); await reopened.init(); await reopened.close();
  });
  it("checks watched projects only when explicitly enabled and due", async () => {
    const root = await directory(); let now = new Date("2026-10-01T00:00:00Z");
    const radar = service(root, { now: () => now }); await radar.init();
    const result = await radar.enqueue(snapshot.canonicalUrl); await radar.drain(); await radar.decide(result.projectId, "watch");
    now = new Date("2026-10-10T00:00:00Z"); await radar.checkDue(); await radar.drain(); expect((await radar.catalog()).jobs).toHaveLength(1);
    await radar.watch(result.projectId, true, 7); await radar.checkDue(); await radar.drain(); expect((await radar.catalog()).jobs).toHaveLength(2);
    await radar.checkDue(); await radar.drain(); expect((await radar.catalog()).jobs).toHaveLength(2); await radar.close();
  });
});
