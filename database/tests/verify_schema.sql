-- Fails the migration CI job when a required object or security control is missing.
do $$
declare
  required_tables text[] := array[
    'profiles','payments','payouts','webhook_events','merchant_accounts',
    'merchant_members','merchant_customers','orders','payment_links',
    'refunds','disputes','payment_status_events','merchant_api_keys',
    'merchant_webhook_endpoints','webhook_deliveries','audit_events'
  ];
  item text;
begin
  foreach item in array required_tables loop
    if to_regclass('public.' || item) is null then
      raise exception 'Required HarborPay table is missing: %', item;
    end if;
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = item and c.relrowsecurity
    ) then
      raise exception 'RLS is not enabled for HarborPay table: %', item;
    end if;
  end loop;

  if to_regprocedure('public.harborpay_claim_webhook_event(text,text,jsonb,uuid)') is null
    or to_regprocedure('public.harborpay_complete_webhook_event(text,uuid)') is null
    or to_regprocedure('public.harborpay_release_webhook_event(text,uuid,text)') is null then
    raise exception 'HarborPay webhook RPC functions are incomplete';
  end if;

  if has_function_privilege('authenticated',
       'public.harborpay_claim_webhook_event(text,text,jsonb,uuid)', 'EXECUTE') then
    raise exception 'Authenticated users must not execute the privileged webhook claim RPC';
  end if;
  if not has_function_privilege('service_role',
       'public.harborpay_claim_webhook_event(text,text,jsonb,uuid)', 'EXECUTE') then
    raise exception 'The service role is missing webhook claim RPC permission';
  end if;

  if to_regclass('public.wallet_balances') is not null
    or to_regclass('public.customer_wallets') is not null then
    raise exception 'This schema must not create unapproved stored-value balances';
  end if;
end;
$$;

-- Auth trigger must create exactly the profile linked to each new Auth user.
insert into auth.users (id, email, raw_user_meta_data)
values
  ('11111111-1111-4111-8111-111111111111', 'owner-one@example.test', '{"full_name":"CI Owner One"}'::jsonb),
  ('22222222-2222-4222-8222-222222222222', 'owner-two@example.test', '{"full_name":"CI Owner Two"}'::jsonb);

do $$
begin
  if not exists (
    select 1 from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'
      and email = 'owner-one@example.test'
      and full_name = 'CI Owner One'
  ) then
    raise exception 'Auth user creation did not create the matching HarborPay profile';
  end if;
end;
$$;

-- Merchant creation must automatically grant the owner role.
insert into public.merchant_accounts (owner_user_id, display_name)
values
  ('11111111-1111-4111-8111-111111111111', 'CI Merchant One'),
  ('22222222-2222-4222-8222-222222222222', 'CI Merchant Two');

do $$
begin
  if not exists (
    select 1 from public.merchant_accounts ma
    join public.merchant_members mm on mm.merchant_id = ma.id
    where ma.owner_user_id = '11111111-1111-4111-8111-111111111111'
      and mm.user_id = ma.owner_user_id
      and mm.role = 'owner'
  ) then
    raise exception 'Merchant owner membership trigger did not run';
  end if;
end;
$$;

insert into public.merchant_customers (merchant_id, email)
select id, 'buyer@example.test'
from public.merchant_accounts
where owner_user_id = '11111111-1111-4111-8111-111111111111';

insert into public.orders (merchant_id, order_reference, amount_minor, currency, description, idempotency_key)
select id, 'CI-ORDER-1', 1250, 'USD', 'CI ownership test', 'ci-order-idempotency-0001'
from public.merchant_accounts
where owner_user_id = '11111111-1111-4111-8111-111111111111';

insert into public.payment_links (merchant_id, created_by, slug, title, amount_minor)
select id, owner_user_id, 'ci-link-one', 'CI fixed payment link', 1250
from public.merchant_accounts
where owner_user_id = '11111111-1111-4111-8111-111111111111';

insert into public.payments (user_id, idempotency_key, amount_minor, currency, description)
values
  ('11111111-1111-4111-8111-111111111111', 'ci-owner-one-idempotency-0001', 1250, 'USD', 'CI ownership test'),
  ('22222222-2222-4222-8222-222222222222', 'ci-owner-two-idempotency-0001', 2500, 'USD', 'CI ownership test');

-- An authenticated customer can read only their own profile and payments,
-- and a merchant owner can see only their own merchant's operating data.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$
declare
  profiles_visible integer;
  payments_visible integer;
  merchants_visible integer;
  customers_visible integer;
  orders_visible integer;
  links_visible integer;
begin
  select count(*) into profiles_visible from public.profiles;
  select count(*) into payments_visible from public.payments;
  select count(*) into merchants_visible from public.merchant_accounts;
  select count(*) into customers_visible from public.merchant_customers;
  select count(*) into orders_visible from public.orders;
  select count(*) into links_visible from public.payment_links;

  if profiles_visible <> 1 then raise exception 'Profile RLS exposed % rows', profiles_visible; end if;
  if payments_visible <> 1 then raise exception 'Payment RLS exposed % rows', payments_visible; end if;
  if merchants_visible <> 1 then raise exception 'Merchant RLS exposed % rows', merchants_visible; end if;
  if customers_visible <> 1 then raise exception 'Customer RLS exposed % rows', customers_visible; end if;
  if orders_visible <> 1 then raise exception 'Order RLS exposed % rows', orders_visible; end if;
  if links_visible <> 1 then raise exception 'Payment-link RLS exposed % rows', links_visible; end if;
end;
$$;
rollback;

-- The atomic webhook inbox rejects duplicate concurrent claims and marks
-- completed events as permanently processed.
begin;
set local role service_role;
do $$
declare
  worker_one uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  worker_two uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  state text;
begin
  state := public.harborpay_claim_webhook_event(
    'ci-webhook-event-1', 'TEST.EVENT',
    '{"id":"ci-webhook-event-1"}'::jsonb, worker_one
  );
  if state <> 'claimed' then raise exception 'First worker was not allowed to claim event: %', state; end if;

  state := public.harborpay_claim_webhook_event(
    'ci-webhook-event-1', 'TEST.EVENT',
    '{"id":"ci-webhook-event-1"}'::jsonb, worker_two
  );
  if state <> 'busy' then raise exception 'Second worker was not blocked by the active lease: %', state; end if;

  if not public.harborpay_complete_webhook_event('ci-webhook-event-1', worker_one) then
    raise exception 'Owning worker could not complete webhook';
  end if;

  state := public.harborpay_claim_webhook_event(
    'ci-webhook-event-1', 'TEST.EVENT',
    '{"id":"ci-webhook-event-1"}'::jsonb, worker_two
  );
  if state <> 'processed' then raise exception 'Completed webhook was not deduplicated: %', state; end if;

  state := public.harborpay_claim_webhook_event(
    'ci-webhook-event-2', 'TEST.EVENT',
    '{"id":"ci-webhook-event-2"}'::jsonb, worker_one
  );
  if state <> 'claimed' then raise exception 'Second webhook was not claimable: %', state; end if;
  if not public.harborpay_release_webhook_event('ci-webhook-event-2', worker_one, 'test retry') then
    raise exception 'Worker could not release a failed webhook';
  end if;
  state := public.harborpay_claim_webhook_event(
    'ci-webhook-event-2', 'TEST.EVENT',
    '{"id":"ci-webhook-event-2"}'::jsonb, worker_two
  );
  if state <> 'claimed' then raise exception 'Released webhook could not be retried: %', state; end if;
end;
$$;
rollback;
