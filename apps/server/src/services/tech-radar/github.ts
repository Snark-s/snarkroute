import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot, Source } from "./types";

export function normalizeGithubUrl(input: string) {
  if (typeof input !== "string" || input.length > 2048 || /[\\\s%]/.test(input.trim()) || /\/(?:\.{1,2})(?:\/|$)/.test(input)) throw new Error("Некорректная GitHub-ссылка.");
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Вставьте полную HTTPS-ссылку на GitHub."); }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname) || url.port || url.username || url.password) throw new Error("Поддерживаются только публичные HTTPS-ссылки github.com без авторизации и нестандартного порта.");
  const [owner, rawRepo] = url.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/i, "");
  if (!owner || !repo || !/^[a-z\d][a-z\d-]{0,38}$/i.test(owner) || !/^[\w.-]{1,100}$/.test(repo) || /^\.+$/.test(repo)) throw new Error("В ссылке нужны владелец и имя репозитория.");
  return { sourceType: "github" as const, sourceKey: `github:${owner.toLowerCase()}/${repo.toLowerCase()}`, canonicalUrl: `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`, owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

type Cache = { fetchedAt: number; etag?: string; value: unknown };
type Options = { directory: string; fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number };
/** Fixed public API origin, no user tokens, redirects, raw URL fetches or executable content. */
export class GithubSources {
  private blockedUntil = 0;
  private requests: number[] = [];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly options: Options) { this.fetchImpl = options.fetchImpl ?? fetch; this.now = options.now ?? Date.now; }

  async request(path: string, fresh = false): Promise<unknown> {
    if (!/^\/repos\/[a-z\d-]+\/[\w.-]+(?:[/?][\w./?=&%+-]*)?$/i.test(path) || path.includes("..") || path.includes("//")) throw new Error("Недопустимый путь GitHub API.");
    const cachePath = join(this.options.directory, `${createHash("sha256").update(path).digest("hex")}.json`);
    let cached: Cache | undefined;
    try { cached = JSON.parse(await readFile(cachePath, "utf8")); } catch { /* A cache miss is safe. */ }
    if (!fresh && cached && this.now() - cached.fetchedAt < (this.options.ttlMs ?? 3_600_000)) return cached.value;
    this.requests = this.requests.filter(at => at > this.now() - 3_600_000);
    if (this.now() < this.blockedUntil || this.requests.length >= 50) throw new Error("Достигнут лимит GitHub. Повторите исследование после сброса лимита (до часа).");
    this.requests.push(this.now());
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "SnarkRoute-TechRadar", ...(cached?.etag ? { "If-None-Match": cached.etag } : {}) },
      redirect: "error", signal: AbortSignal.timeout(25_000)
    });
    if (response.status === 429 || response.status === 403) {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      const retry = Number(response.headers.get("retry-after")) * 1000;
      this.blockedUntil = Math.max(this.now() + (retry || 60_000), reset || 0);
      throw new Error("GitHub ограничил доступ или исчерпан лимит запросов. Повторите позже.");
    }
    if (response.status === 304 && cached) {
      cached.fetchedAt = this.now(); await this.cache(cachePath, cached); return cached.value;
    }
    if (response.status === 404) throw new Error("Репозиторий или файл недоступен: он отсутствует либо приватный. Авторизация для приватных репозиториев в MVP не используется.");
    if (!response.ok || response.redirected) throw new Error(`Ошибка GitHub API (${response.status}).`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Пустой ответ GitHub API.");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1_500_000) throw new Error("Ответ GitHub слишком большой для безопасного исследования.");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("GitHub вернул некорректный JSON."); }
    await this.cache(cachePath, { value, fetchedAt: this.now(), etag: response.headers.get("etag") ?? undefined });
    if (response.headers.get("x-ratelimit-remaining") === "0") this.blockedUntil = Number(response.headers.get("x-ratelimit-reset")) * 1000 || this.now() + 3_600_000;
    return value;
  }

  async collect(input: string, fresh = false): Promise<Snapshot> {
    const link = normalizeGithubUrl(input); const base = `/repos/${link.owner}/${link.repo}`;
    const metadata = record(await this.request(base, fresh));
    if (typeof metadata.name !== "string" || typeof metadata.default_branch !== "string") throw new Error("Некорректные метаданные репозитория GitHub.");
    if (metadata.private === true) throw new Error("Приватные репозитории не исследуются.");
    const branch = metadata.default_branch;
    const sources: Source[] = [{ id: "metadata", title: "Метаданные GitHub", kind: "metadata", url: link.canonicalUrl, text: JSON.stringify({ name: metadata.name, description: metadata.description, topics: metadata.topics, pushed_at: metadata.pushed_at, archived: metadata.archived, license: metadata.license, open_issues_count: metadata.open_issues_count, language: metadata.language }, null, 2) }];
    const warnings: string[] = [];
    const optional = async (id: string, title: string, kind: Source["kind"], path: string, url: string, transform?: (value: unknown) => string) => {
      try {
        const value = await this.request(`${base}${path}`, fresh);
        const text = transform ? transform(value) : JSON.stringify(value, null, 2).slice(0, 40_000);
        sources.push({ id, title, kind, url, text: text.slice(0, 45_000) }); return value;
      } catch (error) { warnings.push(`${title}: ${error instanceof Error ? error.message : "источник недоступен"}`); return null; }
    };
    const readme = await optional("readme", "README", "readme", "/readme", `${link.canonicalUrl}#readme`, decodeFile);
    if (readme && typeof record(readme).path === "string") sources.find(s => s.id === "readme")!.url = blobUrl(link.canonicalUrl, branch, String(record(readme).path));
    const tree = record(await optional("tree", "Структура репозитория", "tree", `/git/trees/${encodeURIComponent(branch)}?recursive=1`, `${link.canonicalUrl}/tree/${encodeURIComponent(branch)}`, v => {
      const doc = record(v); const entries = Array.isArray(doc.tree) ? doc.tree : [];
      const paths = entries.map(e => String(record(e).path ?? "")).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
      return JSON.stringify({ truncated: doc.truncated, paths: paths.slice(0, 300) });
    }));
    if (tree.truncated) warnings.push("GitHub вернул неполную структуру; каталог не считается исчерпывающим.");
    const releases = await optional("releases", "Последние релизы", "releases", "/releases?per_page=3", `${link.canonicalUrl}/releases`, v => JSON.stringify(Array.isArray(v) ? v.map(e => { const r = record(e); return { tag_name: r.tag_name, published_at: r.published_at, body: r.body, prerelease: r.prerelease }; }) : v));
    await optional("issues", "Открытые проблемы (выборка, до 10)", "issues", "/issues?state=open&sort=updated&per_page=10", `${link.canonicalUrl}/issues`, v => JSON.stringify(Array.isArray(v) ? v.filter(e => !record(e).pull_request).map(e => { const r = record(e); return { number: r.number, title: r.title, body: String(r.body ?? "").slice(0, 1800), labels: r.labels, html_url: r.html_url }; }) : v));
    const entries = Array.isArray(tree.tree) ? tree.tree.map(record) : [];
    const paths = entries.filter(e => e.type === "blob" && typeof e.path === "string" && /^[\w./ -]+$/.test(e.path) && !String(e.path).split("/").some(p => p === ".." || p.startsWith("."))).map(e => String(e.path));
    const ranked = paths.map(path => ({ path, score: /^(license|copying|third_party_notices)(\.[\w-]+)?$/i.test(path) ? 120 : /^(version|changelog\.md)$/i.test(path) ? 110 : /^(?:app\/)?(requirements[^/]*\.txt|pyproject\.toml|package\.json)$/i.test(path) ? 105 : /^docs\/[^/]*(director|api|licens|hardware|install|integrat|requirements)/i.test(path) ? 100 : /(^|\/)(license|copying|third_party_notices)/i.test(path) ? 20 : 0 })).filter(e => e.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    // Keep public unauthenticated GitHub usage bounded; never follow README links.
    for (const { path } of ranked.slice(0, 8)) {
      await optional(`file:${path}`, path, /requirements|pyproject|package\.json/i.test(path) ? "manifest" : "document", `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, blobUrl(link.canonicalUrl, branch, path), decodeFile);
    }
    warnings.push("Код не запускался. Установка, скорость, качество генерации и совместимость локально не проверены. Список проблем и документация исследованы выборочно.");
    const release = Array.isArray(releases) ? record(releases[0]) : {};
    const versionFile = sources.find(s => s.title.toLowerCase() === "version")?.text.trim();
    return { canonicalUrl: link.canonicalUrl, name: metadata.name, description: typeof metadata.description === "string" ? metadata.description : "", branch, version: typeof release.tag_name === "string" ? release.tag_name : versionFile && versionFile.length < 80 ? versionFile : null, updatedAt: typeof metadata.pushed_at === "string" ? metadata.pushed_at : null, archived: metadata.archived === true, license: typeof record(metadata.license).spdx_id === "string" ? String(record(metadata.license).spdx_id) : null, sources, warnings, fetchedAt: new Date(this.now()).toISOString() };
  }
  private async cache(path: string, value: Cache) {
    await mkdir(this.options.directory, { recursive: true });
    const temporary = `${path}.tmp`; await writeFile(temporary, JSON.stringify(value), "utf8"); await rename(temporary, path);
  }
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function decodeFile(value: unknown): string {
  const file = record(value);
  if (file.encoding !== "base64" || typeof file.content !== "string" || Number(file.size) > 250_000) throw new Error("Файл слишком большой, неподдерживаемый или недоступен.");
  return Buffer.from(file.content, "base64").toString("utf8");
}
function blobUrl(base: string, branch: string, path: string) { return `${base}/blob/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`; }
