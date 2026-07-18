export type RubPerUsdSource = "config" | "cbr" | "cache";

export type RubPerUsdCache = {
  rubPerUsd: number;
  source: RubPerUsdSource;
  fetchedAt: string;
  date?: string;
};

export type RefreshRubPerUsdOptions = {
  fetchImpl?: typeof fetch;
  cachePath?: string;
};

let cachedRubPerUsd: RubPerUsdCache | null = null;
let warnedMissingRubPerUsd = false;

export function getRubPerUsd(): number | null {
  const configured = positiveNumber(process.env.BOOJUM_RUB_PER_USD);
  if (configured !== null) return configured;
  if (cachedRubPerUsd) return cachedRubPerUsd.rubPerUsd;
  const envCache = parseCacheJson(process.env.BOOJUM_RUB_PER_USD_CACHE_JSON);
  if (envCache) {
    cachedRubPerUsd = envCache;
    return envCache.rubPerUsd;
  }
  warnMissingRubPerUsd();
  return null;
}

export async function refreshRubPerUsd(options: RefreshRubPerUsdOptions = {}): Promise<RubPerUsdCache | null> {
  const configured = positiveNumber(process.env.BOOJUM_RUB_PER_USD);
  const cachePath = options.cachePath ?? process.env.BOOJUM_RUB_PER_USD_CACHE_PATH ?? "data/cache/fx/rub-usd.json";
  try {
    const rate = await fetchCbrRubPerUsd(options.fetchImpl ?? fetch);
    cachedRubPerUsd = { rubPerUsd: rate.rubPerUsd, source: "cbr", fetchedAt: new Date().toISOString(), date: rate.date };
    await writeRubPerUsdCache(cachePath, cachedRubPerUsd);
    process.env.BOOJUM_RUB_PER_USD_CACHE_JSON = JSON.stringify(cachedRubPerUsd);
    return cachedRubPerUsd;
  } catch (error) {
    const fileCache = await readRubPerUsdCache(cachePath);
    if (fileCache) {
      cachedRubPerUsd = fileCache;
      process.env.BOOJUM_RUB_PER_USD_CACHE_JSON = JSON.stringify(fileCache);
      return fileCache;
    }
    if (configured !== null) {
      cachedRubPerUsd = { rubPerUsd: configured, source: "config", fetchedAt: new Date().toISOString() };
      process.env.BOOJUM_RUB_PER_USD_CACHE_JSON = JSON.stringify(cachedRubPerUsd);
      return cachedRubPerUsd;
    }
    console.warn(`[fx] RUB/USD refresh failed and no BOOJUM_RUB_PER_USD or cached rate is available: ${error instanceof Error ? error.message : String(error)}`);
    warnMissingRubPerUsd();
    return null;
  }
}

async function fetchCbrRubPerUsd(fetchImpl: typeof fetch): Promise<{ rubPerUsd: number; date?: string }> {
  const jsonResponse = await fetchImpl("https://www.cbr-xml-daily.ru/daily_json.js");
  if (jsonResponse.ok) {
    const json = await jsonResponse.json() as { Date?: string; Valute?: { USD?: { Value?: unknown } } };
    const rate = positiveNumber(json.Valute?.USD?.Value);
    if (rate !== null) return { rubPerUsd: rate, date: json.Date };
  }
  const xmlResponse = await fetchImpl("https://www.cbr.ru/scripts/XML_daily.asp");
  if (!xmlResponse.ok) throw new Error(`CBR XML daily returned HTTP ${xmlResponse.status}`);
  const xml = await xmlResponse.text();
  const match = /<CharCode>USD<\/CharCode>[\s\S]*?<Value>([^<]+)<\/Value>/.exec(xml);
  const rate = positiveNumber(match?.[1]?.replace(",", "."));
  if (rate === null) throw new Error("CBR daily response did not include a valid USD rate.");
  const date = /<ValCurs[^>]*Date="([^"]+)"/.exec(xml)?.[1];
  return { rubPerUsd: rate, date };
}

async function readRubPerUsdCache(cachePath: string): Promise<RubPerUsdCache | null> {
  try {
    const fs = await import(nodeModule("node:fs/promises")) as typeof import("node:fs/promises");
    return parseCacheJson(await fs.readFile(cachePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeRubPerUsdCache(cachePath: string, cache: RubPerUsdCache): Promise<void> {
  const fs = await import(nodeModule("node:fs/promises")) as typeof import("node:fs/promises");
  const path = await import(nodeModule("node:path")) as typeof import("node:path");
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function nodeModule(specifier: string): string {
  return specifier;
}

function parseCacheJson(value: unknown): RubPerUsdCache | null {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const rubPerUsd = positiveNumber(parsed.rubPerUsd);
    if (rubPerUsd === null) return null;
    const source = parsed.source === "cbr" || parsed.source === "config" || parsed.source === "cache" ? parsed.source : "cache";
    return {
      rubPerUsd,
      source,
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : new Date().toISOString(),
      date: typeof parsed.date === "string" ? parsed.date : undefined
    };
  } catch {
    return null;
  }
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function warnMissingRubPerUsd(): void {
  if (warnedMissingRubPerUsd) return;
  warnedMissingRubPerUsd = true;
  console.warn("[fx] RUB/USD rate is unavailable. Set BOOJUM_RUB_PER_USD or run the pricing refresh to populate the cached CBR rate.");
}
