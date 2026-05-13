import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
export function findExistingDirectory(...parts: string[]): string {
  let directory = process.cwd();
  while (true) {
    const candidate = join(directory, ...parts);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(directory, "..");
    if (parent === directory) return join(process.cwd(), ...parts);
    directory = parent;
  }
}

export function findExistingFile(...parts: string[]): string {
  let directory = process.cwd();
  while (true) {
    const candidate = join(directory, ...parts);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(directory, "..");
    if (parent === directory) return join(process.cwd(), ...parts);
    directory = parent;
  }
}
export const envPath = join(process.cwd(), ".env");
export const assetsDirectory = join(process.cwd(), "data", "assets");
export const providerLinksPath = findExistingFile("data", "provider-links.json");
export const openRouterMappingsPath = findExistingFile("data", "model-registry", "openrouter-mappings.json");
export const openRouterCatalogCachePath = join(process.cwd(), "data", "cache", "openrouter-models.json");
export const examplesDirectory = findExistingDirectory("examples", "routes");
export const getLedgerPath = () => process.env.SNARKROUTE_LEDGER_PATH ?? join(process.cwd(), "data", "ledger", "runs.jsonl");