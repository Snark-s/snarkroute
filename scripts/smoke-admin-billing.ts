import { randomUUID } from "node:crypto";
import { buildServer } from "../apps/server/src/app";
import { getCloudStorage } from "../apps/server/src/services/cloud-storage";

process.env.APP_MODE ??= "cloud";
process.env.APP_PRODUCT ??= "boojum";
process.env.APP_DEV_UI ??= "true";
process.env.ALLOW_NEGATIVE_BALANCE ??= "false";
process.env.BOOJUM_START_CREDITS ??= "0";
process.env.SNARKROUTE_NO_LISTEN ??= "1";
process.env.DATABASE_URL ??= "postgresql://snarkroute:snarkroute@127.0.0.1:5432/snarkroute";

const adminCookie = "boojum_dev_identity=admin";
const userCookie = "boojum_dev_identity=user";

async function main(): Promise<void> {
  const storage = getCloudStorage();
  const smokeUserId = randomUUID();
  await storage.ensureUser({ id: smokeUserId });

  const app = await buildServer();
  await app.ready();
  try {
    await app.inject({ method: "GET", url: "/api/auth/current", headers: { cookie: userCookie } });
    await app.inject({ method: "GET", url: "/api/auth/current", headers: { cookie: adminCookie } });

    const userDenied = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: userCookie } });
    assertStatus("user cannot list admin users", userDenied.statusCode, 403);

    const adminList = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: adminCookie } });
    assertStatus("admin can list users", adminList.statusCode, 200);
    if (!adminList.json().users.some((user: { id: string }) => user.id === smokeUserId)) {
      throw new Error("Admin users list does not include smoke user.");
    }

    const beforeCard = await app.inject({
      method: "GET",
      url: `/api/admin/users/${smokeUserId}`,
      headers: { cookie: adminCookie }
    });
    assertStatus("admin can load user card", beforeCard.statusCode, 200);
    const before = Number(beforeCard.json().currentBalance ?? 0);

    const grant = await app.inject({
      method: "POST",
      url: `/api/admin/users/${smokeUserId}/grant-credits`,
      headers: { cookie: adminCookie },
      payload: { amount: 100, reason: "admin billing smoke grant" }
    });
    assertStatus("admin grant succeeds", grant.statusCode, 200);
    const afterGrant = responseBalance(grant.json());
    assertEqual("grant updates balance", afterGrant, before + 100);

    const adjustment = await app.inject({
      method: "POST",
      url: `/api/admin/users/${smokeUserId}/adjust-credits`,
      headers: { cookie: adminCookie },
      payload: { amount: -20, reason: "admin billing smoke adjustment" }
    });
    assertStatus("admin adjustment succeeds", adjustment.statusCode, 200);
    const afterAdjustment = responseBalance(adjustment.json());
    assertEqual("adjustment updates balance", afterAdjustment, afterGrant - 20);

    const overdraw = await app.inject({
      method: "POST",
      url: `/api/admin/users/${smokeUserId}/adjust-credits`,
      headers: { cookie: adminCookie },
      payload: { amount: -999999, reason: "admin billing smoke overdraw" }
    });
    if (overdraw.statusCode < 400) {
      throw new Error(`Expected overdraw adjustment to fail, got ${overdraw.statusCode}.`);
    }

    const transactions = await app.inject({
      method: "GET",
      url: `/api/admin/users/${smokeUserId}/transactions?limit=5`,
      headers: { cookie: adminCookie }
    });
    assertStatus("admin can load user ledger", transactions.statusCode, 200);
    const transactionTypes = transactions.json().transactions.map((transaction: { type: string }) => transaction.type);
    if (!transactionTypes.includes("grant") || !transactionTypes.includes("adjustment")) {
      throw new Error(`Expected grant and adjustment transactions, got ${transactionTypes.join(", ")}.`);
    }

    console.log(JSON.stringify({
      smokeUserId,
      userDenied: userDenied.statusCode,
      adminList: adminList.statusCode,
      before,
      afterGrant,
      afterAdjustment,
      overdraw: overdraw.statusCode,
      recentTransactionTypes: transactionTypes
    }, null, 2));
  } finally {
    await app.close();
    await storage.close();
  }
}

function assertStatus(label: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}.`);
}

function assertEqual(label: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}.`);
}

function responseBalance(payload: unknown): number {
  const value = (payload as { balance?: unknown; balanceAfter?: unknown })?.balance
    ?? (payload as { balanceAfter?: unknown })?.balanceAfter;
  const balance = Number(value);
  if (!Number.isFinite(balance)) throw new Error(`Response did not include a numeric balance: ${JSON.stringify(payload)}`);
  return balance;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
