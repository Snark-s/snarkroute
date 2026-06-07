import { CloudPostgresStorageAdapter } from "@snarkroute/storage";

let cloudStorage: CloudPostgresStorageAdapter | null = null;

export function getCloudStorage(): CloudPostgresStorageAdapter {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required when APP_MODE=cloud.");
  cloudStorage ??= new CloudPostgresStorageAdapter({ databaseUrl });
  return cloudStorage;
}
