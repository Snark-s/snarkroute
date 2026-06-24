import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiBase } from "../../studioConfig";
import { apiFetch } from "../../shared/apiClient";
import { formatCredits, formatDateTime, formatMicrousd } from "../../shared/costFormatting";
import type { AdminBillingUser, AdminOverview, AdminUserCard, CurrentUser, PricingBreakdown } from "../../studioTypes";

function AdminUsersBilling({ onRefreshOverview, storageAvailable = true, storagePersisted = true }: { onRefreshOverview: () => void; storageAvailable?: boolean; storagePersisted?: boolean }) {
  const [users, setUsers] = useState<AdminBillingUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedUser, setSelectedUser] = useState<AdminUserCard | null>(null);
  const [tab, setTab] = useState<"transactions" | "runs" | "provider">("transactions");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "user" | "admin">("all");
  const [sort, setSort] = useState<"createdAt" | "balance">("createdAt");
  const [message, setMessage] = useState("");
  const [grantAmount, setGrantAmount] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  useEffect(() => {
    void loadUsers();
  }, []);

  async function loadUsers() {
    if (!storageAvailable) {
      setUsers([]);
      setSelectedUser(null);
      setMessage("Credit ledger is unavailable because DATABASE_URL is not configured.");
      return;
    }
    try {
      const response = await apiFetch(`${apiBase}/api/admin/users`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Admin users unavailable.");
      setUsers(Array.isArray(result.users) ? result.users : []);
      setMessage("");
    } catch (error) {
      setUsers([]);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadUser(userId: string) {
    if (!storageAvailable) {
      setSelectedUser(null);
      setSelectedUserId(userId);
      setMessage("Credit ledger is unavailable because DATABASE_URL is not configured.");
      return;
    }
    try {
      const response = await apiFetch(`${apiBase}/api/admin/users/${encodeURIComponent(userId)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "User card unavailable.");
      setSelectedUser(result as AdminUserCard);
      setSelectedUserId(userId);
      setMessage("");
    } catch (error) {
      setSelectedUser(null);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function submitCreditAction(kind: "grant" | "adjust") {
    if (!storageAvailable) {
      setMessage("Credit actions require DATABASE_URL. Configure cloud storage before granting or adjusting credits.");
      return;
    }
    const amount = Number(kind === "grant" ? grantAmount : adjustAmount);
    const reason = (kind === "grant" ? grantReason : adjustReason).trim();
    if (!selectedUserId || !Number.isInteger(amount) || !reason || (kind === "grant" && amount <= 0) || (kind === "adjust" && amount === 0)) {
      setMessage(kind === "grant" ? "Grant requires a positive integer amount and reason." : "Adjustment requires a non-zero integer amount and reason.");
      return;
    }
    try {
      const path = kind === "grant" ? "grant-credits" : "adjust-credits";
      const response = await apiFetch(`${apiBase}/api/admin/users/${encodeURIComponent(selectedUserId)}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, reason })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Credit action failed.");
      if (kind === "grant") {
        setGrantAmount("");
        setGrantReason("");
      } else {
        setAdjustAmount("");
        setAdjustReason("");
      }
      setMessage(`Balance updated: ${formatCredits(Number(result.balance ?? 0))} credits.`);
      await loadUsers();
      await loadUser(selectedUserId);
      onRefreshOverview();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const filteredUsers = users
    .filter((user) => roleFilter === "all" || user.role === roleFilter)
    .filter((user) => !query.trim() || user.id.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => sort === "balance"
      ? right.currentBalance - left.currentBalance
      : new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  return (
    <section className="adminUsersBilling">
      <div className="adminSectionHeader">
        <div>
          <h3>Users / Credits</h3>
          <p className="muted">{storageAvailable ? (storagePersisted ? "Ledger-backed balances. No email, name, avatar, or raw OAuth subject is shown." : "In-memory development balances. Configure DATABASE_URL for persisted user credits.") : "Credit controls are visible, but ledger storage is disabled until DATABASE_URL is configured."}</p>
        </div>
        <button type="button" disabled={!storageAvailable} onClick={() => void loadUsers()}><RefreshCw size={14} /> Refresh users</button>
      </div>
      <div className="adminFilters">
        <input value={query} disabled={!storageAvailable} placeholder="Search user id" onChange={(event) => setQuery(event.target.value)} />
        <select value={roleFilter} disabled={!storageAvailable} onChange={(event) => setRoleFilter(event.target.value as "all" | "user" | "admin")}>
          <option value="all">All roles</option>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <select value={sort} disabled={!storageAvailable} onChange={(event) => setSort(event.target.value as "createdAt" | "balance")}>
          <option value="createdAt">Created desc</option>
          <option value="balance">Balance desc</option>
        </select>
      </div>
      {message ? <p className={message.includes("failed") || message.includes("required") || message.includes("Insufficient") ? "errorText" : "muted"}>{message}</p> : null}
      <div className="adminUsersGrid">
        <div className="adminUsersTable">
          <div className="adminUsersTableHeader">
            <span>User ID</span><span>Role</span><span>Auth</span><span>Created</span><span>Balance</span><span>Granted</span><span>Spent</span><span>Released</span><span>Active reserved</span><span>Runs</span><span>Last activity</span><span>Actions</span>
          </div>
          {filteredUsers.map((user) => (
            <div className={`adminUsersTableRow ${selectedUserId === user.id ? "selected" : ""}`.trim()} key={user.id} onClick={() => void loadUser(user.id)}>
              <span title={user.id}>{shortAdminValue(user.id)}</span>
              <span>{user.role}</span>
              <span>{adminAuthProviderLabel(user)}</span>
              <span>{formatDateTime(user.createdAt)}</span>
              <strong>{formatCredits(user.currentBalance)}</strong>
              <span>{formatCredits(user.totalGranted)}</span>
              <span>{formatCredits(user.totalCaptured)}</span>
              <span>{formatCredits(user.totalReleased + user.totalRefunded)}</span>
              <span>{formatCredits(user.activeReserved)}</span>
              <span>{user.runsCount}</span>
              <span>{user.lastActivityAt ? formatDateTime(user.lastActivityAt) : "-"}</span>
              <span className="adminInlineActions">
                <button type="button" disabled={!storageAvailable} onClick={(event) => { event.stopPropagation(); void loadUser(user.id); }}>View</button>
                <button type="button" disabled={!storageAvailable} onClick={(event) => { event.stopPropagation(); void loadUser(user.id); setGrantAmount("100"); }}>Grant</button>
                <button type="button" disabled={!storageAvailable} onClick={(event) => { event.stopPropagation(); void loadUser(user.id); setAdjustAmount("-20"); }}>Adjust</button>
              </span>
            </div>
          ))}
          {filteredUsers.length === 0 ? <p className="muted">No users match this filter.</p> : null}
        </div>
        {selectedUser ? (
          <div className="adminUserCard">
            <header>
              <div>
                <h3>{selectedUser.id}</h3>
                <p>{selectedUser.role} / balance {formatCredits(selectedUser.currentBalance)} credits</p>
              </div>
            </header>
            <div className="adminMetricGrid compact">
              <span>Current balance</span><strong>{formatCredits(selectedUser.currentBalance)}</strong>
              <span>Total granted</span><strong>{formatCredits(selectedUser.totalGranted)}</strong>
              <span>Total spent</span><strong>{formatCredits(selectedUser.totalCaptured)}</strong>
              <span>Total refunded</span><strong>{formatCredits(selectedUser.totalReleased + selectedUser.totalRefunded)}</strong>
              <span>Runs count</span><strong>{selectedUser.runsCount}</strong>
              <span>Provider usage</span><strong>{selectedUser.providerUsageCount}</strong>
            </div>
            <div className="adminCreditForms">
              <label><span>Grant credits</span><input value={grantAmount} disabled={!storageAvailable} inputMode="numeric" placeholder="100" onChange={(event) => setGrantAmount(event.target.value)} /></label>
              <label><span>Reason</span><input value={grantReason} disabled={!storageAvailable} placeholder="Manual admin grant" onChange={(event) => setGrantReason(event.target.value)} /></label>
              <button type="button" disabled={!storageAvailable} onClick={() => void submitCreditAction("grant")}>Grant credits</button>
              <label><span>Adjust credits</span><input value={adjustAmount} disabled={!storageAvailable} inputMode="numeric" placeholder="-20" onChange={(event) => setAdjustAmount(event.target.value)} /></label>
              <label><span>Reason</span><input value={adjustReason} disabled={!storageAvailable} placeholder="Correction reason" onChange={(event) => setAdjustReason(event.target.value)} /></label>
              <button type="button" disabled={!storageAvailable} onClick={() => void submitCreditAction("adjust")}>Adjust credits</button>
            </div>
            <div className="adminTabs">
              {(["transactions", "runs", "provider"] as const).map((entry) => (
                <button key={entry} className={tab === entry ? "active" : ""} type="button" onClick={() => setTab(entry)}>{entry === "provider" ? "Provider usage" : entry[0].toUpperCase() + entry.slice(1)}</button>
              ))}
            </div>
            {tab === "transactions" ? <AdminList title="Transactions" rows={selectedUser.recentCreditTransactions} fields={["createdAt", "type", "amount", "reason", "runId", "provider", "operation", "balanceAfter"]} /> : null}
            {tab === "runs" ? <AdminList title="Runs" rows={selectedUser.recentRuns} fields={["id", "status", "route_id", "created_at"]} /> : null}
            {tab === "provider" ? <AdminList title="Provider Usage" rows={selectedUser.recentProviderUsage} fields={["provider", "operation", "node_id", "actual_credits", "status", "created_at"]} /> : null}
          </div>
        ) : (
          <div className="adminUserCard empty"><p className="muted">Select a user to view billing history.</p></div>
        )}
      </div>
    </section>
  );
}

function adminAuthProviderLabel(user: AdminBillingUser): string {
  const providers = user.authProviders.length ? user.authProviders.join(", ") : "unknown";
  return user.providerSubjectHashPrefix ? `${providers} / ${user.providerSubjectHashPrefix}` : providers;
}

function AdminPricing() {
  const [pricing, setPricing] = useState<PricingBreakdown[]>([]);
  const [actualStats, setActualStats] = useState<ProviderPricingActualStats[]>([]);
  const [globalMarkupPercent, setGlobalMarkupPercent] = useState("0");
  const [globalMarkupCredits, setGlobalMarkupCredits] = useState("0");
  const [minChargeCredits, setMinChargeCredits] = useState("0");
  const [configSource, setConfigSource] = useState("env_default");
  const [overrideProvider, setOverrideProvider] = useState("polza");
  const [overrideOperation, setOverrideOperation] = useState("image.generate");
  const [overrideModel, setOverrideModel] = useState("");
  const [overrideNodeType, setOverrideNodeType] = useState("");
  const [overrideMarkupPercent, setOverrideMarkupPercent] = useState("0");
  const [overrideMarkupCredits, setOverrideMarkupCredits] = useState("5");
  const [overrideReason, setOverrideReason] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void loadPricing();
  }, []);

  async function loadPricing() {
    try {
      const response = await apiFetch(`${apiBase}/api/admin/pricing/catalog`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Pricing unavailable.");
      setPricing(Array.isArray(result.pricing) ? result.pricing : []);
      setActualStats(Array.isArray(result.actualStats) ? result.actualStats.map(normalizeProviderPricingActualStats).filter((entry: ProviderPricingActualStats | null): entry is ProviderPricingActualStats => Boolean(entry)) : []);
      setGlobalMarkupPercent(String(result.config?.globalMarkupPercent ?? 0));
      setGlobalMarkupCredits(String(result.config?.globalMarkupCredits ?? 0));
      setMinChargeCredits(String(result.config?.minChargeCredits ?? 0));
      setConfigSource(String(result.source ?? "env_default"));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function savePricingConfig() {
    try {
      const response = await apiFetch(`${apiBase}/api/admin/pricing/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          globalMarkupPercent: Number(globalMarkupPercent),
          globalMarkupCredits: Number(globalMarkupCredits),
          minChargeCredits: Number(minChargeCredits),
          reason: "Admin pricing UI update"
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Pricing config save failed.");
      setMessage("Pricing config saved in database.");
      await loadPricing();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function savePricingOverride() {
    try {
      const response = await apiFetch(`${apiBase}/api/admin/pricing/overrides`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: overrideProvider.trim() || undefined,
          operation: overrideOperation.trim() || undefined,
          model: overrideModel.trim() || undefined,
          nodeType: overrideNodeType.trim() || undefined,
          markupPercent: Number(overrideMarkupPercent),
          markupCredits: Number(overrideMarkupCredits),
          enabled: true,
          reason: overrideReason.trim() || "Admin pricing override"
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Pricing override save failed.");
      setMessage("Pricing override saved in database.");
      await loadPricing();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshProviderPricing(provider: string) {
    try {
      const response = await apiFetch(`${apiBase}/api/admin/pricing/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Pricing refresh failed.");
      const failed = Array.isArray(result.failed) && result.failed.length ? `, failed ${result.failed.length}` : "";
      const warnings = Array.isArray(result.warnings) && result.warnings.length ? `, warnings ${result.warnings.length}` : "";
      setMessage(`Pricing refresh ${provider}: ${Number(result.pricesUpdated ?? 0)} price(s) updated${failed}${warnings}.`);
      await loadPricing();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="adminUsersBilling adminPricingPanel">
      <div className="adminSectionHeader">
        <div>
          <h3>Pricing</h3>
          <p className="muted">Credit unit: 1000 credits = $1. Prices are integer credits from provider API cost plus markup. Source: {configSource}.</p>
        </div>
        <button type="button" onClick={() => void loadPricing()}><RefreshCw size={14} /> Refresh table</button>
      </div>
      <div className="adminInlineActions pricingRefreshActions">
        {["all", "polza", "openrouter", "gemini", "replicate"].map((provider) => (
          <button key={provider} type="button" onClick={() => void refreshProviderPricing(provider)}>
            <RefreshCw size={13} /> Refresh {provider}
          </button>
        ))}
      </div>
      <div className="adminCreditForms pricingConfig">
        <label><span>Global markup %</span><input value={globalMarkupPercent} inputMode="decimal" onChange={(event) => setGlobalMarkupPercent(event.target.value)} /></label>
        <label><span>Global markup credits</span><input value={globalMarkupCredits} inputMode="numeric" onChange={(event) => setGlobalMarkupCredits(event.target.value)} /></label>
        <label><span>Min charge credits</span><input value={minChargeCredits} inputMode="numeric" onChange={(event) => setMinChargeCredits(event.target.value)} /></label>
        <button type="button" onClick={() => void savePricingConfig()}>Save pricing</button>
      </div>
      <div className="adminCreditForms pricingOverride">
        <label><span>Provider</span><input value={overrideProvider} onChange={(event) => setOverrideProvider(event.target.value)} /></label>
        <label><span>Operation</span><input value={overrideOperation} onChange={(event) => setOverrideOperation(event.target.value)} /></label>
        <label><span>Model</span><input value={overrideModel} placeholder="optional" onChange={(event) => setOverrideModel(event.target.value)} /></label>
        <label><span>Node type</span><input value={overrideNodeType} placeholder="optional" onChange={(event) => setOverrideNodeType(event.target.value)} /></label>
        <label><span>Override markup %</span><input value={overrideMarkupPercent} inputMode="decimal" onChange={(event) => setOverrideMarkupPercent(event.target.value)} /></label>
        <label><span>Override credits</span><input value={overrideMarkupCredits} inputMode="numeric" onChange={(event) => setOverrideMarkupCredits(event.target.value)} /></label>
        <label><span>Reason</span><input value={overrideReason} placeholder="Why this override changed" onChange={(event) => setOverrideReason(event.target.value)} /></label>
        <button type="button" onClick={() => void savePricingOverride()}>Save override</button>
      </div>
      {message ? <p className={message.includes("failed") || message.includes("unavailable") ? "errorText" : "muted"}>{message}</p> : null}
      <div className="adminUsersTable pricingTable">
        <div className="adminUsersTableHeader pricing">
          <span>Provider</span><span>Operation</span><span>Canonical</span><span>Model scope</span><span>Native id</span><span>Forecast</span><span>Last actual</span><span>Avg actual</span><span>Samples</span><span>Base credits</span><span>Final estimated</span><span>Global markup</span><span>Node markup</span><span>Pricing scope</span><span>Fetched</span><span>Stale?</span>
        </div>
        {pricing.map((entry) => {
          const stats = actualStatsForPricingEntry(entry, actualStats);
          return (
          <div className="adminUsersTableRow pricing" key={adminPricingEntryKey(entry)}>
            <span>{entry.provider ?? "-"}</span>
            <span>{entry.operation ?? "-"}</span>
            <span title={entry.canonicalModelId ?? ""}>{entry.canonicalModelId ?? "-"}</span>
            <span title={entry.model ? "Exact model pricing" : "Provider-level fallback for any model without exact pricing"}>{adminPricingModelScope(entry)}</span>
            <span title={entry.providerNativeModelId ?? ""}>{entry.providerNativeModelId ?? "-"}</span>
            <span>${formatMicrousd(entry.baseCostMicrousd ?? 0)}</span>
            <span title={actualStatsTitle(stats)}>{formatActualCredits(stats?.lastActualCredits)}</span>
            <span title={actualStatsTitle(stats)}>{formatActualCredits(stats?.avgActualCredits)}</span>
            <span>{stats?.samples ?? "-"}</span>
            <span>{formatCredits(entry.baseCredits ?? 0)}</span>
            <strong>{formatCredits(entry.finalCredits ?? 0)}</strong>
            <span>+{formatCredits(entry.globalMarkupPercent ?? 0)}% +{formatCredits(entry.globalMarkupCredits ?? 0)}</span>
            <span>+{formatCredits(entry.nodeMarkupPercent ?? 0)}% +{formatCredits(entry.nodeMarkupCredits ?? 0)}</span>
            <span title={entry.notes ?? ""}>{adminPricingScopeLabel(entry)}</span>
            <span>{entry.fetchedAt ? formatDateTime(entry.fetchedAt) : "-"}</span>
            <span>{entry.staleAfter ? (new Date(entry.staleAfter).getTime() < Date.now() ? "stale" : "fresh") : "-"}</span>
          </div>
        );})}
      </div>
    </section>
  );
}

type ProviderPricingActualStats = {
  provider: string | null;
  operation: string | null;
  model: string | null;
  pricingSnapshotId: string | null;
  samples: number;
  avgActualCredits: number | null;
  lastActualCredits: number | null;
  avgProviderCostMicrousd: number | null;
  lastProviderCostMicrousd: number | null;
  lastCreatedAt: string | null;
};

function normalizeProviderPricingActualStats(value: unknown): ProviderPricingActualStats | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    provider: typeof record.provider === "string" ? record.provider : null,
    operation: typeof record.operation === "string" ? record.operation : null,
    model: typeof record.model === "string" ? record.model : null,
    pricingSnapshotId: typeof record.pricingSnapshotId === "string" ? record.pricingSnapshotId : null,
    samples: Number(record.samples ?? 0),
    avgActualCredits: nullableNumber(record.avgActualCredits),
    lastActualCredits: nullableNumber(record.lastActualCredits),
    avgProviderCostMicrousd: nullableNumber(record.avgProviderCostMicrousd),
    lastProviderCostMicrousd: nullableNumber(record.lastProviderCostMicrousd),
    lastCreatedAt: typeof record.lastCreatedAt === "string" ? record.lastCreatedAt : null
  };
}

function actualStatsForPricingEntry(entry: PricingBreakdown, stats: ProviderPricingActualStats[]): ProviderPricingActualStats | undefined {
  if (!entry.provider || !entry.operation) return undefined;
  if (entry.pricingSnapshotId) {
    const snapshotMatch = stats.find((item) => item.pricingSnapshotId === entry.pricingSnapshotId);
    if (snapshotMatch) return snapshotMatch;
  }
  if (entry.model) {
    const exactMatches = stats.filter((item) =>
      item.provider === entry.provider
      && item.operation === entry.operation
      && item.model === entry.model
      && !item.pricingSnapshotId
    );
    if (entry.parameterRules && Object.keys(entry.parameterRules).length > 0) return undefined;
    return exactMatches[0];
  }
  const matches = stats.filter((item) => item.provider === entry.provider && item.operation === entry.operation && !item.pricingSnapshotId);
  if (matches.length === 0) return undefined;
  const samples = matches.reduce((sum, item) => sum + item.samples, 0);
  const latest = matches.reduce<ProviderPricingActualStats | undefined>((current, item) => {
    if (!current) return item;
    return Date.parse(item.lastCreatedAt ?? "") > Date.parse(current.lastCreatedAt ?? "") ? item : current;
  }, undefined);
  return {
    provider: entry.provider,
    operation: entry.operation,
    model: null,
    pricingSnapshotId: null,
    samples,
    avgActualCredits: weightedAverage(matches, "avgActualCredits"),
    lastActualCredits: latest?.lastActualCredits ?? null,
    avgProviderCostMicrousd: weightedAverage(matches, "avgProviderCostMicrousd"),
    lastProviderCostMicrousd: latest?.lastProviderCostMicrousd ?? null,
    lastCreatedAt: latest?.lastCreatedAt ?? null
  };
}

function weightedAverage(stats: ProviderPricingActualStats[], key: "avgActualCredits" | "avgProviderCostMicrousd"): number | null {
  let weighted = 0;
  let samples = 0;
  for (const item of stats) {
    const value = item[key];
    if (value === null || value === undefined || item.samples <= 0) continue;
    weighted += value * item.samples;
    samples += item.samples;
  }
  return samples > 0 ? weighted / samples : null;
}

function formatActualCredits(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : `${formatCredits(value)} cr`;
}

function actualStatsTitle(stats: ProviderPricingActualStats | undefined): string {
  if (!stats) return "No actual usage samples yet.";
  return [
    `Samples: ${stats.samples}`,
    stats.lastCreatedAt ? `Last: ${formatDateTime(stats.lastCreatedAt)}` : null,
    stats.lastProviderCostMicrousd !== null && stats.lastProviderCostMicrousd !== undefined ? `Last provider cost: $${formatMicrousd(stats.lastProviderCostMicrousd)}` : null,
    stats.avgProviderCostMicrousd !== null && stats.avgProviderCostMicrousd !== undefined ? `Average provider cost: $${formatMicrousd(stats.avgProviderCostMicrousd)}` : null
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function nullableNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function adminPricingModelScope(entry: PricingBreakdown): string {
  const params = parameterRulesLabel(entry.parameterRules);
  return [entry.model?.trim() || "Any model", params].filter(Boolean).join(" / ");
}

function adminPricingScopeLabel(entry: PricingBreakdown): string {
  const source = entry.source ?? entry.pricingSource ?? "-";
  const params = parameterRulesLabel(entry.parameterRules);
  const base = entry.model ? source : entry.fallback ? `${source} / provider fallback` : `${source} / any model`;
  return params ? `${base} / ${params}` : base;
}

function adminPricingEntryKey(entry: PricingBreakdown): string {
  return [
    entry.provider ?? "*",
    entry.operation ?? "*",
    entry.model ?? "*",
    entry.pricingSnapshotId ?? JSON.stringify(entry.parameterRules ?? {})
  ].join(":");
}

function parameterRulesLabel(rules: Record<string, unknown> | undefined): string {
  if (!rules || Object.keys(rules).length === 0) return "";
  return Object.entries(rules).map(([key, value]) => `${key}=${String(value)}`).join(", ");
}

export function AdminPanel({ overview, message, onRefresh, currentUser, standalone = false }: { overview: AdminOverview | null; message: string; onRefresh: () => void; currentUser?: CurrentUser | null; standalone?: boolean }) {
  const localDevAdmin = overview?.storageMode === "local-dev" || overview?.storageConfigured === false;
  return (
    <div className={`${standalone ? "adminDashboardPanel" : "providerCard"} adminPanel`}>
      <div className="providerHeader">
        <h4>Admin</h4>
        <span>Cloud operations</span>
      </div>
      <div className="settingsActions">
        <button onClick={onRefresh}><RefreshCw size={16} /> Refresh</button>
      </div>
      {message ? <p className={message.includes("required") || message.includes("unavailable") ? "errorText" : "muted"}>{message}</p> : null}
      {overview ? (
        <>
          <AdminPricing />
          <AdminUsersBilling onRefreshOverview={onRefresh} storageAvailable storagePersisted={!localDevAdmin} />
          {localDevAdmin ? (
            <p className="nodeWarning">Admin is running with a local development session. DATABASE_URL is not configured, so user balances, run history, provider usage, and credit grants are not persisted.</p>
          ) : null}
          {currentUser ? (
            <div className="adminMetricGrid">
              <span>Current user id</span><strong>{currentUser.id}</strong>
              <span>Role</span><strong>{currentUser.role ?? "user"}</strong>
            </div>
          ) : null}
            <div className="adminMetricGrid">
              <span>Users</span><strong>{overview.usersCount}</strong>
            <span>Total runs</span><strong>{overview.runsCount ?? overview.runs.length}</strong>
            <span>Total node runs</span><strong>{overview.nodeRunsCount ?? overview.nodeRuns.length}</strong>
            <span>Total credit transactions</span><strong>{overview.creditTransactionsCount ?? overview.creditTransactions.length}</strong>
            <span>Total provider usage</span><strong>{overview.providerUsageCount ?? overview.providerUsage.length}</strong>
            </div>
          <AdminList title="Runs" rows={overview.runs} fields={["id", "status", "user_id", "created_at"]} />
          <AdminList title="Node Runs" rows={overview.nodeRuns} fields={["node_id", "node_type", "provider", "actual_credits", "usage_source"]} />
          <AdminList title="Credit Transactions" rows={overview.creditTransactions} fields={["transaction_type", "amount_minor", "status", "created_at"]} />
          <AdminList title="Provider Usage" rows={overview.providerUsage} fields={["provider", "model_id", "cost_minor", "currency", "created_at"]} />
          <AdminList title="Recent Errors" rows={overview.recentErrors} fields={["source", "status", "error", "created_at"]} />
          <h3>Artifact Stats</h3>
          <pre className="miniPre">{JSON.stringify(overview.artifactStats, null, 2)}</pre>
          <h3>Guest Demo Usage</h3>
          <pre className="miniPre">{JSON.stringify(overview.guestDemoUsage, null, 2)}</pre>
          <h3>Provider Key Status</h3>
          <div className="providerStatus">
            {Object.entries(overview.providerKeyStatus ?? {}).map(([provider, configured]) => (
              <span key={provider}>{provider}: {configured ? "configured" : "missing"}</span>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">Admin overview unavailable.</p>
      )}
    </div>
  );
}

function AdminList({ title, rows, fields }: { title: string; rows: Array<Record<string, unknown>>; fields: string[] }) {
  return (
    <>
      <h3>{title}</h3>
      {rows.length > 0 ? (
        <div className="adminList">
          {rows.slice(0, 8).map((row, index) => (
            <div className="adminListRow" key={`${title}-${index}`}>
              {fields.map((field) => (
                <span key={field} title={String(row[field] ?? "")}>{field}: {shortAdminValue(row[field])}</span>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No records.</p>
      )}
    </>
  );
}

function shortAdminValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return truncateText(text, 80);
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
