-- HarborPay: authentication-linked provider payment records and reconciliation.
-- This schema intentionally creates no stored-value wallet or sample customer activity.

create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  country_code char(2) not null default 'JM',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function private.harborpay_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
end;
$$;

revoke all on function private.harborpay_handle_new_user() from public, anon, authenticated;
drop trigger if exists harborpay_auth_user_created on auth.users;
create trigger harborpay_auth_user_created
after insert on auth.users
for each row execute procedure private.harborpay_handle_new_user();

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  provider text not null default 'paypal' check (provider = 'paypal'),
  provider_order_id text unique,
  provider_capture_id text unique,
  idempotency_key text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'USD' check (currency = 'USD'),
  description text not null,
  status text not null default 'created'
    check (status in ('created', 'approved', 'pending', 'completed', 'failed', 'cancelled', 'refunded', 'review_required')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index if not exists payments_user_created_idx
  on public.payments (user_id, created_at desc);

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'paypal' check (provider = 'paypal'),
  recipient_email text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'USD' check (currency = 'USD'),
  status text not null default 'processing'
    check (status in ('processing', 'submitted', 'succeeded', 'failed', 'requires_review')),
  idempotency_key text not null,
  provider_batch_id text unique,
  provider_item_id text,
  provider_sender_item_id text unique,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (created_by, idempotency_key)
);

create index if not exists payouts_created_at_idx
  on public.payouts (created_at desc);

create table if not exists public.webhook_events (
  provider_event_id text primary key,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists webhook_events_unprocessed_idx
  on public.webhook_events (received_at)
  where processed_at is null;

create or replace function private.harborpay_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private.harborpay_set_updated_at() from public, anon, authenticated;

drop trigger if exists harborpay_profiles_updated_at on public.profiles;
create trigger harborpay_profiles_updated_at
before update on public.profiles
for each row execute procedure private.harborpay_set_updated_at();

drop trigger if exists harborpay_payments_updated_at on public.payments;
create trigger harborpay_payments_updated_at
before update on public.payments
for each row execute procedure private.harborpay_set_updated_at();

drop trigger if exists harborpay_payouts_updated_at on public.payouts;
create trigger harborpay_payouts_updated_at
before update on public.payouts
for each row execute procedure private.harborpay_set_updated_at();

alter table public.profiles enable row level security;
alter table public.payments enable row level security;
alter table public.payouts enable row level security;
alter table public.webhook_events enable row level security;

revoke all on public.profiles, public.payments, public.payouts, public.webhook_events
  from public, anon, authenticated;

grant select on public.profiles, public.payments to authenticated;
grant all on public.profiles, public.payments, public.payouts, public.webhook_events to service_role;

drop policy if exists "Customers can read their own profile" on public.profiles;
create policy "Customers can read their own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "Customers can read their own payments" on public.payments;
create policy "Customers can read their own payments"
  on public.payments for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- No client-side insert/update/delete policies exist for payments, payouts, or webhook events.
-- Payment and payout mutations are provider-driven server operations using the server-only service role.
