-- PostgREST/Supabase guards reject unqualified DELETE statements even inside
-- this admin RPC. Explicit WHERE true preserves the intentional full reset.
create or replace function public.admin_reset_tournament_to_entry(
  p_live_job_ids uuid[], p_live_match_ids bigint[]
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_state public.tournament_state;
  v_jobs int;
  v_replays int;
  v_recovered_jobs int;
begin
  if auth.role() <> 'service_role' and not public.is_admin() then
    raise exception 'admin_required' using errcode = '42501';
  end if;
  if p_live_job_ids is null or p_live_match_ids is null then
    raise exception 'live_work_ids_required';
  end if;
  select * into v_state from public.tournament_state where id = 1 for update;
  if not found then raise exception 'tournament_state_missing'; end if;
  if exists(select 1 from public.scoring_jobs where status in ('dispatching', 'accepted', 'running')
      and (id = any(p_live_job_ids) or coalesce(started_at, accepted_at, created_at) >= now() - interval '15 minutes')) then
    raise exception 'scoring_jobs_still_running' using errcode = '55000';
  end if;
  if exists(select 1 from public.matches where state = 'running'
      and (id = any(p_live_match_ids) or started_at is null or started_at >= now() - interval '5 minutes')) then
    raise exception 'tournament_matches_still_running' using errcode = '55000';
  end if;

  update public.scoring_jobs set status = 'failed', error_code = 'reset_orphaned_job',
    error_message = 'Yêu cầu chấm bị đóng khi reset giải đấu.', finished_at = now(), updated_at = now()
    where status in ('dispatching', 'accepted', 'running');
  get diagnostics v_recovered_jobs = row_count;
  insert into public.tournament_reset_source_cleanup(job_id)
    select id from public.scoring_jobs on conflict (job_id) do nothing;
  insert into public.tournament_reset_cleanup(storage_path)
    select storage_path from public.replay_objects on conflict (storage_path) do nothing;
  get diagnostics v_replays = row_count;

  delete from public.replay_objects where true;
  delete from public.submissions where true;
  delete from public.daily_results where true;
  delete from public.round_byes where true;
  delete from public.matches where true;
  delete from public.contest_days where true;
  delete from public.round_members where true;
  delete from public.round_advancement where true;
  delete from public.live_scores where true;
  delete from public.scoring_jobs where true;
  get diagnostics v_jobs = row_count;
  delete from public.admin_disqualifications where true;
  update public.profiles set status = 'new', entry_score = null where role = 'contestant';
  update public.tournament_state set phase = 'entry', current_round = 0, current_day = 0,
    pending_day = 0, accepting_submissions = true, champion_id = null, updated_at = now() where id = 1;
  return jsonb_build_object('status', 'reset', 'deleted_scoring_jobs', v_jobs,
    'recovered_orphaned_jobs', v_recovered_jobs, 'queued_replay_cleanup', v_replays,
    'phase', 'entry', 'round', 0, 'day', 0);
end $$;

revoke all on function public.admin_reset_tournament_to_entry(uuid[], bigint[]) from public, anon;
grant execute on function public.admin_reset_tournament_to_entry(uuid[], bigint[]) to authenticated, service_role;
