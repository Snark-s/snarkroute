import { CloudPostgresStorageAdapter } from "../packages/storage/src/cloud-postgres";
import { loadRootEnv } from "../apps/server/src/services/env-loader";

loadRootEnv();

const userId = argumentValue("--user-id");
const limit = Number(argumentValue("--limit") ?? 100);

if (userId && !isUuid(userId)) {
  throw new Error("Usage: corepack pnpm run admin:billing-ledger -- --user-id <uuid> [--limit <int>]");
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required. Example: postgresql://snarkroute:snarkroute@127.0.0.1:5432/snarkroute");

const storage = new CloudPostgresStorageAdapter({ databaseUrl });

try {
  const transactions = await storage.listCreditTransactions({ userId, limit: Number.isInteger(limit) ? limit : 100 });
  console.log(["created_at", "user_id", "type", "amount", "status", "run_id", "reservation_id", "id"].join("\t"));
  for (const tx of transactions) {
    console.log([
      tx.createdAt,
      tx.userId,
      tx.transactionType,
      tx.amount,
      tx.status,
      tx.runId ?? "",
      tx.reservationId ?? "",
      tx.id
    ].join("\t"));
  }
} finally {
  await storage.close();
}

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1]?.trim();
  return value || null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
