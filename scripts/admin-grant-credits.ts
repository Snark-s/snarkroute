import { CloudPostgresStorageAdapter } from "../packages/storage/src/cloud-postgres";
import { loadRootEnv } from "../apps/server/src/services/env-loader";

loadRootEnv();

const userId = argumentValue("--user-id");
const amount = Number(argumentValue("--amount"));
const reason = argumentValue("--reason") ?? "admin_cli_grant";

if (!userId || !isUuid(userId) || !Number.isInteger(amount) || amount <= 0) {
  throw new Error("Usage: corepack pnpm run admin:grant-credits -- --user-id <uuid> --amount <int> --reason \"<text>\"");
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required. Example: postgresql://snarkroute:snarkroute@127.0.0.1:5432/snarkroute");

const storage = new CloudPostgresStorageAdapter({ databaseUrl });

try {
  const result = await storage.grantCredits({ userId, amount, reason, actorUserId: null });
  await storage.writeAuditEvent({
    actorUserId: null,
    eventType: "admin_credit_grant_cli",
    metadata: { targetUserId: userId, amount, reason, transactionId: result.transactionId }
  });
  console.log(`Granted ${amount} credits to ${userId}. Balance: ${result.balance}. Transaction: ${result.transactionId}`);
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
