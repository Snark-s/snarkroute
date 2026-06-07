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

export function normalizeComfyUiModels(value: unknown): Array<{ title: string; modelName: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const checkpointLoader = (value as Record<string, unknown>).CheckpointLoaderSimple;
  if (!checkpointLoader || typeof checkpointLoader !== "object" || Array.isArray(checkpointLoader)) return [];
  const input = (checkpointLoader as Record<string, unknown>).input;
  const required = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).required : undefined;
  const ckptName = required && typeof required === "object" && !Array.isArray(required) ? (required as Record<string, unknown>).ckpt_name : undefined;
  const filenames = Array.isArray(ckptName) && Array.isArray(ckptName[0]) ? ckptName[0] : [];
  return filenames.flatMap((filename) => typeof filename === "string" && filename.trim()
    ? [{ title: filename, modelName: filename }]
    : []);
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

