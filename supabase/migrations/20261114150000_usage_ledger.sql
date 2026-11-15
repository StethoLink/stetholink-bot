-- Durable spend ledger for model and transcription calls. It replaces the per-process daily limit:
-- every instance of the server reserves against the same tenant total, and the record survives a
-- restart. Rows hold amounts, task names and outcomes only: no prompt, transcript or patient data.

create table stetholink_private.usage_ledger (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  usage_day date not null,
  kind text not null check (kind in ('model','transcription')),
  task text not null check (length(task) between 1 and 64),
  reserved_usd numeric(12,6) not null check (reserved_usd >= 0),
  -- Null until the call is settled. An unsettled reservation counts in full: the provider may have billed it.
  actual_usd numeric(12,6) check (actual_usd is null or actual_usd >= 0),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz
);
create index usage_ledger_day on stetholink_private.usage_ledger(tenant_id, usage_day);
revoke all on stetholink_private.usage_ledger from public;

-- Admits the worst-case cost of one call against the tenant's limit for the UTC day, or refuses it.
-- Reservations of one tenant are serialized, so concurrent calls cannot pass the limit together.
create function public.reserve_spend(p_tenant text, p_kind text, p_task text, p_usd numeric, p_daily_limit numeric)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_spent numeric;
  v_id bigint;
begin
  if session_user <> 'stetholink_runtime' then raise insufficient_privilege using message = 'Not allowed'; end if;
  if p_usd is null or p_usd < 0 or p_daily_limit is null or p_daily_limit <= 0 or coalesce(p_tenant, '') = '' then
    raise invalid_parameter_value using message = 'Invalid reservation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('stetholink-spend:' || p_tenant, 0));
  select coalesce(sum(coalesce(actual_usd, reserved_usd)), 0) into v_spent from stetholink_private.usage_ledger where tenant_id = p_tenant and usage_day = v_day;
  if v_spent + p_usd > p_daily_limit then raise exception using errcode = 'P0001', message = 'Daily spending limit reached'; end if;
  insert into stetholink_private.usage_ledger(tenant_id, usage_day, kind, task, reserved_usd) values (p_tenant, v_day, p_kind, left(p_task, 64), p_usd) returning id into v_id;
  return v_id;
end $$;

-- Replaces a reservation with what the call cost, never more than was reserved.
create function public.settle_spend(p_id bigint, p_actual numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if session_user <> 'stetholink_runtime' then raise insufficient_privilege using message = 'Not allowed'; end if;
  update stetholink_private.usage_ledger set actual_usd = least(greatest(coalesce(p_actual, reserved_usd), 0), reserved_usd), settled_at = clock_timestamp()
    where id = p_id and settled_at is null;
end $$;

revoke all on function public.reserve_spend(text, text, text, numeric, numeric), public.settle_spend(bigint, numeric) from public, anon, authenticated;
grant execute on function public.reserve_spend(text, text, text, numeric, numeric), public.settle_spend(bigint, numeric) to stetholink_runtime;
