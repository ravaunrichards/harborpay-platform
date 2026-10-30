-- HarborPay expansion: merchant operations, refunds, disputes, payment links,
-- audit trail, and atomic PayPal webhook claiming.
-- This is payment-processing infrastructure, not a stored-value/customer wallet.

alter table public.profiles
  add column if not exists phone_e164 text,
  add column if not exists locale text not null default 'en',
  add column if not exists timezone text not null default 'America/Jamaica',
  add column if not exists email_verified_at timestamptz,
  add column if not exists account_status text not null default 'active'
    check (account_status in ('active', 'restricted', 'closed'));

create table if not exists public.merchant_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  display_name text not null check (length(trim(display_name)) between 2 and 120),
  legal_name text,
  country_code char(2) not null default 'JM',
  settlement_currency char(3) not null default 'USD',
  business_email text,
  website_url text,
  status text not null default 'draft'
    check (status in ('draft', 'pending_review', 'active', 'restricted', 'closed')),
  paypal_merchant_id text,
  payouts_enabled boolean not null default false,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists merchant_accounts_owner_created_idx
  on public.merchant_accounts (owner_user_id, created_at desc);
create unique index if not exists merchant_accounts_paypal_merchant_idx
  on public.merchant_accounts (paypal_merchant_id)
  where paypal_merchant_id is not null;

create table if not exists public.merchant_members (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchant_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null check (role in ('owner', 'admin', 'finance', 'support', 'developer', 'viewer')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (merchant_id, user_id)
);
create index if not exists merchant_members_user_idx
  on public.merchant_members (user_id, merchant_id);

create or replace function private.harborpay_has_merchant_role(
  p_merchant_id uuid,
  p_allowed_roles text[] default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.merchant_members mm
    where mm.merchant_id = p_merchant_id
      and mm.user_id = (select auth.uid())
      and (p_allowed_roles is null or mm.role = any(p_allowed_roles))
  );
$$;
revoke all on function private.harborpay_has_merchant_role(uuid, text[]) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.harborpay_has_merchant_role(uuid, text[]) to authenticated;

create or replace function private.harborpay_add_merchant_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.merchant_members (merchant_id, user_id, role)
  values (new.id, new.owner_user_id, 'owner')
  on conflict (merchant_id, user_id) do nothing;
  return new;
end;
$$;
revoke all on function private.harborpay_add_merchant_owner() from public, anon, authenticated;
drop trigger if exists harborpay_merchant_owner_created on public.merchant_accounts;
create trigger harborpay_merchant_owner_created
after insert on public.merchant_accounts
for each row execute procedure private.harborpay_add_merchant_owner();

create table if not exists public.merchant_customers (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchant_accounts(id) on delete restrict,
  email text not null,
  full_name text,
  phone_e164 text,
  country_code char(2),
  external_reference text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists merchant_customers_merchant_email_idx
  on public.merchant_customers (merchant_id, lower(email));
create unique index if not exists merchant_customers_external_reference_idx
  on public.merchant_customers (merchant_id, external_reference)
  where external_reference is not null;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchant_accounts(id) on delete restrict,
  customer_id uuid references public.merchant_customers(id) on delete set null,
  order_reference text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'USD',
  description text not null,
  status text not null default 'created'
    check (status in ('created', 'payment_pending', 'paid', 'partially_refunded', 'refunded', 'cancelled', 'expired')),
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, order_reference),
  unique (merchant_id, idempotency_key)
);
create index if not exists orders_merchant_created_idx
  on public.orders (merchant_id, created_at desc);
create index if not exists orders_customer_created_idx
  on public.orders (customer_id, created_at desc);

create table if not exists public.payment_links (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchant_accounts(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  slug text not null unique,
  title text not null check (length(trim(title)) between 2 and 120),
  description text,
  amount_minor bigint check (amount_minor is null or amount_minor > 0),
  currency char(3) not null default 'USD',
  status text not null default 'active'
    check (status in ('active', 'disabled', 'expired')),
  expires_at timestamptz,
  max_uses integer check (max_uses is null or max_uses > 0),
  use_count integer not null default 0 check (use_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_links_merchant_created_idx
  on public.payment_links (merchant_id, created_at desc);

alter table public.payments
  add column if not exists merchant_id uuid references public.merchant_accounts(id) on delete restrict,
  add column if not exists customer_id uuid references public.merchant_customers(id) on delete set null,
  add column if not exists order_id uuid references public.orders(id) on delete set null,
  add column if not exists payment_link_id uuid references public.payment_links(id) on delete set null,
  add column if not exists fee_minor bigint not null default 0 check (fee_minor >= 0),
  add column if not exists net_minor bigint check (net_minor is null or net_minor >= 0),
  add column if not exists metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object');

create index if not exists payments_merchant_created_idx
  on public.payments (merchant_id, created_at desc);
create index if not exists payments_order_idx
  on public.payments (order_id)
  where order_id is not null;

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  merchant_id uuid references public.merchant_accounts(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'USD',
  reason text,
  status text not null default 'requested'
    check (status in ('requested', 'pending', 'succeeded', 'failed', 'cancelled', 'review_required')),
  idempotency_key text not null,
  provider_refund_id text unique,
  created_by uuid references auth.users(id) on delete set null,
  provider_response jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provider_response) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payment_id, idempotency_key)
);
create index if not exists refunds_payment_created_idx
  on public.refunds (payment_id, created_at desc);
create index if not exists refunds_merchant_created_idx
  on public.refunds (merchant_id, created_at desc);

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  merchant_id uuid references public.merchant_accounts(id) on delete restrict,
  provider_case_id text not null unique,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'USD',
  reason text,
  status text not null default 'open'
    check (status in ('open', 'under_review', 'challenged', 'won', 'lost', 'closed')),
  evidence_due_at timestamptz,
  evidence_submitted_at timestamptz,
  provider_details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provider_details) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists disputes_merchant_status_idx
  on public.disputes (merchant_id, status, created_at desc);
create index if not exists disputes_due_idx
  on public.disputes (evidence_due_at)
  where status in ('open', 'under_review', 'challenged');

create table if not exists public.payment_status_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  previous_status text,
  next_status text not null,
  source text not null check (source in ('api', 'paypal_capture', 'paypal_webhook', 'admin_reconciliation')),
  provider_event_id text references public.webhook_events(provider_event_id) on delete set null,
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists payment_status_events_payment_created_idx
  on public.payment_status_events (payment_id, created_at desc);

create table if not exists public.merchant_api_keys (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchant_accounts(id) on delete cascade,
  label text not null,
  key_prefix text not null unique,
  key_hash text not null unique,
  scopes text[] not null default array['payments:read']::text[],
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_used_at timestamptz,
  expires_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists merchant_api_keys_merchant_idx
  on public.merchant_api_keys (merchant_id, created_at desc);

create table if not exists public.merchant_webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchant_accounts(id) on delete cascade,
  endpoint_url text not null check (endpoint_url like 'https://%'),
  signing_secret_ciphertext text not null,
  event_types text[] not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists merchant_webhook_endpoints_merchant_idx
  on public.merchant_webhook_endpoints (merchant_id);

create table if not exists public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.merchant_webhook_endpoints(id) on delete cascade,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'delivering', 'succeeded', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  last_http_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (endpoint_id, event_id)
);
create index if not exists webhook_deliveries_retry_idx
  on public.webhook_deliveries (next_attempt_at)
  where status in ('queued', 'failed');

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  merchant_id uuid references public.merchant_accounts(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  request_id text,
  ip_address inet,
  user_agent text,
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists audit_events_merchant_created_idx
  on public.audit_events (merchant_id, created_at desc);
create index if not exists audit_events_actor_created_idx
  on public.audit_events (actor_user_id, created_at desc);

alter table public.payouts
  add column if not exists merchant_id uuid references public.merchant_accounts(id) on delete restrict,
  add column if not exists recipient_user_id uuid references auth.users(id) on delete set null,
  add column if not exists fee_minor bigint not null default 0 check (fee_minor >= 0),
  add column if not exists metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object');

alter table public.webhook_events
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_attempts integer not null default 0 check (processing_attempts >= 0),
  add column if not exists locked_by uuid,
  add column if not exists last_error text;

create index if not exists webhook_events_claimable_idx
  on public.webhook_events (received_at)
  where processed_at is null;

-- A worker must acquire an atomic lease before processing an event. This avoids
-- two simultaneous PayPal retries reconciling the same payment or payout twice.
create or replace function public.harborpay_claim_webhook_event(
  p_provider_event_id text,
  p_event_type text,
  p_payload jsonb,
  p_worker_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean := false;
  v_state text;
begin
  insert into public.webhook_events (provider_event_id, event_type, payload)
  values (p_provider_event_id, p_event_type, p_payload)
  on conflict (provider_event_id) do nothing;

  update public.webhook_events
  set processing_started_at = now(),
      processing_attempts = processing_attempts + 1,
      locked_by = p_worker_id,
      last_error = null
  where provider_event_id = p_provider_event_id
    and processed_at is null
    and (
      processing_started_at is null
      or processing_started_at < now() - interval '5 minutes'
    )
  returning true into v_claimed;

  if coalesce(v_claimed, false) then
    return 'claimed';
  end if;

  select case when processed_at is not null then 'processed' else 'busy' end
  into v_state
  from public.webhook_events
  where provider_event_id = p_provider_event_id;

  return coalesce(v_state, 'busy');
end;
$$;

create or replace function public.harborpay_complete_webhook_event(
  p_provider_event_id text,
  p_worker_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_completed boolean := false;
begin
  update public.webhook_events
  set processed_at = now(),
      processing_started_at = null,
      locked_by = null,
      last_error = null
  where provider_event_id = p_provider_event_id
    and locked_by = p_worker_id
    and processed_at is null
  returning true into v_completed;

  return coalesce(v_completed, false);
end;
$$;

create or replace function public.harborpay_release_webhook_event(
  p_provider_event_id text,
  p_worker_id uuid,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released boolean := false;
begin
  update public.webhook_events
  set processing_started_at = null,
      locked_by = null,
      last_error = left(coalesce(p_error, 'Processing failed'), 1000)
  where provider_event_id = p_provider_event_id
    and locked_by = p_worker_id
    and processed_at is null
  returning true into v_released;

  return coalesce(v_released, false);
end;
$$;

revoke all on function public.harborpay_claim_webhook_event(text, text, jsonb, uuid)
  from public, anon, authenticated;
revoke all on function public.harborpay_complete_webhook_event(text, uuid)
  from public, anon, authenticated;
revoke all on function public.harborpay_release_webhook_event(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.harborpay_claim_webhook_event(text, text, jsonb, uuid) to service_role;
grant execute on function public.harborpay_complete_webhook_event(text, uuid) to service_role;
grant execute on function public.harborpay_release_webhook_event(text, uuid, text) to service_role;

-- All new tables use RLS. The service role is the only role allowed to mutate
-- payment, payout, API key, webhook endpoint, delivery, and audit records.
alter table public.merchant_accounts enable row level security;
alter table public.merchant_members enable row level security;
alter table public.merchant_customers enable row level security;
alter table public.orders enable row level security;
alter table public.payment_links enable row level security;
alter table public.refunds enable row level security;
alter table public.disputes enable row level security;
alter table public.payment_status_events enable row level security;
alter table public.merchant_api_keys enable row level security;
alter table public.merchant_webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;
alter table public.audit_events enable row level security;

revoke all on public.merchant_accounts, public.merchant_members, public.merchant_customers,
  public.orders, public.payment_links, public.refunds, public.disputes,
  public.payment_status_events, public.merchant_api_keys, public.merchant_webhook_endpoints,
  public.webhook_deliveries, public.audit_events
from public, anon, authenticated;

grant select on public.merchant_accounts, public.merchant_members, public.merchant_customers,
  public.orders, public.payment_links, public.refunds, public.disputes,
  public.payment_status_events
to authenticated;

grant all on public.merchant_accounts, public.merchant_members, public.merchant_customers,
  public.orders, public.payment_links, public.refunds, public.disputes,
  public.payment_status_events, public.merchant_api_keys, public.merchant_webhook_endpoints,
  public.webhook_deliveries, public.audit_events
to service_role;

drop policy if exists "Merchant members can read their merchant accounts" on public.merchant_accounts;
create policy "Merchant members can read their merchant accounts"
  on public.merchant_accounts for select to authenticated
  using (private.harborpay_has_merchant_role(id, null));

drop policy if exists "Users can read their own merchant membership" on public.merchant_members;
create policy "Users can read their own merchant membership"
  on public.merchant_members for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.harborpay_has_merchant_role(merchant_id, array['owner', 'admin', 'finance']::text[])
  );

drop policy if exists "Merchant members can read their customers" on public.merchant_customers;
create policy "Merchant members can read their customers"
  on public.merchant_customers for select to authenticated
  using (private.harborpay_has_merchant_role(merchant_id, array['owner', 'admin', 'finance', 'support']::text[]));

drop policy if exists "Merchant members can read their orders" on public.orders;
create policy "Merchant members can read their orders"
  on public.orders for select to authenticated
  using (private.harborpay_has_merchant_role(merchant_id, null));

drop policy if exists "Merchant members can read their payment links" on public.payment_links;
create policy "Merchant members can read their payment links"
  on public.payment_links for select to authenticated
  using (private.harborpay_has_merchant_role(merchant_id, null));

drop policy if exists "Customers and merchant members can read payments" on public.payments;
drop policy if exists "Customers can read their own payments" on public.payments;
create policy "Customers and merchant members can read payments"
  on public.payments for select to authenticated
  using (
    (select auth.uid()) = user_id
    or (
      merchant_id is not null
      and private.harborpay_has_merchant_role(merchant_id, null)
    )
  );

drop policy if exists "Merchant members can read refunds" on public.refunds;
create policy "Merchant members can read refunds"
  on public.refunds for select to authenticated
  using (
    merchant_id is not null
    and private.harborpay_has_merchant_role(merchant_id, array['owner', 'admin', 'finance', 'support']::text[])
  );

drop policy if exists "Merchant members can read disputes" on public.disputes;
create policy "Merchant members can read disputes"
  on public.disputes for select to authenticated
  using (
    merchant_id is not null
    and private.harborpay_has_merchant_role(merchant_id, array['owner', 'admin', 'finance', 'support']::text[])
  );

drop policy if exists "Customers and merchant members can read payment status history" on public.payment_status_events;
create policy "Customers and merchant members can read payment status history"
  on public.payment_status_events for select to authenticated
  using (
    exists (
      select 1
      from public.payments p
      where p.id = payment_id
        and (
          p.user_id = (select auth.uid())
          or (
            p.merchant_id is not null
            and private.harborpay_has_merchant_role(p.merchant_id, null)
          )
        )
    )
  );

drop trigger if exists harborpay_merchant_accounts_updated_at on public.merchant_accounts;
create trigger harborpay_merchant_accounts_updated_at
before update on public.merchant_accounts
for each row execute procedure private.harborpay_set_updated_at();

drop trigger if exists harborpay_customers_updated_at on public.merchant_customers;
create trigger harborpay_customers_updated_at
before update on public.merchant_customers
for each row execute procedure private.harborpay_set_updated_at();

drop trigger if exists harborpay_orders_updated_at on public.orders;
create trigger harborpay_orders_updated_at
before update on public.orders
for each row execute procedure private.harborpay_set_updated_at();

drop trigger if exists harborpay_payment_links_updated_at on public.payment_links;
create trigger harborpay_payment_links_updated_at
before update on public.payment_links
for each row execute procedure private.harborpay_set_updated_at();

drop trigger if exists harborpay_refunds_updated_at on public.refunds;
create trigger harborpay_refunds_updated_at
before update on public.refunds
for each row execute procedure private.harborpay_set_updated_at();

drop trigger if exists harborpay_disputes_updated_at on public.disputes;
create trigger harborpay_disputes_updated_at
before update on public.disputes
for each row execute procedure private.harborpay_set_updated_at();

drop trigger if exists harborpay_payouts_updated_at on public.payouts;
create trigger harborpay_payouts_updated_at
before update on public.payouts
for each row execute procedure private.harborpay_set_updated_at();

drop trigger if exists harborpay_webhook_endpoints_updated_at on public.merchant_webhook_endpoints;
create trigger harborpay_webhook_endpoints_updated_at
before update on public.merchant_webhook_endpoints
for each row execute procedure private.harborpay_set_updated_at();

comment on table public.payments is
  'Provider-backed payment records. Not a customer-held stored-value balance.';
comment on table public.payouts is
  'Merchant-initiated PayPal disbursement audit records. Not a customer wallet withdrawal ledger.';
comment on table public.merchant_api_keys is
  'Only one-way key hashes are stored. Never persist plaintext API keys.';
comment on table public.merchant_webhook_endpoints is
  'Webhook signing secrets must be envelope-encrypted by the API before storage.';
