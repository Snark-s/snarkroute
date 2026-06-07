import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

type PgPool = {
  query: <T = Record<string, unknown>>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
  connect?: () => Promise<PgClient>;
  end: () => Promise<void>;
};

type PgClient = {
  query: <T = Record<string, unknown>>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
  release: () => void;
};

type PgPoolConstructor = new (options: { connectionString: string }) => PgPool;

export type CloudRouteRecord = {
  id: string;
  routeKey: string;
  title?: string;
  description?: string;
  routeDocument: unknown;
  routeText: string;
  currentVersionId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudRouteSummary = {
  id: string;
  routeKey: string;
  title?: string;
  description?: string;
  currentVersionId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SaveRouteInput = {
  routeKey: string;
  title?: string;
  description?: string;
  routeDocument: unknown;
  routeText: string;
  ownerUserId?: string | null;
};

export type SaveRouteVersionInput = {
  routeId: string;
  routeDocument: unknown;
  routeText: string;
  createdByUserId?: string | null;
  changeNote?: string | null;
};

export type CloudStorageUser = {
  id: string;
  displayName?: string;
  email?: string;
  role?: "user" | "admin";
};

export type CloudAuthIdentityProvider = "google" | "yandex";

export type CloudAdminUserListing = {
  id: string;
  role: "user" | "admin";
  createdAt: string;
  provider: CloudAuthIdentityProvider | null;
  providerSubjectHashPrefix: string | null;
};

export type CloudAdminOverview = {
  usersCount: number;
  runsCount: number;
  nodeRunsCount: number;
  creditTransactionsCount: number;
  providerUsageCount: number;
  runs: unknown[];
  nodeRuns: unknown[];
  creditTransactions: unknown[];
  providerUsage: unknown[];
  recentErrors: unknown[];
  artifactStats: unknown;
  guestDemoUsage: unknown;
};

export type CreditTransactionType = "grant" | "reserve" | "capture" | "release" | "refund" | "adjustment" | "demo_grant" | "expired" | "purchase_placeholder";

export type CloudCreditTransaction = {
  id: string;
  accountId: string;
  userId: string;
  amount: number;
  transactionType: CreditTransactionType;
  status: string;
  runId?: string | null;
  reservationId?: string | null;
  balanceAfter?: number | null;
  metadata?: unknown;
  createdAt: string;
};

export type CloudUserBalance = {
  userId: string;
  role: "user" | "admin";
  balance: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
};

export type CloudAdminBillingUserSummary = {
  id: string;
  role: "user" | "admin";
  createdAt: string;
  authProviders: string[];
  providerSubjectHashPrefix?: string | null;
  currentBalance: number;
  totalGranted: number;
  totalCaptured: number;
  totalReleased: number;
  totalRefunded: number;
  activeReserved: number;
  runsCount: number;
  lastActivityAt?: string | null;
};

export type CloudAdminUserCard = CloudAdminBillingUserSummary & {
  recentRuns: unknown[];
  recentCreditTransactions: CloudCreditTransaction[];
  recentProviderUsage: unknown[];
  providerUsageCount: number;
};

export type CloudBillingPricingConfig = {
  globalMarkupPercent: number;
  globalMarkupCredits: number;
  minChargeCredits: number;
  roundingMode: "ceil";
  updatedAt: string;
  updatedBy?: string | null;
};

export type CloudBillingPricingOverride = {
  id: string;
  provider?: string | null;
  operation?: string | null;
  model?: string | null;
  nodeType?: string | null;
  markupPercent: number;
  markupCredits: number;
  enabled: boolean;
  reason?: string | null;
  updatedAt: string;
  updatedBy?: string | null;
};

export type SaveArtifactInput = {
  runId: string;
  nodeRunId?: string | null;
  nodeId?: string | null;
  routeId?: string | null;
  ownerUserId?: string | null;
  artifactKind: string;
  storageUri: string;
  storageBackend?: string;
  storageKey?: string | null;
  relativePath?: string | null;
  mimeType?: string | null;
  bytes?: number | null;
  metadata?: unknown;
};

export type SaveProviderUsageEventInput = {
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
  costMinor?: number | null;
  currency?: string | null;
  providerRequestId?: string | null;
  metadata?: unknown;
};

export class CloudPostgresStorageAdapter {
  private readonly pool: PgPool;
  private schemaReady: Promise<void> | null = null;

  constructor(options: { databaseUrl: string; pool?: PgPool }) {
    if (!options.databaseUrl.trim()) throw new Error("DATABASE_URL is required for CloudPostgresStorageAdapter.");
    this.pool = options.pool ?? createPgPool(options.databaseUrl);
  }

  async saveRoute(input: SaveRouteInput): Promise<CloudRouteRecord> {
    await this.ensureSchema();
    const ownerUserId = input.ownerUserId ?? (await this.ensureDevUser()).id;
    const routeId = randomUUID();
    const result = await this.pool.query<RouteRow>(
      `
      insert into routes (id, owner_user_id, route_key, title, description, route_document, route_text)
      values ($1, $2, $3, $4, $5, $6::jsonb, $7)
      on conflict (owner_user_id, route_key)
      do update set
        title = excluded.title,
        description = excluded.description,
        route_document = excluded.route_document,
        route_text = excluded.route_text,
        is_deleted = false,
        updated_at = now()
      returning id, route_key, title, description, route_document, route_text, current_version_id, created_at, updated_at
      `,
      [routeId, ownerUserId, input.routeKey, input.title ?? null, input.description ?? null, JSON.stringify(input.routeDocument), input.routeText]
    );
    const route = rowToRouteRecord(result.rows[0]);
    const version = await this.saveRouteVersion({
      routeId: route.id,
      routeDocument: input.routeDocument,
      routeText: input.routeText,
      createdByUserId: ownerUserId,
      changeNote: "Saved route"
    });
    const updated = await this.pool.query<RouteRow>(
      "update routes set current_version_id = $1, updated_at = now() where id = $2 returning id, route_key, title, description, route_document, route_text, current_version_id, created_at, updated_at",
      [version.id, route.id]
    );
    return rowToRouteRecord(updated.rows[0]);
  }

  async loadRoute(routeIdOrKey: string, ownerUserId?: string | null): Promise<CloudRouteRecord | null> {
    await this.ensureSchema();
    const owner = ownerUserId ?? (await this.ensureDevUser()).id;
    const result = await this.pool.query<RouteRow>(
      `
      select id, route_key, title, description, route_document, route_text, current_version_id, created_at, updated_at
      from routes
      where is_deleted = false
        and owner_user_id = $1
        and (id::text = $2 or route_key = $2)
      limit 1
      `,
      [owner, routeIdOrKey]
    );
    return result.rows[0] ? rowToRouteRecord(result.rows[0]) : null;
  }

  async listRoutes(ownerUserId?: string | null): Promise<CloudRouteSummary[]> {
    await this.ensureSchema();
    const owner = ownerUserId ?? (await this.ensureDevUser()).id;
    const result = await this.pool.query<RouteSummaryRow>(
      `
      select id, route_key, title, description, current_version_id, created_at, updated_at
      from routes
      where is_deleted = false and owner_user_id = $1
      order by updated_at desc
      `,
      [owner]
    );
    return result.rows.map(rowToRouteSummary);
  }

  async deleteRoute(routeIdOrKey: string, ownerUserId?: string | null): Promise<boolean> {
    await this.ensureSchema();
    const owner = ownerUserId ?? (await this.ensureDevUser()).id;
    const result = await this.pool.query<{ id: string }>(
      `
      update routes
      set is_deleted = true, updated_at = now()
      where owner_user_id = $1 and (id::text = $2 or route_key = $2) and is_deleted = false
      returning id
      `,
      [owner, routeIdOrKey]
    );
    return result.rows.length > 0;
  }

  async saveRouteVersion(input: SaveRouteVersionInput): Promise<{ id: string; versionNumber: number; createdAt: string }> {
    await this.ensureSchema();
    const nextVersion = await this.pool.query<{ version_number: number }>(
      "select coalesce(max(version_number), 0) + 1 as version_number from route_versions where route_id = $1",
      [input.routeId]
    );
    const versionNumber = Number(nextVersion.rows[0]?.version_number ?? 1);
    const result = await this.pool.query<{ id: string; version_number: number; created_at: Date | string }>(
      `
      insert into route_versions (route_id, version_number, route_document, route_text, created_by_user_id, change_note)
      values ($1, $2, $3::jsonb, $4, $5, $6)
      returning id, version_number, created_at
      `,
      [input.routeId, versionNumber, JSON.stringify(input.routeDocument), input.routeText, input.createdByUserId ?? null, input.changeNote ?? null]
    );
    return {
      id: result.rows[0].id,
      versionNumber: Number(result.rows[0].version_number),
      createdAt: dateText(result.rows[0].created_at)
    };
  }

  async ensureSchema(): Promise<void> {
    this.schemaReady ??= runCloudPostgresMigrations(this.pool);
    await this.schemaReady;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureUser(user: CloudStorageUser): Promise<CloudStorageUser> {
    await this.ensureSchema();
    const result = await this.pool.query<{ id: string; display_name: string | null; email: string | null; role: "user" | "admin" }>(
      `
      insert into users (id, email, display_name)
      values ($1, $2, $3)
      on conflict (id)
      do update set
        email = coalesce(excluded.email, users.email),
        display_name = coalesce(excluded.display_name, users.display_name),
        updated_at = now()
      returning id, display_name, email, role
      `,
      [user.id, user.email ?? null, user.displayName ?? null]
    );
    await this.ensureCreditAccount(result.rows[0].id);
    await this.grantStartingCredits(result.rows[0].id, Number(process.env.BOOJUM_START_CREDITS ?? 100));
    return {
      id: result.rows[0].id,
      displayName: result.rows[0].display_name ?? undefined,
      email: result.rows[0].email ?? undefined,
      role: result.rows[0].role
    };
  }

  async findOrCreateUserByIdentity(input: { provider: CloudAuthIdentityProvider; providerSubjectHash: string }): Promise<CloudStorageUser> {
    await this.ensureSchema();
    const existing = await this.pool.query<{ id: string; display_name: string | null; email: string | null; role: "user" | "admin" }>(
      `
      select users.id, users.display_name, users.email, users.role
      from auth_identities
      join users on users.id = auth_identities.user_id
      where auth_identities.provider = $1 and auth_identities.provider_subject_hash = $2 and users.deleted_at is null
      limit 1
      `,
      [input.provider, input.providerSubjectHash]
    );
    if (existing.rows[0]) return rowToUser(existing.rows[0]);

    const userId = randomUUID();
    const created = await this.pool.query<{ id: string; display_name: string | null; email: string | null; role: "user" | "admin" }>(
      `
      insert into users (id, role)
      values ($1, 'user')
      returning id, display_name, email, role
      `,
      [userId]
    );
    await this.pool.query(
      `
      insert into auth_identities (user_id, provider, provider_subject, provider_subject_hash, metadata)
      values ($1, $2, null, $3, '{}'::jsonb)
      on conflict do nothing
      `,
      [userId, input.provider, input.providerSubjectHash]
    );
    await this.ensureCreditAccount(userId);
    await this.grantStartingCredits(userId, Number(process.env.BOOJUM_START_CREDITS ?? 100));
    return rowToUser(created.rows[0]);
  }

  async listAdminUsers(): Promise<CloudAdminUserListing[]> {
    await this.ensureSchema();
    const result = await this.pool.query<AdminUserListingRow>(
      `
      select
        users.id,
        users.role,
        users.created_at,
        auth_identities.provider,
        left(auth_identities.provider_subject_hash, 12) as provider_subject_hash_prefix
      from users
      left join auth_identities on auth_identities.user_id = users.id
      where users.deleted_at is null
      order by users.created_at asc, users.id asc, auth_identities.provider asc
      `
    );
    return result.rows.map(rowToAdminUserListing);
  }

  async getUserById(userId: string): Promise<CloudStorageUser | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ id: string; display_name: string | null; email: string | null; role: "user" | "admin" }>(
      "select id, display_name, email, role from users where id = $1 and deleted_at is null limit 1",
      [userId]
    );
    return result.rows[0] ? rowToUser(result.rows[0]) : null;
  }

  async createSession(input: { userId: string; sessionTokenHash: string; expiresAt: Date }): Promise<{ id: string }> {
    await this.ensureSchema();
    const result = await this.pool.query<{ id: string }>(
      `
      insert into sessions (user_id, session_token_hash, expires_at, last_seen_at)
      values ($1, $2, $3, now())
      returning id
      `,
      [input.userId, input.sessionTokenHash, input.expiresAt]
    );
    return result.rows[0];
  }

  async getUserBySession(input: { sessionTokenHash: string }): Promise<CloudStorageUser | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ id: string; display_name: string | null; email: string | null; role: "user" | "admin" }>(
      `
      select users.id, users.display_name, users.email, users.role
      from sessions
      join users on users.id = sessions.user_id
      where sessions.session_token_hash = $1 and sessions.expires_at > now() and users.deleted_at is null
      limit 1
      `,
      [input.sessionTokenHash]
    );
    if (!result.rows[0]) return null;
    await this.pool.query("update sessions set last_seen_at = now() where session_token_hash = $1", [input.sessionTokenHash]);
    return rowToUser(result.rows[0]);
  }

  async deleteSession(input: { sessionTokenHash: string }): Promise<void> {
    await this.ensureSchema();
    await this.pool.query("delete from sessions where session_token_hash = $1", [input.sessionTokenHash]);
  }

  async setUserRole(userId: string, role: "user" | "admin"): Promise<CloudStorageUser> {
    await this.ensureSchema();
    const result = await this.pool.query<{ id: string; display_name: string | null; email: string | null; role: "user" | "admin" }>(
      "update users set role = $2, updated_at = now() where id = $1 returning id, display_name, email, role",
      [userId, role]
    );
    if (!result.rows[0]) throw new Error("User was not found.");
    return {
      id: result.rows[0].id,
      displayName: result.rows[0].display_name ?? undefined,
      email: result.rows[0].email ?? undefined,
      role: result.rows[0].role
    };
  }

  async writeAuditEvent(input: { actorUserId?: string | null; eventType: string; metadata?: unknown }): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "insert into audit_events (actor_user_id, event_type, metadata) values ($1, $2, $3::jsonb)",
      [input.actorUserId ?? null, input.eventType, JSON.stringify(input.metadata ?? {})]
    );
  }

  async getBillingPricingConfig(): Promise<CloudBillingPricingConfig | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{
      global_markup_percent: string | number;
      global_markup_credits: string | number;
      min_charge_credits: string | number;
      rounding_mode: string;
      updated_at: string;
      updated_by: string | null;
    }>(
      `select global_markup_percent, global_markup_credits, min_charge_credits, rounding_mode, updated_at, updated_by
       from billing_pricing_config
       where id = 'default'
       limit 1`
    );
    const row = result.rows[0];
    return row ? {
      globalMarkupPercent: Number(row.global_markup_percent),
      globalMarkupCredits: Number(row.global_markup_credits),
      minChargeCredits: Number(row.min_charge_credits),
      roundingMode: "ceil",
      updatedAt: String(row.updated_at),
      updatedBy: row.updated_by
    } : null;
  }

  async upsertBillingPricingConfig(input: { globalMarkupPercent: number; globalMarkupCredits: number; minChargeCredits: number; updatedBy?: string | null }): Promise<CloudBillingPricingConfig> {
    await this.ensureSchema();
    const result = await this.pool.query<{
      global_markup_percent: string | number;
      global_markup_credits: string | number;
      min_charge_credits: string | number;
      rounding_mode: string;
      updated_at: string;
      updated_by: string | null;
    }>(
      `
      insert into billing_pricing_config (id, global_markup_percent, global_markup_credits, min_charge_credits, rounding_mode, updated_by)
      values ('default', $1, $2, $3, 'ceil', $4)
      on conflict (id) do update set
        global_markup_percent = excluded.global_markup_percent,
        global_markup_credits = excluded.global_markup_credits,
        min_charge_credits = excluded.min_charge_credits,
        rounding_mode = excluded.rounding_mode,
        updated_by = excluded.updated_by,
        updated_at = now()
      returning global_markup_percent, global_markup_credits, min_charge_credits, rounding_mode, updated_at, updated_by
      `,
      [
        integerCredits(input.globalMarkupPercent),
        integerCredits(input.globalMarkupCredits),
        integerCredits(input.minChargeCredits),
        input.updatedBy ?? null
      ]
    );
    const row = result.rows[0];
    return {
      globalMarkupPercent: Number(row.global_markup_percent),
      globalMarkupCredits: Number(row.global_markup_credits),
      minChargeCredits: Number(row.min_charge_credits),
      roundingMode: "ceil",
      updatedAt: String(row.updated_at),
      updatedBy: row.updated_by
    };
  }

  async listBillingPricingOverrides(): Promise<CloudBillingPricingOverride[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{
      id: string; provider: string | null; operation: string | null; model: string | null; node_type: string | null;
      markup_percent: string | number; markup_credits: string | number; enabled: boolean; reason: string | null; updated_at: string; updated_by: string | null;
    }>(
      `select id, provider, operation, model, node_type, markup_percent, markup_credits, enabled, reason, updated_at, updated_by
       from billing_pricing_overrides
       order by updated_at desc`
    );
    return result.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      operation: row.operation,
      model: row.model,
      nodeType: row.node_type,
      markupPercent: Number(row.markup_percent),
      markupCredits: Number(row.markup_credits),
      enabled: row.enabled,
      reason: row.reason,
      updatedAt: String(row.updated_at),
      updatedBy: row.updated_by
    }));
  }

  async upsertBillingPricingOverride(input: {
    provider?: string | null;
    operation?: string | null;
    model?: string | null;
    nodeType?: string | null;
    markupPercent: number;
    markupCredits: number;
    enabled: boolean;
    reason?: string | null;
    updatedBy?: string | null;
  }): Promise<CloudBillingPricingOverride> {
    await this.ensureSchema();
    const result = await this.pool.query<{
      id: string; provider: string | null; operation: string | null; model: string | null; node_type: string | null;
      markup_percent: string | number; markup_credits: string | number; enabled: boolean; reason: string | null; updated_at: string; updated_by: string | null;
    }>(
      `
      with updated as (
        update billing_pricing_overrides
        set markup_percent = $5,
            markup_credits = $6,
            enabled = $7,
            reason = $8,
            updated_by = $9,
            updated_at = now()
        where coalesce(provider, '') = coalesce($1, '')
          and coalesce(operation, '') = coalesce($2, '')
          and coalesce(model, '') = coalesce($3, '')
          and coalesce(node_type, '') = coalesce($4, '')
        returning id, provider, operation, model, node_type, markup_percent, markup_credits, enabled, reason, updated_at, updated_by
      ), inserted as (
        insert into billing_pricing_overrides (provider, operation, model, node_type, markup_percent, markup_credits, enabled, reason, updated_by)
        select $1, $2, $3, $4, $5, $6, $7, $8, $9
        where not exists (select 1 from updated)
        returning id, provider, operation, model, node_type, markup_percent, markup_credits, enabled, reason, updated_at, updated_by
      )
      select * from updated
      union all
      select * from inserted
      limit 1
      `,
      [
        nullIfBlank(input.provider),
        nullIfBlank(input.operation),
        nullIfBlank(input.model),
        nullIfBlank(input.nodeType),
        integerCredits(input.markupPercent),
        integerCredits(input.markupCredits),
        input.enabled,
        nullIfBlank(input.reason),
        input.updatedBy ?? null
      ]
    );
    const row = result.rows[0];
    return {
      id: row.id,
      provider: row.provider,
      operation: row.operation,
      model: row.model,
      nodeType: row.node_type,
      markupPercent: Number(row.markup_percent),
      markupCredits: Number(row.markup_credits),
      enabled: row.enabled,
      reason: row.reason,
      updatedAt: String(row.updated_at),
      updatedBy: row.updated_by
    };
  }

  async adminOverview(): Promise<CloudAdminOverview> {
    await this.ensureSchema();
    const usersCount = await this.pool.query<{ count: string | number }>("select count(*) as count from users where deleted_at is null");
    const runsCount = await this.pool.query<{ count: string | number }>("select count(*) as count from runs");
    const nodeRunsCount = await this.pool.query<{ count: string | number }>("select count(*) as count from node_runs");
    const creditTransactionsCount = await this.pool.query<{ count: string | number }>("select count(*) as count from credit_transactions");
    const providerUsageCount = await this.pool.query<{ count: string | number }>("select count(*) as count from provider_usage_events");
    const runs = await this.pool.query("select id, user_id, route_id, status, started_at, completed_at, created_at from runs order by created_at desc limit 25");
    const nodeRuns = await this.pool.query("select id, run_id, node_id, node_type, provider, model, status, actual_credits, usage_source, created_at from node_runs order by created_at desc limit 50");
    const creditTransactions = await this.pool.query("select id, account_id, amount_minor, transaction_type, status, run_id, created_at from credit_transactions order by created_at desc limit 50");
    const providerUsage = await this.pool.query(
      "select id, run_id, node_run_id, user_id, node_id, node_type, provider, model_id, operation, status, estimated_credits, actual_credits, usage_source, provider_cost_estimate_amount, provider_cost_actual_amount, provider_cost_microusd, base_credits, markup_credits, final_credits, pricing_source, pricing_confidence, cost_minor, currency, created_at from provider_usage_events order by created_at desc limit 50"
    );
    const recentErrors = await this.pool.query(
      `select 'run' as source, id, status, error, created_at from runs where error is not null
       union all
       select 'node_run' as source, id, status, error, created_at from node_runs where error is not null
       order by created_at desc limit 25`
    );
    const artifactStats = await this.pool.query("select artifact_kind, count(*) as count, coalesce(sum(bytes), 0) as bytes from artifacts group by artifact_kind order by artifact_kind");
    const guestDemoUsage = await this.pool.query("select count(*) as runs_count from runs where user_id is null");
    return {
      usersCount: Number(usersCount.rows[0]?.count ?? 0),
      runsCount: Number(runsCount.rows[0]?.count ?? 0),
      nodeRunsCount: Number(nodeRunsCount.rows[0]?.count ?? 0),
      creditTransactionsCount: Number(creditTransactionsCount.rows[0]?.count ?? 0),
      providerUsageCount: Number(providerUsageCount.rows[0]?.count ?? 0),
      runs: runs.rows,
      nodeRuns: nodeRuns.rows,
      creditTransactions: creditTransactions.rows,
      providerUsage: providerUsage.rows,
      recentErrors: recentErrors.rows,
      artifactStats: artifactStats.rows,
      guestDemoUsage: guestDemoUsage.rows[0] ?? { runs_count: 0 }
    };
  }

  async ensureCreditAccount(userId: string, currency = "USD"): Promise<{ id: string; userId: string; currency: string; balanceMinor: number }> {
    await this.ensureSchema();
    const result = await this.pool.query<{ id: string; user_id: string; currency: string; balance_minor: string | number }>(
      `
      insert into credit_accounts (user_id, currency)
      values ($1, $2)
      on conflict (user_id, currency)
      do update set updated_at = now()
      returning id, user_id, currency, balance_minor
      `,
      [userId, currency]
    );
    return {
      id: result.rows[0].id,
      userId: result.rows[0].user_id,
      currency: result.rows[0].currency,
      balanceMinor: Number(result.rows[0].balance_minor)
    };
  }

  async grantStartingCredits(userId: string, amount: number): Promise<void> {
    amount = integerCredits(amount);
    if (amount <= 0) return;
    const account = await this.ensureCreditAccount(userId);
    const existing = await this.pool.query<{ id: string }>(
      "select id from credit_transactions where account_id = $1 and transaction_type in ('grant_start', 'grant') and metadata->>'reason' = 'BOOJUM_START_CREDITS' limit 1",
      [account.id]
    );
    if (existing.rows.length > 0) return;
    await this.postCreditTransaction({
      accountId: account.id,
      amount,
      transactionType: "grant",
      metadata: { reason: "BOOJUM_START_CREDITS" }
    });
  }

  async getCreditBalance(userId: string): Promise<{ userId: string; balance: number; currency: string }> {
    const account = await this.ensureCreditAccount(userId);
    return { userId, balance: account.balanceMinor, currency: account.currency };
  }

  async reserveCredits(input: { userId: string; runId: string; amount: number }): Promise<{ reservationId: string; amount: number }> {
    const amount = integerCredits(input.amount);
    if (amount <= 0) return { reservationId: randomUUID(), amount: 0 };
    const reservationId = randomUUID();
    return this.withTransaction(async (client) => {
      const account = await this.ensureCreditAccountForUpdate(client, input.userId);
      if (account.balanceMinor < amount) throw new Error(`Insufficient credits: need ${amount}, balance ${account.balanceMinor}.`);
      await this.insertCreditTransaction(client, {
        accountId: account.id,
        amount: -amount,
        transactionType: "reserve",
        runId: input.runId,
        reservationId,
        status: "posted",
        metadata: { runId: input.runId }
      });
      await client.query("update credit_accounts set balance_minor = balance_minor - $2, updated_at = now() where id = $1", [account.id, amount]);
      return { reservationId, amount };
    });
  }

  async commitCredits(input: { reservationId: string; actualAmount: number }): Promise<{ charged: number; refunded: number }> {
    const actualAmount = integerCredits(input.actualAmount);
    return this.withTransaction(async (client) => {
      const reserve = await this.findReservationForUpdate(client, input.reservationId);
      if (!reserve) throw new Error(`Credit reservation "${input.reservationId}" was not found.`);
      const existingCapture = await client.query<{ id: string }>(
        "select id from credit_transactions where reservation_id = $1 and transaction_type = 'capture' limit 1",
        [input.reservationId]
      );
      if (existingCapture.rows.length > 0) return { charged: 0, refunded: 0 };
      const reserved = Math.abs(Number(reserve.amount_minor));
      const alreadyReleased = await this.releasedReservationAmount(client, input.reservationId);
      if (alreadyReleased >= reserved) return { charged: 0, refunded: 0 };
      const charged = Math.max(0, Math.min(reserved, actualAmount));
      const refunded = Math.max(0, reserved - alreadyReleased - charged);
      if (charged > 0) {
        await this.insertCreditTransaction(client, {
          accountId: reserve.account_id,
          amount: 0,
          transactionType: "capture",
          runId: reserve.run_id,
          reservationId: input.reservationId,
          metadata: { actualAmount: charged, reserved, maxChargeCredits: reserved }
        });
      }
      if (refunded > 0) {
        await this.insertCreditTransaction(client, {
          accountId: reserve.account_id,
          amount: refunded,
          transactionType: "release",
          runId: reserve.run_id,
          reservationId: input.reservationId,
          metadata: { reason: "unused_reservation", actualAmount: charged, reserved }
        });
        await client.query("update credit_accounts set balance_minor = balance_minor + $2, updated_at = now() where id = $1", [reserve.account_id, refunded]);
      }
      return { charged, refunded };
    });
  }

  async refundCredits(input: { reservationId: string; amount: number }): Promise<{ refunded: number }> {
    const amount = integerCredits(input.amount);
    if (amount <= 0) return { refunded: 0 };
    return this.withTransaction(async (client) => {
      const reserve = await this.findReservationForUpdate(client, input.reservationId);
      if (!reserve) throw new Error(`Credit reservation "${input.reservationId}" was not found.`);
      const released = await this.releasedReservationAmount(client, input.reservationId);
      const reserved = Math.abs(Number(reserve.amount_minor));
      const refundable = Math.max(0, reserved - released);
      const refunded = Math.min(amount, refundable);
      if (refunded <= 0) return { refunded: 0 };
      await this.insertCreditTransaction(client, {
        accountId: reserve.account_id,
        amount: refunded,
        transactionType: "release",
        runId: reserve.run_id,
        reservationId: input.reservationId,
        metadata: { reason: "reservation_release" }
      });
      await client.query("update credit_accounts set balance_minor = balance_minor + $2, updated_at = now() where id = $1", [reserve.account_id, refunded]);
      return { refunded };
    });
  }

  async grantCredits(input: { userId: string; amount: number; reason: string; actorUserId?: string | null; transactionType?: CreditTransactionType }): Promise<{ balance: number; transactionId: string }> {
    const amount = integerCredits(input.amount);
    if (amount <= 0) throw new Error("Grant amount must be a positive integer.");
    const account = await this.ensureCreditAccount(input.userId);
    return this.postCreditTransaction({
      accountId: account.id,
      amount,
      transactionType: input.transactionType ?? "grant",
      metadata: { reason: input.reason, actorUserId: input.actorUserId ?? null }
    });
  }

  async adjustCredits(input: { userId: string; amount: number; reason: string; actorUserId?: string | null; allowNegativeBalance?: boolean }): Promise<{ balance: number; transactionId: string }> {
    const amount = integerCreditsSigned(input.amount);
    if (amount === 0) throw new Error("Adjustment amount must be a non-zero integer.");
    const account = await this.ensureCreditAccount(input.userId);
    return this.postCreditTransaction({
      accountId: account.id,
      amount,
      transactionType: "adjustment",
      metadata: { reason: input.reason, actorUserId: input.actorUserId ?? null },
      allowNegativeBalance: input.allowNegativeBalance === true
    });
  }

  async listUserBalances(): Promise<CloudUserBalance[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{ user_id: string; role: "user" | "admin"; balance_minor: string | number; currency: string; created_at: string; updated_at: string }>(
      `
      select u.id as user_id, u.role, coalesce(ca.balance_minor, 0) as balance_minor, coalesce(ca.currency, 'USD') as currency,
        coalesce(ca.created_at, u.created_at) as created_at, coalesce(ca.updated_at, u.updated_at) as updated_at
      from users u
      left join credit_accounts ca on ca.user_id = u.id and ca.currency = 'USD'
      where u.deleted_at is null
      order by u.created_at desc
      `
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      role: row.role,
      balance: Number(row.balance_minor),
      currency: row.currency,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  }

  async listCreditTransactions(input: { userId?: string | null; limit?: number } = {}): Promise<CloudCreditTransaction[]> {
    await this.ensureSchema();
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 500);
    const values: unknown[] = [limit];
    const userFilter = input.userId ? "where ca.user_id = $2" : "";
    if (input.userId) values.push(input.userId);
    const result = await this.pool.query<{
      id: string; account_id: string; user_id: string; amount_minor: string | number; transaction_type: CreditTransactionType; status: string; run_id: string | null; reservation_id: string | null; balance_after: string | number | null; metadata: unknown; created_at: string;
    }>(
      `
      select *
      from (
        select
          ct.id,
          ct.account_id,
          ca.user_id,
          ct.amount_minor,
          ct.transaction_type,
          ct.status,
          ct.run_id,
          ct.reservation_id,
          sum(ct.amount_minor) over (partition by ct.account_id order by ct.created_at asc, ct.id asc) as balance_after,
          ct.metadata,
          ct.created_at
        from credit_transactions ct
        join credit_accounts ca on ca.id = ct.account_id
        ${userFilter}
      ) ledger
      order by created_at desc
      limit $1
      `,
      values
    );
    return result.rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      userId: row.user_id,
      amount: Number(row.amount_minor),
      transactionType: row.transaction_type,
      status: row.status,
      runId: row.run_id,
      reservationId: row.reservation_id,
      balanceAfter: row.balance_after === null ? null : Number(row.balance_after),
      metadata: row.metadata,
      createdAt: String(row.created_at)
    }));
  }

  async adminBillingUsers(): Promise<CloudAdminBillingUserSummary[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{
      id: string;
      role: "user" | "admin";
      created_at: string;
      auth_providers: string[] | string | null;
      provider_subject_hash_prefix: string | null;
      current_balance: string | number;
      total_granted: string | number;
      total_captured: string | number;
      total_released: string | number;
      total_refunded: string | number;
      active_reserved: string | number;
      runs_count: string | number;
      last_activity_at: string | null;
    }>(`
      with auth as (
        select
          user_id,
          array_agg(distinct provider order by provider) as auth_providers,
          min(left(provider_subject_hash, 8)) filter (where provider_subject_hash is not null) as provider_subject_hash_prefix
        from auth_identities
        group by user_id
      ),
      tx as (
        select
          ca.user_id,
          coalesce(sum(ct.amount_minor) filter (where ct.transaction_type in ('grant', 'demo_grant', 'purchase_placeholder')), 0) as total_granted,
          coalesce(abs(sum(ct.amount_minor) filter (where ct.transaction_type = 'reserve')), 0) as total_reserved,
          coalesce(sum(ct.amount_minor) filter (where ct.transaction_type = 'release'), 0) as total_released,
          coalesce(sum(ct.amount_minor) filter (where ct.transaction_type = 'refund'), 0) as total_refunded,
          coalesce(abs(sum(ct.amount_minor) filter (where ct.transaction_type = 'reserve')), 0)
            - coalesce(sum(ct.amount_minor) filter (where ct.transaction_type in ('release', 'refund')), 0)
            - coalesce(sum((ct.metadata->>'actualAmount')::bigint) filter (where ct.transaction_type = 'capture' and (ct.metadata->>'actualAmount') ~ '^[0-9]+$'), 0) as active_reserved
        from credit_accounts ca
        left join credit_transactions ct on ct.account_id = ca.id
        group by ca.user_id
      ),
      runs_agg as (
        select user_id, count(*) as runs_count, max(coalesce(completed_at, started_at, created_at)) as last_run_at
        from runs
        where user_id is not null
        group by user_id
      ),
      usage_agg as (
        select user_id, coalesce(sum(actual_credits), 0) as total_captured, max(created_at) as last_usage_at
        from provider_usage_events
        where user_id is not null
        group by user_id
      )
      select
        u.id,
        u.role,
        u.created_at,
        coalesce(auth.auth_providers, array[]::text[]) as auth_providers,
        auth.provider_subject_hash_prefix,
        coalesce(ca.balance_minor, 0) as current_balance,
        coalesce(tx.total_granted, 0) as total_granted,
        coalesce(usage_agg.total_captured, 0) as total_captured,
        coalesce(tx.total_released, 0) as total_released,
        coalesce(tx.total_refunded, 0) as total_refunded,
        greatest(coalesce(tx.active_reserved, 0), 0) as active_reserved,
        coalesce(runs_agg.runs_count, 0) as runs_count,
        greatest(u.updated_at, coalesce(runs_agg.last_run_at, u.updated_at), coalesce(usage_agg.last_usage_at, u.updated_at)) as last_activity_at
      from users u
      left join auth on auth.user_id = u.id
      left join credit_accounts ca on ca.user_id = u.id and ca.currency = 'USD'
      left join tx on tx.user_id = u.id
      left join runs_agg on runs_agg.user_id = u.id
      left join usage_agg on usage_agg.user_id = u.id
      where u.deleted_at is null
      order by u.created_at desc
    `);
    return result.rows.map(adminBillingUserSummaryFromRow);
  }

  async adminBillingUser(userId: string): Promise<CloudAdminUserCard | null> {
    const users = await this.adminBillingUsers();
    const summary = users.find((user) => user.id === userId);
    if (!summary) return null;
    const recentRuns = await this.pool.query(
      "select id, route_id, status, started_at, completed_at, created_at from runs where user_id = $1 order by created_at desc limit 25",
      [userId]
    );
    const recentProviderUsage = await this.listUserProviderUsage({ userId, limit: 50 });
    const providerUsageCount = await this.pool.query<{ count: string | number }>("select count(*) as count from provider_usage_events where user_id = $1", [userId]);
    return {
      ...summary,
      recentRuns: recentRuns.rows,
      recentCreditTransactions: await this.listCreditTransactions({ userId, limit: 50 }),
      recentProviderUsage,
      providerUsageCount: Number(providerUsageCount.rows[0]?.count ?? 0)
    };
  }

  async listUserProviderUsage(input: { userId: string; limit?: number }): Promise<unknown[]> {
    await this.ensureSchema();
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 500);
    const result = await this.pool.query(
      `
      select id, run_id, node_run_id, node_id, node_type, provider, model_id, operation, status,
        estimated_credits, actual_credits, usage_source, provider_cost_estimate_amount,
        provider_cost_actual_amount, provider_cost_microusd, base_credits, markup_credits, final_credits,
        pricing_source, pricing_confidence, cost_minor, currency, created_at
      from provider_usage_events
      where user_id = $1
      order by created_at desc
      limit $2
      `,
      [input.userId, limit]
    );
    return result.rows;
  }

  async createRun(input: { id?: string; routeId?: string | null; routeVersionId?: string | null; userId?: string | null; status?: string; inputs?: unknown }): Promise<{ id: string }> {
    await this.ensureSchema();
    const result = await this.pool.query<{ id: string }>(
      `
      insert into runs (id, route_id, route_version_id, user_id, status, inputs, started_at)
      values ($1, $2, $3, $4, $5, $6::jsonb, now())
      returning id
      `,
      [input.id ?? randomUUID(), input.routeId ?? null, input.routeVersionId ?? null, input.userId, input.status ?? "running", JSON.stringify(input.inputs ?? {})]
    );
    return result.rows[0];
  }

  async saveNodeRun(input: {
    runId: string;
    nodeId: string;
    nodeType: string;
    status?: string;
    provider?: string | null;
    model?: string | null;
    inputs?: unknown;
    outputs?: unknown;
    error?: unknown;
    estimatedCredits?: number | null;
    actualCredits?: number | null;
    estimatedProviderCostAmount?: number | null;
    actualProviderCostAmount?: number | null;
    providerCostCurrency?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    imageCount?: number | null;
    videoSeconds?: number | null;
    requestCount?: number | null;
    usageSource?: string | null;
  }): Promise<{ id: string }> {
    await this.ensureSchema();
    const result = await this.pool.query<{ id: string }>(
      `
      insert into node_runs (
        run_id, node_id, node_type, provider, model, status, inputs, outputs, error,
        estimated_credits, actual_credits, estimated_provider_cost_amount, actual_provider_cost_amount,
        provider_cost_currency, input_tokens, output_tokens, image_count, video_seconds, request_count,
        usage_source, started_at, completed_at
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, now(), now())
      returning id
      `,
      [
        input.runId,
        input.nodeId,
        input.nodeType,
        input.provider ?? null,
        input.model ?? null,
        input.status ?? "completed",
        JSON.stringify(input.inputs ?? {}),
        JSON.stringify(input.outputs ?? null),
        JSON.stringify(input.error ?? null),
        input.estimatedCredits ?? null,
        input.actualCredits ?? null,
        input.estimatedProviderCostAmount ?? null,
        input.actualProviderCostAmount ?? null,
        input.providerCostCurrency ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.imageCount ?? null,
        input.videoSeconds ?? null,
        input.requestCount ?? null,
        input.usageSource ?? null
      ]
    );
    return result.rows[0];
  }

  async updateNodeRunOutputs(nodeRunId: string, outputs: unknown): Promise<void> {
    await this.ensureSchema();
    await this.pool.query("update node_runs set outputs = $2::jsonb where id = $1", [nodeRunId, JSON.stringify(outputs ?? null)]);
  }

  async saveArtifact(input: SaveArtifactInput): Promise<{ id: string }> {
    await this.ensureSchema();
    const result = await this.pool.query<{ id: string }>(
      `
      insert into artifacts (
        run_id, node_run_id, node_id, route_id, owner_user_id, artifact_kind,
        storage_uri, storage_backend, storage_key, relative_path, mime_type, bytes, metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      returning id
      `,
      [
        input.runId,
        input.nodeRunId ?? null,
        input.nodeId ?? null,
        input.routeId ?? null,
        input.ownerUserId ?? null,
        input.artifactKind,
        input.storageUri,
        input.storageBackend ?? "local",
        input.storageKey ?? null,
        input.relativePath ?? null,
        input.mimeType ?? null,
        input.bytes ?? null,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return result.rows[0];
  }

  async saveProviderUsageEvent(input: SaveProviderUsageEventInput): Promise<{ id: string }> {
    await this.ensureSchema();
    const result = await this.pool.query<{ id: string }>(
      `
      insert into provider_usage_events (
        run_id, node_run_id, user_id, node_id, node_type, provider, model_id, operation, status,
        usage, estimated_credits, actual_credits, usage_source, provider_cost_estimate_amount,
        provider_cost_actual_amount, provider_cost_microusd, base_credits, markup_credits, final_credits,
        pricing_source, pricing_confidence, cost_minor, currency, provider_request_id, metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb)
      returning id
      `,
      [
        input.runId ?? null,
        input.nodeRunId ?? null,
        input.userId ?? null,
        input.nodeId ?? null,
        input.nodeType ?? null,
        input.provider,
        input.modelId ?? null,
        input.operation ?? null,
        input.status ?? null,
        JSON.stringify(input.usage ?? {}),
        input.estimatedCredits ?? null,
        input.actualCredits ?? null,
        input.usageSource ?? null,
        input.providerCostEstimateAmount ?? null,
        input.providerCostActualAmount ?? null,
        input.providerCostMicrousd ?? null,
        input.baseCredits ?? null,
        input.markupCredits ?? null,
        input.finalCredits ?? null,
        input.pricingSource ?? null,
        input.pricingConfidence ?? null,
        input.costMinor ?? null,
        input.currency ?? null,
        input.providerRequestId ?? null,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return result.rows[0];
  }

  async finishRun(input: { runId: string; status: string; outputs?: unknown; error?: unknown }): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `
      update runs
      set status = $2, outputs = $3::jsonb, error = $4::jsonb, completed_at = now()
      where id = $1
      `,
      [input.runId, input.status, JSON.stringify(input.outputs ?? null), JSON.stringify(input.error ?? null)]
    );
  }

  private async ensureDevUser(): Promise<CloudStorageUser> {
    const result = await this.pool.query<{ id: string; display_name: string | null; email: string | null; role: "user" | "admin" }>(
      `
      insert into users (email, display_name)
      values ('dev@boojum.local', 'Boojum Cloud Dev')
      on conflict (email)
      do update set updated_at = now()
      returning id, display_name, email, role
      `
    );
    await this.ensureCreditAccount(result.rows[0].id);
    return {
      id: result.rows[0].id,
      displayName: result.rows[0].display_name ?? undefined,
      email: result.rows[0].email ?? undefined,
      role: result.rows[0].role
    };
  }

  private async postCreditTransaction(input: {
    accountId: string;
    amount: number;
    transactionType: CreditTransactionType;
    runId?: string | null;
    reservationId?: string | null;
    status?: string;
    metadata?: unknown;
    allowNegativeBalance?: boolean;
  }): Promise<{ balance: number; transactionId: string }> {
    return this.withTransaction(async (client) => {
      const accountResult = await client.query<{ balance_minor: string | number }>(
        "select balance_minor from credit_accounts where id = $1 for update",
        [input.accountId]
      );
      const currentBalance = Number(accountResult.rows[0]?.balance_minor ?? 0);
      const nextBalance = currentBalance + input.amount;
      if (nextBalance < 0 && !input.allowNegativeBalance) throw new Error(`Insufficient credits: balance ${currentBalance}, adjustment ${input.amount}.`);
      const transaction = await this.insertCreditTransaction(client, input);
      await client.query("update credit_accounts set balance_minor = $2, updated_at = now() where id = $1", [input.accountId, nextBalance]);
      return { balance: nextBalance, transactionId: transaction.id };
    });
  }

  private async insertCreditTransaction(client: Pick<PgClient, "query">, input: {
    accountId: string;
    amount: number;
    transactionType: CreditTransactionType;
    runId?: string | null;
    reservationId?: string | null;
    status?: string;
    metadata?: unknown;
  }): Promise<{ id: string }> {
    const amount = integerCreditsSigned(input.amount);
    const result = await client.query<{ id: string }>(
      `
      insert into credit_transactions (account_id, amount_minor, transaction_type, run_id, reservation_id, status, metadata)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      returning id
      `,
      [input.accountId, amount, input.transactionType, input.runId ?? null, input.reservationId ?? null, input.status ?? "posted", JSON.stringify(input.metadata ?? {})]
    );
    return result.rows[0];
  }

  private async ensureCreditAccountForUpdate(client: Pick<PgClient, "query">, userId: string, currency = "USD"): Promise<{ id: string; userId: string; currency: string; balanceMinor: number }> {
    await this.ensureSchema();
    await client.query(
      `
      insert into credit_accounts (user_id, currency)
      values ($1, $2)
      on conflict (user_id, currency) do nothing
      `,
      [userId, currency]
    );
    const result = await client.query<{ id: string; user_id: string; currency: string; balance_minor: string | number }>(
      "select id, user_id, currency, balance_minor from credit_accounts where user_id = $1 and currency = $2 for update",
      [userId, currency]
    );
    return {
      id: result.rows[0].id,
      userId: result.rows[0].user_id,
      currency: result.rows[0].currency,
      balanceMinor: Number(result.rows[0].balance_minor)
    };
  }

  private async findReservationForUpdate(client: Pick<PgClient, "query">, reservationId: string): Promise<{ account_id: string; amount_minor: string | number; run_id: string | null } | null> {
    const result = await client.query<{ account_id: string; amount_minor: string | number; run_id: string | null }>(
      "select account_id, amount_minor, run_id from credit_transactions where reservation_id = $1 and transaction_type = 'reserve' for update",
      [reservationId]
    );
    return result.rows[0] ?? null;
  }

  private async releasedReservationAmount(client: Pick<PgClient, "query">, reservationId: string): Promise<number> {
    const result = await client.query<{ amount: string | number }>(
      "select coalesce(sum(amount_minor), 0) as amount from credit_transactions where reservation_id = $1 and transaction_type in ('release', 'refund')",
      [reservationId]
    );
    return Number(result.rows[0]?.amount ?? 0);
  }

  private async withTransaction<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
    if (!this.pool.connect) {
      await this.pool.query("begin");
      try {
        const result = await run({ query: this.pool.query.bind(this.pool), release: () => undefined });
        await this.pool.query("commit");
        return result;
      } catch (error) {
        await this.pool.query("rollback").catch(() => undefined);
        throw error;
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await run(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function runCloudPostgresMigrations(poolOrDatabaseUrl: PgPool | string): Promise<void> {
  const ownsPool = typeof poolOrDatabaseUrl === "string";
  const pool = ownsPool ? createPgPool(poolOrDatabaseUrl) : poolOrDatabaseUrl;
  try {
    const sql = await readFile(new URL("../migrations/001_cloud_storage.sql", import.meta.url), "utf8");
    await pool.query(sql);
  } finally {
    if (ownsPool) await pool.end();
  }
}

function createPgPool(databaseUrl: string): PgPool {
  const require = createRequire(import.meta.url);
  const { Pool } = require("pg") as { Pool: PgPoolConstructor };
  return new Pool({ connectionString: databaseUrl });
}

function integerCredits(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.ceil(value));
}

function integerCreditsSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? -Math.ceil(Math.abs(value)) : Math.ceil(value);
}

function nullIfBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function adminBillingUserSummaryFromRow(row: {
  id: string;
  role: "user" | "admin";
  created_at: string;
  auth_providers: string[] | string | null;
  provider_subject_hash_prefix: string | null;
  current_balance: string | number;
  total_granted: string | number;
  total_captured: string | number;
  total_released: string | number;
  total_refunded: string | number;
  active_reserved: string | number;
  runs_count: string | number;
  last_activity_at: string | null;
}): CloudAdminBillingUserSummary {
  const authProviders = Array.isArray(row.auth_providers)
    ? row.auth_providers
    : typeof row.auth_providers === "string"
      ? row.auth_providers.replace(/[{}]/g, "").split(",").filter(Boolean)
      : [];
  return {
    id: row.id,
    role: row.role,
    createdAt: String(row.created_at),
    authProviders,
    providerSubjectHashPrefix: row.provider_subject_hash_prefix,
    currentBalance: Number(row.current_balance),
    totalGranted: Number(row.total_granted),
    totalCaptured: Number(row.total_captured),
    totalReleased: Number(row.total_released),
    totalRefunded: Number(row.total_refunded),
    activeReserved: Number(row.active_reserved),
    runsCount: Number(row.runs_count),
    lastActivityAt: row.last_activity_at ? String(row.last_activity_at) : null
  };
}

type RouteRow = {
  id: string;
  route_key: string;
  title: string | null;
  description: string | null;
  route_document: unknown;
  route_text: string;
  current_version_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type RouteSummaryRow = Omit<RouteRow, "route_document" | "route_text">;

type AdminUserListingRow = {
  id: string;
  role: "user" | "admin";
  created_at: Date | string;
  provider: CloudAuthIdentityProvider | null;
  provider_subject_hash_prefix: string | null;
};

function rowToRouteRecord(row: RouteRow): CloudRouteRecord {
  return {
    id: row.id,
    routeKey: row.route_key,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    routeDocument: row.route_document,
    routeText: row.route_text,
    currentVersionId: row.current_version_id,
    createdAt: dateText(row.created_at),
    updatedAt: dateText(row.updated_at)
  };
}

function rowToRouteSummary(row: RouteSummaryRow): CloudRouteSummary {
  return {
    id: row.id,
    routeKey: row.route_key,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    currentVersionId: row.current_version_id,
    createdAt: dateText(row.created_at),
    updatedAt: dateText(row.updated_at)
  };
}

function rowToUser(row: { id: string; display_name: string | null; email: string | null; role: "user" | "admin" }): CloudStorageUser {
  return {
    id: row.id,
    displayName: row.display_name ?? undefined,
    email: row.email ?? undefined,
    role: row.role
  };
}

function rowToAdminUserListing(row: AdminUserListingRow): CloudAdminUserListing {
  return {
    id: row.id,
    role: row.role,
    createdAt: dateText(row.created_at),
    provider: row.provider,
    providerSubjectHashPrefix: row.provider_subject_hash_prefix
  };
}

function dateText(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
