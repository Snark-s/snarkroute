import type { ProviderConnectionTest } from "@snarkroute/core";

export type { ProviderConnectionTest } from "@snarkroute/core";

export interface ProviderConnectionTestState {
  loading: boolean;
  result?: ProviderConnectionTest;
}

export type ProviderConnectionViewStatus = "offline" | "missing key" | "configured" | "testing" | "verified" | "failed";

export function providerConnectionViewStatus(input: {
  configured: boolean;
  offline: boolean;
  testState?: ProviderConnectionTestState;
}): ProviderConnectionViewStatus {
  if (input.offline) return "offline";
  if (!input.configured) return "missing key";
  if (input.testState?.loading) return "testing";
  if (input.testState?.result?.status === "verified") return "verified";
  if (input.testState?.result?.status === "failed") return "failed";
  return "configured";
}

export function isProviderConnectionTest(input: unknown): input is ProviderConnectionTest {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  const statusMatchesOk = record.status === "verified" && record.ok === true
    || record.status === "failed" && record.ok === false
    || record.status === "unsupported" && record.ok === null;
  return statusMatchesOk && (record.message === undefined || typeof record.message === "string");
}
