export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function nodePackageUninstallErrorShape(error: unknown): { code: string; statusCode: number; message: string } | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.statusCode !== "number" || typeof record.message !== "string") return null;
  return { code: record.code, statusCode: record.statusCode, message: record.message };
}

