-- Provision the password separately. This role owns no objects.
create role stetholink_runtime login noinherit nobypassrls;
create schema stetholink_private;
revoke all on schema stetholink_private from public;
grant usage on schema stetholink_private, public to stetholink_runtime;

create table stetholink_private.browser_sessions (
  handle_hash text primary key,
  kind text not null check (kind in ('launch', 'session')),
  tenant_id text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  expires_at timestamptz not null
);
create index browser_sessions_expiration on stetholink_private.browser_sessions(tenant_id, expires_at);
grant select, insert, delete on stetholink_private.browser_sessions to stetholink_runtime;

-- Historical drafts remain stored. Tenantless rows are inaccessible to EHR sessions.
alter table public.consultation_drafts add column tenant_id text;
create index consultation_draft_scope on public.consultation_drafts(tenant_id, clinician_id, patient_id, encounter_id);
revoke all on public.consultation_drafts, public.consultation_approvals from anon, authenticated, public;
revoke all on function public.record_consultation_approval(text, text, text) from authenticated;
grant select, insert on public.consultation_drafts to stetholink_runtime;

create function stetholink_private.chart_matches(p_tenant text, p_clinician uuid, p_patient text, p_encounter text)
returns boolean language sql stable set search_path = '' as $$
  select session_user = 'stetholink_runtime'
    and p_tenant = claims->>'tenantId'
    and p_clinician::text = claims->>'clinicianId'
    and p_patient = claims->>'patientId'
    and p_encounter is not distinct from claims->>'encounterId'
    and claims->>'authorization' = 'active'
    and (claims->>'expiresAt')::bigint > extract(epoch from statement_timestamp()) * 1000
  from (select nullif(current_setting('stetholink.context', true), '')::jsonb as claims) as ctx;
$$;
revoke all on function stetholink_private.chart_matches(text, uuid, text, text) from public;
grant execute on function stetholink_private.chart_matches(text, uuid, text, text) to stetholink_runtime;

create policy ehr_reads_own_chart_drafts on public.consultation_drafts for select to stetholink_runtime
  using (stetholink_private.chart_matches(tenant_id, clinician_id, patient_id, encounter_id));
create policy ehr_creates_own_chart_drafts on public.consultation_drafts for insert to stetholink_runtime
  with check (
    stetholink_private.chart_matches(tenant_id, clinician_id, patient_id, encounter_id)
    and (nullif(current_setting('stetholink.context', true), '')::jsonb->'scopes') ? 'consultation:draft'
    and status = 'pending_approval' and reviewed_by is null and reviewed_at is null
    and provider is not null and model is not null and prompt_version is not null
  );

create function public.record_ehr_consultation_approval(p_draft_id text, p_decision text, p_comment text)
returns setof public.consultation_drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_context jsonb := nullif(current_setting('stetholink.context', true), '')::jsonb;
  v_draft public.consultation_drafts%rowtype;
  v_time timestamptz := clock_timestamp();
begin
  if session_user <> 'stetholink_runtime'
    or not coalesce((v_context->'roles') ? 'physician' and (v_context->'scopes') ? 'consultation:approve', false)
  then
    raise insufficient_privilege using message = 'Physician authorization required';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject', 'request_changes') or length(p_comment) > 4000 then
    raise invalid_parameter_value using message = 'Invalid approval';
  end if;
  select * into v_draft from public.consultation_drafts
    where id = p_draft_id and stetholink_private.chart_matches(tenant_id, clinician_id, patient_id, encounter_id)
    for update;
  if not found then raise no_data_found using message = 'Draft not found'; end if;
  if v_draft.status not in ('draft', 'pending_approval') then
    raise exception using errcode = 'P0001', message = 'Draft already reviewed';
  end if;
  insert into public.consultation_approvals(draft_id, clinician_id, decision, comment, decided_at)
    values (p_draft_id, v_draft.clinician_id, p_decision, p_comment, v_time);
  return query update public.consultation_drafts
    set status = case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'draft' end,
        reviewed_by = v_draft.clinician_id, reviewed_at = v_time, updated_at = v_time
    where id = v_draft.id returning *;
end;
$$;
revoke all on function public.record_ehr_consultation_approval(text, text, text) from public, anon, authenticated;
grant execute on function public.record_ehr_consultation_approval(text, text, text) to stetholink_runtime;
