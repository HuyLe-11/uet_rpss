-- Store one private bot per contestant/day. Pairings use this source to run all
-- of the contestant's matches; only readiness metadata is exposed to players.
alter table public.matches add column if not exists submission_deadline timestamptz;

create table if not exists public.tournament_bot_sources (
  user_id uuid not null,
  rnd int not null,
  day int not null,
  source text not null check (octet_length(source) between 1 and 65536),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  submitted_at timestamptz not null default now(),
  primary key (user_id, rnd, day),
  foreign key (user_id, rnd, day)
    references public.submissions(user_id, rnd, day) on delete cascade
);
alter table public.tournament_bot_sources enable row level security;
revoke all on public.tournament_bot_sources from public, anon, authenticated;
grant select on public.tournament_bot_sources to service_role;

create or replace function public.set_match_submission_deadline()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_first_submission timestamptz;
begin
  select min(s.submitted_at) into v_first_submission
  from public.tournament_bot_sources s
  where s.rnd = new.rnd and s.day = new.day
    and s.user_id in (new.player_a, new.player_b);
  if v_first_submission is not null then
    new.submission_deadline := v_first_submission + interval '60 seconds';
  end if;
  return new;
end $$;

drop trigger if exists matches_set_submission_deadline on public.matches;
create trigger matches_set_submission_deadline
  before insert on public.matches
  for each row execute function public.set_match_submission_deadline();

create or replace function public.submit_tournament_bot(
  p_job_id uuid, p_source text, p_sha256 text, p_size_bytes int
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_existing public.scoring_jobs;
  v_state public.tournament_state;
  v_now timestamptz := now();
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if p_source is null or octet_length(p_source) not between 1 and 65536
     or p_size_bytes is null
     or p_size_bytes <> octet_length(p_source)
     or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_bot_source' using errcode = '22023';
  end if;

  select * into v_existing from public.scoring_jobs where id = p_job_id and user_id = auth.uid();
  if found then
    if v_existing.kind = 'submission' and v_existing.status = 'succeeded'
       and v_existing.sha256 = p_sha256 and v_existing.size_bytes = p_size_bytes
       and exists(select 1 from public.tournament_bot_sources s
         where s.user_id = auth.uid() and s.rnd = v_existing.rnd
           and s.day = v_existing.day and s.sha256 = p_sha256) then
      return jsonb_build_object('submitted', true, 'submitted_at',
        (select s.submitted_at from public.tournament_bot_sources s
         where s.user_id = auth.uid() and s.rnd = v_existing.rnd and s.day = v_existing.day),
        'opponent_deadline_seconds', 60);
    end if;
    raise exception 'submission_job_id_conflict' using errcode = '23505';
  end if;

  select * into v_state from public.tournament_state where id = 1 for share;
  if not found or v_state.phase <> 'round' or not v_state.accepting_submissions then
    raise exception 'submissions_closed' using errcode = '55000';
  end if;
  if not exists(select 1 from public.profiles p where p.id = auth.uid()
      and p.status not in ('banned', 'out'))
     or not exists(select 1 from public.round_members rm
      where rm.rnd = v_state.current_round and rm.user_id = auth.uid()) then
    raise exception 'submission_not_allowed' using errcode = '42501';
  end if;

  insert into public.scoring_jobs(id, user_id, kind, rnd, day, status, sha256, size_bytes,
      result, accepted_at, started_at, finished_at, updated_at)
    values (p_job_id, auth.uid(), 'submission', v_state.current_round, v_state.current_day,
      'succeeded', p_sha256, p_size_bytes, jsonb_build_object('ok', true, 'submitted', true),
      v_now, v_now, v_now, v_now);
  insert into public.submissions(user_id, rnd, day, submitted_at, sha256, size_bytes, scoring_job_id)
    values (auth.uid(), v_state.current_round, v_state.current_day, v_now, p_sha256, p_size_bytes, p_job_id);
  insert into public.tournament_bot_sources(user_id, rnd, day, source, sha256, submitted_at)
    values (auth.uid(), v_state.current_round, v_state.current_day, p_source, p_sha256, v_now);

  -- Start a per-match response window from the first contestant who submits.
  update public.matches m set submission_deadline = v_now + interval '60 seconds'
    where m.rnd = v_state.current_round and m.day = v_state.current_day and m.state = 'pending'
      and m.submission_deadline is null
      and auth.uid() in (m.player_a, m.player_b);

  return jsonb_build_object('submitted', true, 'submitted_at', v_now,
    'opponent_deadline_seconds', 60);
end $$;

revoke all on function public.submit_tournament_bot(uuid, text, text, int) from public, anon;
grant execute on function public.submit_tournament_bot(uuid, text, text, int) to authenticated;

-- Recreate the status RPC with private readiness metadata for only the caller's
-- matches. The UI polls this function every five seconds.
drop function if exists public.get_my_today_matches();
create function public.get_my_today_matches()
returns table(
  match_id bigint, rnd int, day int, rd int, grp int, opponent text, state text,
  my_submission_state text, opponent_submission_state text, submission_deadline timestamptz
)
language sql stable security definer set search_path = public as $$
  select m.id, m.rnd, m.day, m.rd, m.grp,
    case when m.player_a = auth.uid() then pb.username else pa.username end,
    m.state,
    case
      when mine.user_id is not null and m.submission_deadline is not null
        and mine.submitted_at > m.submission_deadline then 'late'
      when mine.user_id is not null then 'submitted'
      when exists(select 1 from public.scoring_jobs j where j.user_id = auth.uid()
        and j.kind = 'submission' and j.rnd = m.rnd and j.day = m.day
        and j.status in ('dispatching', 'accepted', 'running')) then 'submitting'
      else 'waiting'
    end,
    case
      when theirs.user_id is not null and m.submission_deadline is not null
        and theirs.submitted_at > m.submission_deadline then 'late'
      when theirs.user_id is not null then 'submitted'
      when exists(select 1 from public.scoring_jobs j where j.user_id =
        case when m.player_a = auth.uid() then m.player_b else m.player_a end
        and j.kind = 'submission' and j.rnd = m.rnd and j.day = m.day
        and j.status in ('dispatching', 'accepted', 'running')) then 'submitting'
      else 'waiting'
    end,
    m.submission_deadline
  from public.matches m
  join public.profiles pa on pa.id = m.player_a
  join public.profiles pb on pb.id = m.player_b
  left join public.tournament_bot_sources mine on mine.user_id = auth.uid()
    and mine.rnd = m.rnd and mine.day = m.day
  left join public.tournament_bot_sources theirs on theirs.user_id =
    case when m.player_a = auth.uid() then m.player_b else m.player_a end
    and theirs.rnd = m.rnd and theirs.day = m.day
  join public.tournament_state ts on ts.phase = 'round'
    and ts.current_round = m.rnd and ts.current_day = m.day
  where auth.uid() in (m.player_a, m.player_b)
  order by m.rd, m.id;
$$;
revoke all on function public.get_my_today_matches() from public, anon;
grant execute on function public.get_my_today_matches() to authenticated;

-- Only a timely stored submission can win a match whose opponent missed the
-- response deadline. Closing a day also resolves submissions that never came.
create or replace function public.record_tournament_match(
  p_match_id bigint, p_score_a int, p_a_ready boolean, p_b_ready boolean
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  m public.matches;
  v_day_state public.day_state;
  v_ready_a boolean;
  v_ready_b boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select * into m from public.matches where id = p_match_id for update;
  if not found or m.state not in ('pending', 'running') then return false; end if;
  select state into v_day_state from public.contest_days where rnd = m.rnd and day = m.day;
  if v_day_state is null then raise exception 'day_not_open' using errcode = '55000'; end if;

  select exists(select 1 from public.tournament_bot_sources s
      where s.user_id = m.player_a and s.rnd = m.rnd and s.day = m.day
        and (m.submission_deadline is null or s.submitted_at <= m.submission_deadline)),
    exists(select 1 from public.tournament_bot_sources s
      where s.user_id = m.player_b and s.rnd = m.rnd and s.day = m.day
        and (m.submission_deadline is null or s.submitted_at <= m.submission_deadline))
    into v_ready_a, v_ready_b;

  if p_a_ready is distinct from v_ready_a or p_b_ready is distinct from v_ready_b then
    raise exception 'match_submission_state_changed' using errcode = '40001';
  end if;
  if v_ready_a and v_ready_b then
    if p_score_a is null or p_score_a not between -2 and 2 then
      raise exception 'invalid_match_score' using errcode = '22023';
    end if;
    update public.matches set score_a = p_score_a,
      points_a = sign(p_score_a), points_b = -sign(p_score_a),
      state = 'completed', finished_at = now() where id = p_match_id;
  else
    if v_day_state <> 'grading' and (m.submission_deadline is null
       or now() < m.submission_deadline or not (v_ready_a or v_ready_b)) then
      raise exception 'opponent_submission_window_open' using errcode = '55000';
    end if;
    update public.matches set score_a = 0,
      points_a = case when v_ready_a then 1 else -1 end,
      points_b = case when v_ready_b then 1 else -1 end,
      state = 'forfeit', finished_at = now() where id = p_match_id;
  end if;
  return true;
end $$;
revoke all on function public.record_tournament_match(bigint, int, boolean, boolean) from public, anon, authenticated;
grant execute on function public.record_tournament_match(bigint, int, boolean, boolean) to service_role;
