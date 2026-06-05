import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

type PgPool = {
  query: <T = Record<string, unknown>>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
  end: () => Promise<void>;
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
      "select id, run_id, node_run_id, user_id, node_id, node_type, provider, model_id, operation, status, estimated_credits, actual_credits, usage_source, provider_cost_estimate_amount, provider_cost_actual_amount, cost_minor, currency, created_at from provider_usage_events order by created_at desc limit 50"
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
    if (!Number.isFinite(amount) || amount <= 0) return;
    const account = await this.ensureCreditAccount(userId);
    const existing = await this.pool.query<{ id: string }>(
      "select id from credit_transactions where account_id = $1 and transaction_type = 'grant_start' limit 1",
      [account.id]
    );
    if (existing.rows.length > 0) return;
    await this.pool.query(
      `
      insert into credit_transactions (account_id, amount_minor, transaction_type, status, metadata)
      values ($1, $2, 'grant_start', 'posted', $3::jsonb)
      `,
      [account.id, amount, JSON.stringify({ reason: "BOOJUM_START_CREDITS" })]
    );
    await this.pool.query("update credit_accounts set balance_minor = balance_minor + $2, updated_at = now() where id = $1", [account.id, amount]);
  }

  async getCreditBalance(userId: string): Promise<{ userId: string; balance: number; currency: string }> {
    const account = await this.ensureCreditAccount(userId);
    return { userId, balance: account.balanceMinor, currency: account.currency };
  }

  async reserveCredits(input: { userId: string; runId: string; amount: number }): Promise<{ reservationId: string; amount: number }> {
    const amount = Math.max(0, input.amount);
    const account = await this.ensureCreditAccount(input.userId);
    if (amount <= 0) return { reservationId: randomUUID(), amount: 0 };
    const balance = await this.getCreditBalance(input.userId);
    if (balance.balance < amount) throw new Error(`Insufficient credits: need ${amount}, balance ${balance.balance}.`);
    const reservationId = randomUUID();
    await this.pool.query(
      `
      insert into credit_transactions (account_id, amount_minor, transaction_type, run_id, reservation_id, status, metadata)
      values ($1, $2, 'reserve', $3, $4, 'reserved', $5::jsonb)
      `,
      [account.id, -amount, input.runId, reservationId, JSON.stringify({ runId: input.runId })]
    );
    await this.pool.query("update credit_accounts set balance_minor = balance_minor - $2, updated_at = now() where id = $1", [account.id, amount]);
    return { reservationId, amount };
  }

  async commitCredits(input: { reservationId: string; actualAmount: number }): Promise<{ charged: number; refunded: number }> {
    const reserve = await this.findReservation(input.reservationId);
    if (!reserve) throw new Error(`Credit reservation "${input.reservationId}" was not found.`);
    const reserved = Math.abs(Number(reserve.amount_minor));
    const charged = Math.max(0, Math.min(reserved, input.actualAmount));
    const refunded = Math.max(0, reserved - charged);
    await this.pool.query("update credit_transactions set status = 'committed', metadata = metadata || $2::jsonb where reservation_id = $1 and transaction_type = 'reserve'", [
      input.reservationId,
      JSON.stringify({ actualAmount: charged, refunded })
    ]);
    if (refunded > 0) await this.refundCredits({ reservationId: input.reservationId, amount: refunded });
    return { charged, refunded };
  }

  async refundCredits(input: { reservationId: string; amount: number }): Promise<{ refunded: number }> {
    const reserve = await this.findReservation(input.reservationId);
    if (!reserve) throw new Error(`Credit reservation "${input.reservationId}" was not found.`);
    const amount = Math.max(0, input.amount);
    if (amount <= 0) return { refunded: 0 };
    await this.pool.query(
      `
      insert into credit_transactions (account_id, amount_minor, transaction_type, run_id, reservation_id, status, metadata)
      values ($1, $2, 'refund', $3, $4, 'posted', $5::jsonb)
      `,
      [reserve.account_id, amount, reserve.run_id, input.reservationId, JSON.stringify({ reason: "reservation_refund" })]
    );
    await this.pool.query("update credit_accounts set balance_minor = balance_minor + $2, updated_at = now() where id = $1", [reserve.account_id, amount]);
    return { refunded: amount };
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
        provider_cost_actual_amount, cost_minor, currency, provider_request_id, metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb)
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

  private async findReservation(reservationId: string): Promise<{ account_id: string; amount_minor: string | number; run_id: string | null } | null> {
    const result = await this.pool.query<{ account_id: string; amount_minor: string | number; run_id: string | null }>(
      "select account_id, amount_minor, run_id from credit_transactions where reservation_id = $1 and transaction_type = 'reserve' limit 1",
      [reservationId]
    );
    return result.rows[0] ?? null;
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
