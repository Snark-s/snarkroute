import { CloudPostgresStorageAdapter } from "../packages/storage/src/cloud-postgres";
import { loadRootEnv } from "../apps/server/src/services/env-loader";

loadRootEnv();

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required. Example: postgresql://snarkroute:snarkroute@127.0.0.1:5432/snarkroute");

const storage = new CloudPostgresStorageAdapter({ databaseUrl });

try {
  const users = await storage.listAdminUsers();
  console.log(["id", "role", "created_at", "provider", "provider_subject_hash"].join("\t"));
  for (const user of users) {
    console.log([
      user.id,
      user.role,
      user.createdAt,
      user.provider ?? "",
      user.providerSubjectHashPrefix ?? ""
    ].join("\t"));
  }
} finally {
  await storage.close();
}
