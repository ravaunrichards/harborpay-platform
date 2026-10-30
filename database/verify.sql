-- Read-only HarborPay database verification. Run after applying all migrations.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'profiles','payments','payouts','webhook_events','merchant_accounts',
    'merchant_members','merchant_customers','orders','payment_links',
    'refunds','disputes','payment_status_events','merchant_api_keys',
    'merchant_webhook_endpoints','webhook_deliveries','audit_events'
  )
order by table_name;

select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'profiles','payments','payouts','webhook_events','merchant_accounts',
    'merchant_members','merchant_customers','orders','payment_links',
    'refunds','disputes','payment_status_events','merchant_api_keys',
    'merchant_webhook_endpoints','webhook_deliveries','audit_events'
  )
order by c.relname;

select routine_name, routine_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'harborpay_claim_webhook_event',
    'harborpay_complete_webhook_event',
    'harborpay_release_webhook_event'
  )
order by routine_name;
