create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  email text unique,
  role text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table users add column if not exists role text not null default 'user';

create table if not exists auth_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  provider_subject text not null,
  provider_subject_hash text,
  provider_email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subject)
);

alter table auth_identities add column if not exists provider_subject_hash text;
alter table auth_identities alter column provider_subject drop not null;
create unique index if not exists auth_identities_provider_subject_hash_idx on auth_identities(provider, provider_subject_hash) where provider_subject_hash is not null;

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  session_token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists routes (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete set null,
  route_key text not null,
  title text,
  description text,
  current_version_id uuid,
  route_document jsonb not null,
  route_text text not null,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, route_key)
);

create table if not exists route_versions (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  version_number integer not null,
  route_document jsonb not null,
  route_text text not null,
  created_by_user_id uuid references users(id) on delete set null,
  change_note text,
  created_at timestamptz not null default now(),
  unique (route_id, version_number)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'routes_current_version_id_fkey'
  ) then
    alter table routes
      add constraint routes_current_version_id_fkey
      foreign key (current_version_id) references route_versions(id) on delete set null;
  end if;
end $$;

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  route_id uuid references routes(id) on delete set null,
  route_version_id uuid references route_versions(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  status text not null default 'queued',
  inputs jsonb not null default '{}'::jsonb,
  outputs jsonb,
  error jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists node_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  node_id text not null,
  node_type text not null,
  status text not null default 'queued',
  inputs jsonb not null default '{}'::jsonb,
  outputs jsonb,
  error jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table node_runs add column if not exists provider text;
alter table node_runs add column if not exists model text;
alter table node_runs add column if not exists estimated_credits numeric(18, 6);
alter table node_runs add column if not exists actual_credits numeric(18, 6);
alter table node_runs add column if not exists estimated_provider_cost_amount numeric(18, 8);
alter table node_runs add column if not exists actual_provider_cost_amount numeric(18, 8);
alter table node_runs add column if not exists provider_cost_currency text;
alter table node_runs add column if not exists input_tokens bigint;
alter table node_runs add column if not exists output_tokens bigint;
alter table node_runs add column if not exists image_count integer;
alter table node_runs add column if not exists video_seconds numeric(18, 6);
alter table node_runs add column if not exists request_count integer;
alter table node_runs add column if not exists usage_source text;

create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete cascade,
  node_run_id uuid references node_runs(id) on delete set null,
  route_id uuid references routes(id) on delete set null,
  owner_user_id uuid references users(id) on delete set null,
  artifact_kind text not null,
  storage_uri text not null,
  mime_type text,
  bytes bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table artifacts add column if not exists node_id text;
alter table artifacts add column if not exists storage_backend text not null default 'local';
alter table artifacts add column if not exists storage_key text;
alter table artifacts add column if not exists relative_path text;

create table if not exists credit_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  currency text not null default 'USD',
  balance_minor bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, currency)
);

alter table credit_accounts drop constraint if exists credit_accounts_non_negative_balance;
alter table credit_accounts add constraint credit_accounts_non_negative_balance check (balance_minor >= 0);

create table if not exists credit_transactions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references credit_accounts(id) on delete cascade,
  amount_minor bigint not null,
  transaction_type text not null,
  provider text,
  external_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table credit_transactions add column if not exists run_id uuid references runs(id) on delete set null;
alter table credit_transactions add column if not exists reservation_id uuid;
alter table credit_transactions add column if not exists status text not null default 'posted';

create or replace function prevent_credit_transaction_mutation()
returns trigger as $$
begin
  raise exception 'credit_transactions is immutable; insert a correcting transaction instead';
end;
$$ language plpgsql;

drop trigger if exists credit_transactions_no_update on credit_transactions;
create trigger credit_transactions_no_update
before update on credit_transactions
for each row execute function prevent_credit_transaction_mutation();

drop trigger if exists credit_transactions_no_delete on credit_transactions;
create trigger credit_transactions_no_delete
before delete on credit_transactions
for each row execute function prevent_credit_transaction_mutation();

create table if not exists pricing_catalog (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model_id text not null,
  capability text,
  currency text,
  pricing jsonb not null default '{}'::jsonb,
  source text,
  refreshed_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (provider, model_id, capability)
);

create table if not exists billing_pricing_config (
  id text primary key default 'default',
  global_markup_percent integer not null default 0,
  global_markup_credits bigint not null default 0,
  min_charge_credits bigint not null default 0,
  rounding_mode text not null default 'ceil',
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  constraint billing_pricing_config_singleton check (id = 'default'),
  constraint billing_pricing_config_non_negative check (
    global_markup_percent >= 0
    and global_markup_credits >= 0
    and min_charge_credits >= 0
  )
);

create table if not exists billing_pricing_overrides (
  id uuid primary key default gen_random_uuid(),
  provider text,
  operation text,
  model text,
  node_type text,
  markup_percent integer not null default 0,
  markup_credits bigint not null default 0,
  enabled boolean not null default true,
  reason text,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  constraint billing_pricing_overrides_non_negative check (
    markup_percent >= 0
    and markup_credits >= 0
  )
);

create unique index if not exists billing_pricing_overrides_scope_idx on billing_pricing_overrides(
  coalesce(provider, ''),
  coalesce(operation, ''),
  coalesce(model, ''),
  coalesce(node_type, '')
);

create table if not exists provider_usage_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete set null,
  node_run_id uuid references node_runs(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  provider text not null,
  model_id text,
  usage jsonb not null default '{}'::jsonb,
  cost_minor bigint,
  currency text,
  provider_request_id text,
  created_at timestamptz not null default now()
);

alter table provider_usage_events add column if not exists node_id text;
alter table provider_usage_events add column if not exists node_type text;
alter table provider_usage_events add column if not exists operation text;
alter table provider_usage_events add column if not exists status text;
alter table provider_usage_events add column if not exists estimated_credits numeric(18, 6);
alter table provider_usage_events add column if not exists actual_credits numeric(18, 6);
alter table provider_usage_events add column if not exists usage_source text;
alter table provider_usage_events add column if not exists provider_cost_estimate_amount numeric(18, 8);
alter table provider_usage_events add column if not exists provider_cost_actual_amount numeric(18, 8);
alter table provider_usage_events add column if not exists provider_cost_microusd bigint;
alter table provider_usage_events add column if not exists base_credits bigint;
alter table provider_usage_events add column if not exists markup_credits bigint;
alter table provider_usage_events add column if not exists final_credits bigint;
alter table provider_usage_events add column if not exists pricing_source text;
alter table provider_usage_events add column if not exists pricing_confidence text;
alter table provider_usage_events add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists auth_identities_user_id_idx on auth_identities(user_id);
create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists routes_owner_user_id_idx on routes(owner_user_id) where is_deleted = false;
create index if not exists route_versions_route_id_idx on route_versions(route_id);
create index if not exists runs_route_id_idx on runs(route_id);
create index if not exists node_runs_run_id_idx on node_runs(run_id);
create index if not exists artifacts_run_id_idx on artifacts(run_id);
create index if not exists credit_transactions_account_id_idx on credit_transactions(account_id);
create index if not exists credit_transactions_run_id_idx on credit_transactions(run_id);
create unique index if not exists credit_transactions_capture_once_idx on credit_transactions(reservation_id) where transaction_type = 'capture' and reservation_id is not null;
create index if not exists provider_usage_events_run_id_idx on provider_usage_events(run_id);
create index if not exists audit_events_actor_user_id_idx on audit_events(actor_user_id);
