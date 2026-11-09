-- Existing unowned rows stay inaccessible. No patient data is copied from the old project.
alter table public.consultation_drafts
  add column clinician_id uuid,
  add column reviewed_by uuid,
  add column reviewed_at timestamptz,
  add column provider text,
  add column model text,
  add column prompt_version text;
create index consultation_drafts_clinician_id_idx on public.consultation_drafts(clinician_id);
create index consultation_approvals_draft_id_idx on public.consultation_approvals(draft_id);

create function public.is_stetholink_clinician() returns boolean
language sql stable security invoker set search_path = '' as $$
  select (select auth.uid()) is not null
    and coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false'
    and coalesce((select auth.jwt())->'app_metadata'->>'role', '') in ('clinician', 'admin');
$$;
revoke all on function public.is_stetholink_clinician() from public, anon;
grant execute on function public.is_stetholink_clinician() to authenticated;

revoke all on public.consultation_drafts, public.consultation_approvals from anon, authenticated;
grant select, insert on public.consultation_drafts to authenticated;
grant select on public.consultation_approvals to authenticated;

create policy clinician_reads_own_drafts on public.consultation_drafts for select to authenticated
  using ((select public.is_stetholink_clinician()) and clinician_id = (select auth.uid()));
create policy clinician_creates_pending_drafts on public.consultation_drafts for insert to authenticated
  with check ((select public.is_stetholink_clinician()) and clinician_id = (select auth.uid())
    and status = 'pending_approval' and reviewed_by is null and reviewed_at is null
    and provider is not null and model is not null and prompt_version is not null);
create policy clinician_reads_own_approvals on public.consultation_approvals for select to authenticated
  using ((select public.is_stetholink_clinician()) and clinician_id = (select auth.uid())
    and exists (select 1 from public.consultation_drafts d where d.id = draft_id and d.clinician_id = (select auth.uid())));

-- Privileged only to atomically perform the two writes. No general UPDATE or audit INSERT
-- permission is granted to callers. Every invocation checks identity, trusted role, and ownership.
create function public.record_consultation_approval(p_draft_id text, p_decision text, p_comment text default null)
returns setof public.consultation_drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_draft public.consultation_drafts%rowtype;
  v_time timestamptz := clock_timestamp();
begin
  if v_uid is null or not public.is_stetholink_clinician() then
    raise insufficient_privilege using message = 'Clinician access required';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject', 'request_changes') or length(p_comment) > 4000 then
    raise invalid_parameter_value using message = 'Invalid approval';
  end if;
  select * into v_draft from public.consultation_drafts
    where id = p_draft_id and clinician_id = v_uid for update;
  if not found then raise no_data_found using message = 'Draft not found'; end if;
  if v_draft.status not in ('draft', 'pending_approval') then
    raise exception using errcode = 'P0001', message = 'Draft already reviewed';
  end if;
  insert into public.consultation_approvals(draft_id, clinician_id, decision, comment, decided_at)
    values (p_draft_id, v_uid, p_decision, p_comment, v_time);
  return query update public.consultation_drafts
    set status = case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'draft' end,
        reviewed_by = v_uid, reviewed_at = v_time, updated_at = v_time
    where id = p_draft_id and clinician_id = v_uid returning *;
end;
$$;
revoke all on function public.record_consultation_approval(text, text, text) from public, anon;
grant execute on function public.record_consultation_approval(text, text, text) to authenticated;
