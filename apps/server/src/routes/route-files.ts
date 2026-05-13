import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadRouteFromText } from "@snarkroute/protocol";

export async function listRouteFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listRouteFiles(path)));
    else if (/\.(orp|route)(\.(json|ya?ml))?$|\.json$|\.ya?ml$/i.test(entry.name)) files.push(path);
  }
  return files.sort();
}

export async function loadExampleRoute(path: string): Promise<unknown> {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new Error(`Example route was not found: ${path}`);
  const text = await readFile(path, "utf8");
  return loadRouteFromText(text, path);
}
