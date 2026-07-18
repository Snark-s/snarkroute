import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  getLocalDevBalance,
  grantLocalDevCredits,
  listLocalDevBillingUsers,
  listLocalDevCreditTransactions,
  reserveLocalDevCredits
} from "../src/billing/local-dev-credit-store";

let tempDir: string | null = null;

async function useTempLedger() {
  tempDir = await mkdtemp(join(tmpdir(), "sr-local-ledger-"));
  process.env.BOOJUM_LOCAL_DEV_LEDGER_PATH = join(tempDir, "ledger.json");
  __testing.resetLocalDevLedgerForTests();
}

describe("local dev credit ledger persistence", () => {
  afterEach(async () => {
    delete process.env.BOOJUM_LOCAL_DEV_LEDGER_PATH;
    __testing.resetLocalDevLedgerForTests();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("persists granted credits across process-ledger reloads", async () => {
    await useTempLedger();
    grantLocalDevCredits({ userId: "local-user", amount: 123, reason: "test_grant" });

    __testing.reloadLocalDevLedgerForTests();

    expect(getLocalDevBalance("local-user")).toEqual({ balance: 123, currency: "credits" });
    expect(listLocalDevCreditTransactions({ userId: "local-user" })[0]).toMatchObject({
      type: "grant",
      amount: 123,
      balanceAfter: 123
    });
  });

  it("releases abandoned reservations on ledger reload instead of losing credits", async () => {
    await useTempLedger();
    grantLocalDevCredits({ userId: "local-user", amount: 100, reason: "test_grant" });
    reserveLocalDevCredits({ userId: "local-user", runId: "run-restarted", amount: 40 });
    expect(getLocalDevBalance("local-user")).toEqual({ balance: 60, currency: "credits" });

    __testing.reloadLocalDevLedgerForTests();

    expect(getLocalDevBalance("local-user")).toEqual({ balance: 100, currency: "credits" });
    expect(listLocalDevBillingUsers().find((user) => user.id === "local-user")).toMatchObject({
      currentBalance: 100,
      activeReserved: 0
    });
    expect(listLocalDevCreditTransactions({ userId: "local-user" })[0]).toMatchObject({
      type: "release",
      amount: 40,
      reason: "local_dev_restart_recovery"
    });
  });
});
