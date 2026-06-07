process.env.APP_MODE ??= "cloud";
process.env.APP_PRODUCT ??= "boojum";
process.env.APP_DEV_UI ??= "true";
process.env.ALLOW_NEGATIVE_BALANCE ??= "false";
process.env.BOOJUM_ALLOW_NEGATIVE_BALANCE ??= "false";
process.env.BOOJUM_START_CREDITS ??= "0";
process.env.SNARKROUTE_NO_LISTEN ??= "1";
process.env.POLZA_AI_API_KEY ??= "pza-smoke";
process.env.DATABASE_URL ??= "postgresql://snarkroute:snarkroute@127.0.0.1:5432/snarkroute";

const userId = "00000000-0000-4000-8000-000000000002";
const userCookie = "boojum_dev_identity=user";
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/polza\.ai\/api/i.test(url)) {
    return new Response(JSON.stringify({ error: { message: "account has insufficient funds" } }), {
      status: 402,
      headers: { "content-type": "application/json" }
    });
  }
  return originalFetch(input, init);
};

async function main(): Promise<void> {
  const { buildServer } = await import("../apps/server/src/app");
  const { getCloudStorage } = await import("../apps/server/src/services/cloud-storage");
  const storage = getCloudStorage();
  const app = await buildServer();
  await app.ready();
  try {
    await app.inject({ method: "GET", url: "/api/auth/current", headers: { cookie: userCookie } });
    const current = await storage.getCreditBalance(userId);
    const delta = 80 - current.balance;
    if (delta !== 0) {
      await storage.adjustCredits({
        userId,
        amount: delta,
        reason: "billing provider failure smoke setup",
        actorUserId: null
      });
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/routes/run",
      headers: { cookie: userCookie },
      payload: {
        route: {
          routeVersion: "0.1",
          route: { id: "billing-provider-failure-smoke", title: "Billing Provider Failure Smoke", author: {} },
          economics: { enabled: false },
          nodes: [
            { id: "polza", type: "polza.image.generate", title: "Polza Image", params: { prompt: "A red square", model: "openai/gpt-image-1" } }
          ],
          edges: []
        }
      }
    });
    assertStatus("run request", response.statusCode, 200);
    const result = response.json();
    const runId = result.runId;
    const expectedReservedCredits = Number(result.costSummary.totalEstimatedCredits ?? 0);
    assertEqual("run failed", result.status, "failed");
    assertEqual("actual credits", result.costSummary.totalActualCredits, 0);
    assertEqual("refunded credits", result.costSummary.refundedCredits, expectedReservedCredits);
    assertEqual("balance after", result.costSummary.balanceAfter, 80);
    assertEqual("node actual credits", result.nodeResults.polza.actualCredits, 0);
    if (!String(result.nodeResults.polza.error ?? "").includes("No credits were charged")) {
      throw new Error(`Expected no-charge node message, got ${result.nodeResults.polza.error}`);
    }

    const transactions = (await storage.listCreditTransactions({ userId, limit: 50 })).filter((transaction) => transaction.runId === runId);
    const transactionTypes = transactions.map((transaction) => transaction.transactionType);
    if (!transactionTypes.includes("reserve") || !transactionTypes.includes("release")) {
      throw new Error(`Expected reserve + release transactions, got ${transactionTypes.join(", ")}.`);
    }
    if (transactionTypes.includes("capture")) {
      throw new Error(`Provider failure must not create capture transaction, got ${transactionTypes.join(", ")}.`);
    }

    const usage = (await storage.listUserProviderUsage({ userId, limit: 50 }))
      .find((event: any) => event.run_id === runId && event.node_id === "polza");
    assertEqual("provider usage status", (usage as any)?.status, "failed");
    assertEqual("provider usage actual credits", Number((usage as any)?.actual_credits ?? 0), 0);

    console.log(JSON.stringify({
      runId,
      balanceAfter: result.costSummary.balanceAfter,
      totalActualCredits: result.costSummary.totalActualCredits,
      refundedCredits: result.costSummary.refundedCredits,
      expectedReservedCredits,
      transactionTypes,
      providerUsageStatus: (usage as any)?.status
    }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    await storage.close();
  }
}

function assertStatus(label: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}.`);
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
