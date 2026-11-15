-- Specialist inbox for the "portal" transport: a receiving specialist service inside the same
-- hospital reads the consultation requests that were sent to it, and nothing else.
-- A specialist session has its own context (stetholink.specialist). It is never a clinician
-- context, so no chart-scoped table or command is reachable with it. What it can read is the
-- stored envelope: the approved consultation text with age and sex, and no name, birth date or
-- chart identifier. Replies go through the existing record_provider_callback command.

create function stetholink_private.specialist_context() returns jsonb language plpgsql stable set search_path = '' as $$
declare ctx jsonb := nullif(current_setting('stetholink.specialist', true), '')::jsonb;
begin
  if session_user <> 'stetholink_runtime' or ctx is null or ctx->>'authorization' <> 'active'
     or (ctx->>'expiresAt')::bigint <= extract(epoch from statement_timestamp()) * 1000
     or not coalesce((ctx->'scopes') ? 'inbox:read', false)
     or coalesce(ctx->>'tenantId', '') = '' or coalesce(ctx->>'providerId', '') = ''
     or stetholink_private.context_classification(ctx) is null then
    raise insufficient_privilege using message = 'A specialist session is required';
  end if;
  return ctx;
end $$;

-- Requests delivered to the signed-in specialist's own service, newest first.
create function public.specialist_inbox(p_request uuid default null)
returns table (request_id uuid, status text, sent_at timestamptz, updated_at timestamptz, envelope jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare ctx jsonb := stetholink_private.specialist_context();
begin
  return query select a.id, a.status, a.created_at, a.updated_at, a.envelope
    from public.consultation_delivery_attempts a
    where a.tenant_id = ctx->>'tenantId' and a.recipient_id = ctx->>'providerId'
      and a.status in ('sent','accepted','responded','rejected')
      and a.envelope is not null
      and stetholink_private.record_classification(a.envelope) = stetholink_private.context_classification(ctx)
      and (p_request is null or a.id = p_request)
    order by a.created_at desc limit 50;
end $$;

-- What this service already answered for one of its own requests.
create function public.specialist_responses(p_request uuid)
returns table (response_id text, kind text, payload jsonb, received_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare ctx jsonb := stetholink_private.specialist_context();
begin
  return query select r.response_id, r.kind, r.payload, r.received_at
    from public.consultation_provider_responses r
    where r.request_id = p_request and r.tenant_id = ctx->>'tenantId' and r.provider_id = ctx->>'providerId' and r.disposition = 'applied'
    order by r.received_at;
end $$;

revoke all on function stetholink_private.specialist_context() from public;
revoke all on function public.specialist_inbox(uuid), public.specialist_responses(uuid) from public, anon, authenticated;
grant execute on function public.specialist_inbox(uuid), public.specialist_responses(uuid) to stetholink_runtime;
