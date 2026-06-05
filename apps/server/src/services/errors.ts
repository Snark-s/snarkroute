export function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export function userFacingErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (/ENOENT|no such file or directory/i.test(message)) {
    if (/input|readFile|image|\.png|\.jpe?g|\.webp/i.test(message)) return "Input image not found. Please re-upload the image.";
    return "Result could not be saved. Please retry.";
  }
  if (/[A-Z]:\\|\/Users\/|\/var\/|\/tmp\/|SnarkRoute|apps[\\/]/i.test(message)) return "Result could not be saved. Please retry.";
  return message;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[^'\"\s,}]+/gi, "$1=[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk-or-[A-Za-z0-9_-]{8,})\b/g, "[redacted]");
}

export function nodePackageUninstallErrorShape(error: unknown): { code: string; statusCode: number; message: string } | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.statusCode !== "number" || typeof record.message !== "string") return null;
  return { code: record.code, statusCode: record.statusCode, message: record.message };
}

