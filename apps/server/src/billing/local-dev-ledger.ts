type LocalDevUser = {
  id: string;
  role: "user" | "admin";
  authProvider: "none" | "dev" | "google" | "yandex";
  displayName?: string;
  createdAt: string;
  balance: number;
  totalGranted: number;
  totalCaptured: number;
  totalReleased: number;
  totalRefunded: number;
  activeReserved: number;
  runsCount: number;
  lastActivityAt: string | null;
  transactions: LocalDevTransaction[];
};

type LocalDevTransaction = {
  id: string;
  createdAt: string;
  type: string;
  transactionType: string;
  amount: number;
  amount_minor: number;
  status: string;
  reason: string | null;
  runId: string | null;
  balanceAfter: number;
  metadata: Record<string, unknown>;
};

type LocalDevProviderUsageEvent = {
  id: string;
  createdAt: string;
  runId: string | null;
  nodeRunId: string | null;
  userId: string | null;
  nodeId: string | null;
  nodeType: string | null;
  provider: string;
  modelId: string | null;
  operation: string | null;
  status: string | null;
  usage: unknown;
  estimatedCredits: number | null;
  actualCredits: number | null;
  usageSource: string | null;
  providerCostEstimateAmount: number | null;
  providerCostActualAmount: number | null;
  providerCostMicrousd: number | null;
  baseCredits: number | null;
  markupCredits: number | null;
  finalCredits: number | null;
  pricingSource: string | null;
  pricingConfidence: string | null;
  pricingSnapshotId: string | null;
  canonicalModelId: string | null;
  providerNativeModelId: string | null;
  currency: string | null;
  providerRequestId: string | null;
  metadata: unknown;
};

type LocalDevReservation = {
  id: string;
  userId: string;
  runId: string;
  amount: number;
};

type LocalDevUserInput = {
  id: string;
  role?: "user" | "admin";
  authProvider?: "none" | "dev" | "google" | "yandex";
  displayName?: string;
};

const users = new Map<string, LocalDevUser>();
const reservations = new Map<string, LocalDevReservation>();
const providerUsageEvents: LocalDevProviderUsageEvent[] = [];

export function rememberLocalDevUser(input: LocalDevUserInput): LocalDevUser {
  const existing = users.get(input.id);
  if (existing) {
    existing.role = input.role ?? existing.role;
    existing.authProvider = input.authProvider ?? existing.authProvider;
    existing.displayName = input.displayName ?? existing.displayName;
    return existing;
  }
  const user: LocalDevUser = {
    id: input.id,
    role: input.role ?? "user",
    authProvider: input.authProvider ?? "dev",
    displayName: input.displayName,
    createdAt: new Date().toISOString(),
    balance: 0,
    totalGranted: 0,
    totalCaptured: 0,
    totalReleased: 0,
    totalRefunded: 0,
    activeReserved: 0,
    runsCount: 0,
    lastActivityAt: null,
    transactions: []
  };
  users.set(user.id, user);
  return user;
}

export function ensureLocalDevSeedUsers(): void {
  rememberLocalDevUser({ id: "00000000-0000-4000-8000-000000000001", displayName: "Boojum Dev Admin", authProvider: "dev", role: "admin" });
  rememberLocalDevUser({ id: "00000000-0000-4000-8000-000000000002", displayName: "Boojum Dev User", authProvider: "dev", role: "user" });
}

export function ensureLocalDevUser(id: string): LocalDevUser {
  return rememberLocalDevUser({ id, role: id.includes("admin") ? "admin" : "user", authProvider: id.includes("google") ? "google" : id.includes("yandex") ? "yandex" : "dev" });
}

export function listLocalDevBillingUsers() {
  return [...users.values()].map(localDevBillingUser);
}

export function getLocalDevBillingUser(userId: string) {
  const user = users.get(userId);
  const recentProviderUsage = listLocalDevProviderUsage({ userId, limit: 50 });
  if (!user) return null;
  return {
    ...localDevBillingUser(user),
    providerUsageCount: recentProviderUsage.length,
    recentRuns: [],
    recentCreditTransactions: user.transactions.slice(0, 50),
    recentProviderUsage
  };
}

export function localDevAdminOverview() {
  ensureLocalDevSeedUsers();
  const allUsers = listLocalDevBillingUsers();
  const transactions = [...users.values()].flatMap((user) => user.transactions).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return {
    storageMode: "local-dev",
    storageConfigured: false,
    usersCount: allUsers.length,
    runsCount: 0,
    nodeRunsCount: 0,
    creditTransactionsCount: transactions.length,
    providerUsageCount: providerUsageEvents.length,
    runs: [],
    nodeRuns: [],
    creditTransactions: transactions.slice(0, 50),
    providerUsage: listLocalDevProviderUsage({ limit: 50 }),
    recentErrors: [{
      source: "admin",
      status: "local-dev",
      error: "DATABASE_URL is not configured; using in-memory development credit ledger.",
      created_at: new Date().toISOString()
    }],
    artifactStats: { storageMode: "local-dev", persistedArtifacts: 0 },
    guestDemoUsage: { storageMode: "local-dev" }
  };
}

export function getLocalDevBalance(userId: string): { balance: number; currency: string } {
  const user = ensureLocalDevUser(userId);
  return { balance: user.balance, currency: "credits" };
}

export function grantLocalDevCredits(input: { userId: string; amount: number; reason: string; actorUserId?: string | null }) {
  const user = ensureLocalDevUser(input.userId);
  user.balance += input.amount;
  user.totalGranted += input.amount;
  user.lastActivityAt = new Date().toISOString();
  const transaction = pushTransaction(user, "grant", input.amount, input.reason, { actorUserId: input.actorUserId ?? null });
  return { balance: user.balance, transactionId: transaction.id };
}

export function adjustLocalDevCredits(input: { userId: string; amount: number; reason: string; actorUserId?: string | null; allowNegativeBalance?: boolean }) {
  const user = ensureLocalDevUser(input.userId);
  if (!input.allowNegativeBalance && user.balance + input.amount < 0) throw new Error("Insufficient credits for local development adjustment.");
  user.balance += input.amount;
  if (input.amount > 0) user.totalGranted += input.amount;
  else user.totalCaptured += Math.abs(input.amount);
  user.lastActivityAt = new Date().toISOString();
  const transaction = pushTransaction(user, "adjustment", input.amount, input.reason, { actorUserId: input.actorUserId ?? null });
  return { balance: user.balance, transactionId: transaction.id };
}

export function reserveLocalDevCredits(input: { userId: string; runId: string; amount: number }) {
  const user = ensureLocalDevUser(input.userId);
  if (user.balance < input.amount) throw new Error(`Insufficient credits: need ${input.amount}, balance ${user.balance}.`);
  user.balance -= input.amount;
  user.activeReserved += input.amount;
  user.lastActivityAt = new Date().toISOString();
  const reservationId = `local_res_${shortId()}`;
  reservations.set(reservationId, { id: reservationId, userId: user.id, runId: input.runId, amount: input.amount });
  pushTransaction(user, "reserve", -input.amount, "local_dev_run_reservation", { runId: input.runId });
  return { reservationId, amount: input.amount };
}

export function commitLocalDevCredits(input: { reservationId: string; actualAmount: number }) {
  const reservation = reservations.get(input.reservationId);
  if (!reservation) return { charged: 0, refunded: 0 };
  const user = ensureLocalDevUser(reservation.userId);
  const actualAmount = Math.max(Math.trunc(input.actualAmount), 0);
  const chargedFromReservation = Math.min(actualAmount, reservation.amount);
  const additionalCharge = Math.max(0, actualAmount - reservation.amount);
  if (additionalCharge > user.balance) {
    throw new Error(`Insufficient credits to capture provider actual cost: need additional ${additionalCharge}, balance ${user.balance}.`);
  }
  const refunded = reservation.amount - chargedFromReservation;
  user.balance += refunded;
  user.balance -= additionalCharge;
  user.activeReserved = Math.max(0, user.activeReserved - reservation.amount);
  user.totalCaptured += actualAmount;
  user.totalReleased += refunded;
  user.runsCount += 1;
  user.lastActivityAt = new Date().toISOString();
  reservations.delete(input.reservationId);
  pushTransaction(user, "capture", -additionalCharge, "local_dev_run_capture", {
    runId: reservation.runId,
    reservationId: input.reservationId,
    actualAmount,
    reserved: reservation.amount,
    additionalCharge
  });
  if (refunded > 0) pushTransaction(user, "release", refunded, "local_dev_run_release", { runId: reservation.runId, reservationId: input.reservationId });
  return { charged: actualAmount, refunded };
}

export function refundLocalDevCredits(input: { reservationId: string; amount: number }) {
  const reservation = reservations.get(input.reservationId);
  if (!reservation) return { refunded: 0 };
  const user = ensureLocalDevUser(reservation.userId);
  const refunded = Math.min(input.amount, reservation.amount);
  user.balance += refunded;
  user.activeReserved = Math.max(0, user.activeReserved - refunded);
  user.totalRefunded += refunded;
  user.lastActivityAt = new Date().toISOString();
  reservations.delete(input.reservationId);
  pushTransaction(user, "refund", refunded, "local_dev_run_refund", { runId: reservation.runId, reservationId: input.reservationId });
  return { refunded };
}

export function listLocalDevCreditTransactions(input: { userId?: string; limit?: number } = {}) {
  const source = input.userId ? ensureLocalDevUser(input.userId).transactions : [...users.values()].flatMap((user) => user.transactions);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 500);
  return source.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, limit);
}

export function saveLocalDevProviderUsageEvent(input: {
  runId?: string | null;
  nodeRunId?: string | null;
  userId?: string | null;
  nodeId?: string | null;
  nodeType?: string | null;
  provider: string;
  modelId?: string | null;
  operation?: string | null;
  status?: string | null;
  usage?: unknown;
  estimatedCredits?: number | null;
  actualCredits?: number | null;
  usageSource?: string | null;
  providerCostEstimateAmount?: number | null;
  providerCostActualAmount?: number | null;
  providerCostMicrousd?: number | null;
  baseCredits?: number | null;
  markupCredits?: number | null;
  finalCredits?: number | null;
  pricingSource?: string | null;
  pricingConfidence?: string | null;
  pricingSnapshotId?: string | null;
  canonicalModelId?: string | null;
  providerNativeModelId?: string | null;
  currency?: string | null;
  providerRequestId?: string | null;
  metadata?: unknown;
}) {
  if (input.userId) ensureLocalDevUser(input.userId);
  const event: LocalDevProviderUsageEvent = {
    id: `local_usage_${shortId()}`,
    createdAt: new Date().toISOString(),
    runId: input.runId ?? null,
    nodeRunId: input.nodeRunId ?? null,
    userId: input.userId ?? null,
    nodeId: input.nodeId ?? null,
    nodeType: input.nodeType ?? null,
    provider: input.provider,
    modelId: input.modelId ?? null,
    operation: normalizeProviderOperation(input.operation ?? input.nodeType ?? null),
    status: input.status ?? null,
    usage: input.usage ?? {},
    estimatedCredits: nullableNumber(input.estimatedCredits),
    actualCredits: nullableNumber(input.actualCredits),
    usageSource: input.usageSource ?? null,
    providerCostEstimateAmount: nullableNumber(input.providerCostEstimateAmount),
    providerCostActualAmount: nullableNumber(input.providerCostActualAmount),
    providerCostMicrousd: nullableNumber(input.providerCostMicrousd),
    baseCredits: nullableNumber(input.baseCredits),
    markupCredits: nullableNumber(input.markupCredits),
    finalCredits: nullableNumber(input.finalCredits),
    pricingSource: input.pricingSource ?? null,
    pricingConfidence: input.pricingConfidence ?? null,
    pricingSnapshotId: input.pricingSnapshotId ?? null,
    canonicalModelId: input.canonicalModelId ?? null,
    providerNativeModelId: input.providerNativeModelId ?? null,
    currency: input.currency ?? null,
    providerRequestId: input.providerRequestId ?? null,
    metadata: input.metadata ?? {}
  };
  providerUsageEvents.unshift(event);
  return { id: event.id };
}

export function listLocalDevProviderUsage(input: { userId?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 500);
  return providerUsageEvents
    .filter((event) => !input.userId || event.userId === input.userId)
    .slice(0, limit)
    .map((event) => ({
      id: event.id,
      created_at: event.createdAt,
      createdAt: event.createdAt,
      run_id: event.runId,
      runId: event.runId,
      node_run_id: event.nodeRunId,
      nodeRunId: event.nodeRunId,
      user_id: event.userId,
      userId: event.userId,
      node_id: event.nodeId,
      nodeId: event.nodeId,
      node_type: event.nodeType,
      nodeType: event.nodeType,
      provider: event.provider,
      model_id: event.modelId,
      modelId: event.modelId,
      operation: event.operation,
      status: event.status,
      estimated_credits: event.estimatedCredits,
      estimatedCredits: event.estimatedCredits,
      actual_credits: event.actualCredits,
      actualCredits: event.actualCredits,
      usage_source: event.usageSource,
      usageSource: event.usageSource,
      provider_cost_actual_amount: event.providerCostActualAmount,
      providerCostActualAmount: event.providerCostActualAmount,
      provider_cost_microusd: event.providerCostMicrousd,
      providerCostMicrousd: event.providerCostMicrousd,
      pricing_source: event.pricingSource,
      pricingSource: event.pricingSource,
      pricing_confidence: event.pricingConfidence,
      pricingConfidence: event.pricingConfidence,
      currency: event.currency
    }));
}

export function listLocalDevProviderPricingActualStats(limit = 500) {
  const succeeded = providerUsageEvents.filter((event) =>
    /^(succeeded|completed|success|ok)$/i.test(String(event.status ?? ""))
    && (event.actualCredits !== null || event.providerCostActualAmount !== null || event.providerCostMicrousd !== null)
  );
  const groups = new Map<string, LocalDevProviderUsageEvent[]>();
  for (const event of succeeded) {
    const key = [event.provider, event.operation ?? "", event.modelId ?? "", event.pricingSnapshotId ?? ""].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.values()]
    .map((events) => {
      const latest = events.slice().sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
      const actualCredits = events.map(actualCreditsForStats).filter((value): value is number => value !== null && value > 0);
      const providerCosts = events.map(providerCostMicrousdForEvent).filter((value): value is number => value !== null);
      return {
        provider: latest.provider,
        operation: latest.operation,
        model: latest.modelId,
        pricingSnapshotId: latest.pricingSnapshotId,
        samples: events.length,
        avgActualCredits: average(actualCredits),
        lastActualCredits: actualCreditsForStats(latest),
        avgProviderCostMicrousd: average(providerCosts),
        lastProviderCostMicrousd: providerCostMicrousdForEvent(latest),
        lastCreatedAt: latest.createdAt
      };
    })
    .sort((left, right) => right.samples - left.samples || String(left.provider).localeCompare(String(right.provider)))
    .slice(0, Math.max(1, Math.min(2000, Math.floor(limit))));
}

function localDevBillingUser(user: LocalDevUser) {
  return {
    id: user.id,
    role: user.role,
    createdAt: user.createdAt,
    authProviders: [user.authProvider],
    providerSubjectHashPrefix: user.id.startsWith("local-cloud-") ? user.id.split("-").pop() ?? null : null,
    currentBalance: user.balance,
    totalGranted: user.totalGranted,
    totalCaptured: user.totalCaptured,
    totalReleased: user.totalReleased,
    totalRefunded: user.totalRefunded,
    activeReserved: user.activeReserved,
    runsCount: user.runsCount,
    lastActivityAt: user.lastActivityAt
  };
}

function pushTransaction(user: LocalDevUser, type: string, amount: number, reason: string, metadata: Record<string, unknown>): LocalDevTransaction {
  const transaction: LocalDevTransaction = {
    id: `local_tx_${shortId()}`,
    createdAt: new Date().toISOString(),
    type,
    transactionType: type,
    amount,
    amount_minor: amount,
    status: "completed",
    reason,
    runId: typeof metadata.runId === "string" ? metadata.runId : null,
    balanceAfter: user.balance,
    metadata: { ...metadata, reason }
  };
  user.transactions.unshift(transaction);
  return transaction;
}

function normalizeProviderOperation(value: string | null): string | null {
  if (!value) return null;
  if (["image.generate", "text.generate", "video.generate", "image.upscale"].includes(value)) return value;
  if (/upscale/i.test(value)) return "image.upscale";
  if (/video/i.test(value)) return "video.generate";
  if (/text|llm/i.test(value)) return "text.generate";
  if (/image|gemini\.nano-banana-2/i.test(value)) return "image.generate";
  return value;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function providerCostMicrousdForEvent(event: LocalDevProviderUsageEvent): number | null {
  if (event.providerCostActualAmount !== null && (!event.currency || event.currency.toUpperCase() === "USD")) return Math.ceil(event.providerCostActualAmount * 1_000_000);
  if (event.providerCostActualAmount !== null && event.currency?.toUpperCase() === "RUB") return Math.ceil((event.providerCostActualAmount / rubPerUsd()) * 1_000_000);
  return event.providerCostMicrousd;
}

function actualCreditsForStats(event: LocalDevProviderUsageEvent): number | null {
  const actualProviderCostMicrousd = event.providerCostActualAmount !== null ? providerCostMicrousdForEvent(event) : null;
  if (actualProviderCostMicrousd !== null) return Math.ceil(actualProviderCostMicrousd / 1000);
  return event.actualCredits;
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function rubPerUsd(): number {
  const value = Number(process.env.BOOJUM_RUB_PER_USD ?? 100);
  return Number.isFinite(value) && value > 0 ? value : 100;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}
