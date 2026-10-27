-- Let admins clear one contestant's submission history and qualification
-- attempts while the tournament is still in its entry phase.
create or replace function public.admin_clear_contestant_submissions(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_state public.tournament_state;
  v_deleted_jobs int := 0;
  v_deleted_submissions int := 0;
begin
  if not public.is_admin() then
    raise exception 'admin_required' using errcode = '42501';
  end if;

  -- The same lock used by scoring-job creation prevents a new attempt from
  -- appearing between the safety check and deletion.
  select * into v_state from public.tournament_state where id = 1 for update;
  if not found or v_state.phase <> 'entry' then
    raise exception 'entry_phase_required' using errcode = '55000';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id and role = 'contestant') then
    raise exception 'contestant_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.scoring_jobs where user_id = p_user_id
      and status in ('dispatching', 'accepted', 'running')) then
    raise exception 'contestant_jobs_still_running' using errcode = '55000';
  end if;

  insert into public.tournament_reset_cleanup(storage_path)
    select ro.storage_path from public.replay_objects ro
    join public.scoring_jobs sj on sj.id = ro.job_id
    where sj.user_id = p_user_id and sj.kind = 'entry'
    on conflict (storage_path) do nothing;
  insert into public.tournament_reset_source_cleanup(job_id)
    select id from public.scoring_jobs where user_id = p_user_id and kind = 'entry'
    on conflict (job_id) do nothing;

  -- Remove submissions first because their scoring_job_id FK is restrictive.
  delete from public.submissions where user_id = p_user_id;
  get diagnostics v_deleted_submissions = row_count;
  delete from public.scoring_jobs where user_id = p_user_id and kind = 'entry';
  get diagnostics v_deleted_jobs = row_count;

  update public.profiles set entry_score = null,
    status = case when status = 'banned' then status else 'new'::public.user_status end
    where id = p_user_id;

  return jsonb_build_object('deleted_jobs', v_deleted_jobs,
    'deleted_submissions', v_deleted_submissions, 'entry_score', null);
end $$;

revoke all on function public.admin_clear_contestant_submissions(uuid) from public, anon;
grant execute on function public.admin_clear_contestant_submissions(uuid) to authenticated, service_role;
