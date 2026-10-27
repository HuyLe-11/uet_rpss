-- Store the proxy match result directly and update qualification status.
create or replace function public.complete_proxy_scoring_job(
  p_job_id uuid, p_result jsonb
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_job public.scoring_jobs;
begin
  select * into v_job from public.scoring_jobs
    where id = p_job_id and user_id = auth.uid() for update;
  if not found or v_job.status not in ('dispatching', 'accepted', 'running') then
    return false;
  end if;
  if p_result->>'match_score' is null
     or (p_result->>'match_score')::int not between -2 and 2 then
    raise exception 'invalid_proxy_result' using errcode = '22023';
  end if;

  update public.scoring_jobs
    set status = 'succeeded', result = p_result, finished_at = now(), updated_at = now(),
        error_code = null, error_message = null
    where id = p_job_id;

  if v_job.kind = 'entry' then
    update public.profiles
      set entry_score = greatest(coalesce(entry_score, (p_result->>'match_score')::numeric),
                                (p_result->>'match_score')::numeric),
          status = case when coalesce((p_result->>'passed')::boolean, false)
                        then 'active'::public.user_status
                        else status end
      where id = v_job.user_id and status in ('new', 'active');
  elsif v_job.kind = 'submission' then
    insert into public.submissions(user_id, rnd, day, submitted_at, sha256, size_bytes, scoring_job_id)
      values (v_job.user_id, v_job.rnd, v_job.day, now(), v_job.sha256, v_job.size_bytes, v_job.id)
      on conflict (user_id, rnd, day) do update set submitted_at = excluded.submitted_at,
        sha256 = excluded.sha256, size_bytes = excluded.size_bytes, scoring_job_id = excluded.scoring_job_id;
  end if;
  return true;
end $$;

revoke all on function public.complete_proxy_scoring_job(uuid, jsonb) from public, anon;
grant execute on function public.complete_proxy_scoring_job(uuid, jsonb) to authenticated;
