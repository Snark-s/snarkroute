export function normalizeStableDiffusionModels(value: unknown): Array<{ title: string; modelName?: string; filename?: string; hash?: string }> {
  if (!Array.isArray(value)) return [];
  const models: Array<{ title: string; modelName?: string; filename?: string; hash?: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : typeof record.model_name === "string" ? record.model_name : "";
    if (!title.trim()) continue;
    models.push({
      title,
      modelName: typeof record.model_name === "string" ? record.model_name : undefined,
      filename: typeof record.filename === "string" ? record.filename : undefined,
      hash: typeof record.hash === "string" ? record.hash : undefined
    });
  }
  return models;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

