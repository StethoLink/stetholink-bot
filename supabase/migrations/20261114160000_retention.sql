-- Retention. One function deletes what has outlived its period; it is run on a schedule by a
-- separate maintenance login, never by the application's runtime role.
--   always:  expired browser sessions and sign-in codes; transcripts past their expiry date
--   p_scribe_days:       recorded visits (note text and audit trail) closed longer ago than this
--   p_consultation_days: consultations in a final state, with their revisions, events, delivery
--                        requests and replies, last changed longer ago than this
--   p_ledger_days:       spend ledger and chart-write ledger rows older than this
-- A null period keeps that kind of record. What was written to the EHR is never touched: the
-- chart is the record; these are StethoLink's working copies.

create role stetholink_maintenance login noinherit nobypassrls;

-- The audit tables stay append-only for the application. Only the retention function, running
-- for a login other than the runtime role, may remove rows that are past their period.
create or replace function stetholink_private.prevent_audit_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
 if session_user <> 'stetholink_runtime' and current_setting('stetholink.retention', true) = 'on' and tg_op = 'DELETE' then return null; end if;
 raise insufficient_privilege using message='Consultation history is append-only';
end $$;

create function public.run_retention(p_scribe_days integer default null, p_consultation_days integer default null, p_ledger_days integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sessions integer; v_transcripts integer; v_visits integer := 0; v_consultations integer := 0; v_ledger integer := 0;
  v_ids text[];
begin
  if session_user = 'stetholink_runtime' then raise insufficient_privilege using message = 'Retention is not run by the application'; end if;
  if least(coalesce(p_scribe_days, 1), coalesce(p_consultation_days, 1), coalesce(p_ledger_days, 1)) < 1 then
    raise invalid_parameter_value using message = 'A retention period is at least one day';
  end if;
  perform set_config('stetholink.retention', 'on', true);

  delete from stetholink_private.browser_sessions where expires_at <= now();
  get diagnostics v_sessions = row_count;

  -- Transcripts past their date, whether or not the note was written.
  with expired as (
    update public.scribe_sessions set transcript_deleted_at = clock_timestamp(), updated_at = clock_timestamp()
      where transcript_deleted_at is null and transcript_expires_at <= now() returning id, tenant_id, clinician_id)
  , gone as (delete from public.scribe_segments where session_id in (select id from expired))
  insert into public.scribe_events(session_id, tenant_id, clinician_id, event_type, detail)
    select id, tenant_id, clinician_id, 'transcript_deleted', '{"reason":"expired"}' from expired;
  get diagnostics v_transcripts = row_count;

  if p_scribe_days is not null then
    select array_agg(id::text) into v_ids from public.scribe_sessions
      where status in ('written','discarded','approved') and updated_at < now() - make_interval(days => p_scribe_days);
    if v_ids is not null then
      delete from public.scribe_events where session_id::text = any(v_ids);
      delete from public.chart_writes where origin_kind in ('scribe_note','scribe_update') and origin_id = any(v_ids);
      delete from public.scribe_sessions where id::text = any(v_ids);
      v_visits := array_length(v_ids, 1);
    end if;
  end if;

  if p_consultation_days is not null then
    select array_agg(id) into v_ids from public.consultation_drafts
      where status in ('responded','rejected','cancelled','archived','failed') and updated_at < now() - make_interval(days => p_consultation_days);
    if v_ids is not null then
      delete from public.consultation_provider_responses where draft_id = any(v_ids);
      delete from public.consultation_delivery_attempts where draft_id = any(v_ids);
      delete from public.consultation_idempotency where draft_id = any(v_ids);
      delete from public.consultation_events where draft_id = any(v_ids);
      delete from public.consultation_revisions where draft_id = any(v_ids);
      delete from public.consultation_approvals where draft_id = any(v_ids);
      delete from public.chart_writes where origin_kind in ('consultation','specialist_report') and origin_id = any(v_ids);
      delete from public.consultation_drafts where id = any(v_ids);
      v_consultations := array_length(v_ids, 1);
    end if;
  end if;

  if p_ledger_days is not null then
    delete from stetholink_private.usage_ledger where usage_day < (now() - make_interval(days => p_ledger_days))::date;
    get diagnostics v_ledger = row_count;
  end if;
  return jsonb_build_object('expiredSessions', v_sessions, 'transcriptsDeleted', v_transcripts, 'visitsDeleted', v_visits,
    'consultationsDeleted', v_consultations, 'ledgerRowsDeleted', v_ledger);
end $$;

revoke all on function public.run_retention(integer, integer, integer) from public, anon, authenticated, stetholink_runtime;
grant execute on function public.run_retention(integer, integer, integer) to stetholink_maintenance;
