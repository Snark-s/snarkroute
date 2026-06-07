import { runCloudPostgresMigrations } from "../packages/storage/src/cloud-postgres";

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required. Example: postgresql://snarkroute:snarkroute@127.0.0.1:5432/snarkroute");
}

await runCloudPostgresMigrations(databaseUrl);
console.log("Cloud Postgres migrations applied.");
