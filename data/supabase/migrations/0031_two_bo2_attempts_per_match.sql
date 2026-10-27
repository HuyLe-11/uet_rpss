-- Each Swiss pairing accepts two BO2 scoring attempts. Both attempts add to
-- score_a (-4..4); points are assigned from the combined score after attempt 2.
alter table public.matches
  add column if not exists scoring_attempts_completed smallint not null default 0,
  add column if not exists next_submission_at timestamptz,
  add column if not exists scoring_error text;

alter table public.matches drop constraint if exists matches_score_a_check;
alter table public.matches add constraint matches_score_a_check check (score_a between -4 and 4);

alter table public.proxy_match_submissions
  add column if not exists attempt_no smallint not null default 1;
alter table public.proxy_match_submissions
  drop constraint if exists proxy_match_submissions_pkey;
alter table public.proxy_match_submissions
  add constraint proxy_match_submissions_pkey primary key (match_id,user_id,attempt_no);

create or replace function public.proxy_prepare_match(p_match_id bigint,p_source text,p_sha256 text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  m public.matches;
  v_opponent uuid;
  v_opponent_source text;
  v_attempt smallint;
  v_now timestamptz := now();
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode='28000'; end if;
  if p_source is null or octet_length(p_source) not between 1 and 65536
     or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_bot_source' using errcode='22023';
  end if;
  select * into m from public.matches
    where id=p_match_id and auth.uid() in (player_a,player_b) for update;
  if not found or m.state<>'pending' then raise exception 'match_not_available' using errcode='55000'; end if;
  if m.scoring_attempts_completed>=2 then raise exception 'match_attempts_exhausted' using errcode='55000'; end if;
  if m.next_submission_at is not null and v_now<m.next_submission_at then
    return jsonb_build_object('match_id',p_match_id,'ready',false,'cooldown',true,
      'attempt_no',m.scoring_attempts_completed+1,'next_submission_at',m.next_submission_at);
  end if;

  v_attempt := m.scoring_attempts_completed+1;
  v_opponent := case when m.player_a=auth.uid() then m.player_b else m.player_a end;
  if m.submission_deadline is not null and v_now>m.submission_deadline
     and not (
       exists(select 1 from public.proxy_match_submissions s where s.match_id=p_match_id and s.user_id=m.player_a and s.attempt_no=v_attempt and s.submitted_at<=m.submission_deadline)
       and exists(select 1 from public.proxy_match_submissions s where s.match_id=p_match_id and s.user_id=m.player_b and s.attempt_no=v_attempt and s.submitted_at<=m.submission_deadline)
     ) then
    update public.matches set state='forfeit',finished_at=v_now,
      points_a=case when exists(select 1 from public.proxy_match_submissions s where s.match_id=p_match_id and s.user_id=player_a and s.attempt_no=v_attempt and s.submitted_at<=m.submission_deadline) then 1 else -1 end,
      points_b=case when exists(select 1 from public.proxy_match_submissions s where s.match_id=p_match_id and s.user_id=player_b and s.attempt_no=v_attempt and s.submitted_at<=m.submission_deadline) then 1 else -1 end
      where id=p_match_id;
    delete from public.proxy_match_submissions where match_id=p_match_id;
    return jsonb_build_object('match_id',p_match_id,'ready',false,'expired',true,'opponent_id',v_opponent);
  end if;

  insert into public.proxy_match_submissions(match_id,user_id,source,sha256,attempt_no)
    values(p_match_id,auth.uid(),p_source,p_sha256,v_attempt)
    on conflict(match_id,user_id,attempt_no) do nothing;
  if m.submission_deadline is null then
    update public.matches set submission_deadline=v_now+interval '90 seconds' where id=p_match_id;
  end if;
  insert into public.submissions(user_id,rnd,day,submitted_at,sha256,size_bytes)
    values(auth.uid(),m.rnd,m.day,v_now,p_sha256,octet_length(p_source))
    on conflict(user_id,rnd,day) do nothing;
  select source into v_opponent_source from public.proxy_match_submissions
    where match_id=p_match_id and user_id=v_opponent and attempt_no=v_attempt;
  return jsonb_build_object('match_id',p_match_id,'ready',v_opponent_source is not null,
    'opponent_id',v_opponent,'opponent_code',v_opponent_source,'attempt_no',v_attempt);
end $$;
revoke all on function public.proxy_prepare_match(bigint,text,text) from public,anon;
grant execute on function public.proxy_prepare_match(bigint,text,text) to authenticated;

drop function if exists public.proxy_complete_match(bigint,int,uuid);
create function public.proxy_complete_match(p_match_id bigint,p_score_a int,p_scoring_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  m public.matches;
  v_attempt smallint;
  v_total int;
  v_final boolean;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select * into m from public.matches where id=p_match_id for update;
  if not found or m.state<>'pending' then return jsonb_build_object('finalized',false,'reason','match_not_pending'); end if;
  if p_scoring_user_id not in (m.player_a,m.player_b) then raise exception 'invalid_scoring_user' using errcode='42501'; end if;
  if p_score_a not between -2 and 2 then raise exception 'invalid_match_score' using errcode='22023'; end if;
  v_attempt:=m.scoring_attempts_completed+1;
  if not exists(select 1 from public.proxy_match_submissions where match_id=p_match_id and user_id=m.player_a and attempt_no=v_attempt)
     or not exists(select 1 from public.proxy_match_submissions where match_id=p_match_id and user_id=m.player_b and attempt_no=v_attempt) then
    raise exception 'both_bots_required' using errcode='55000';
  end if;
  if p_scoring_user_id<>m.player_a then p_score_a:=-p_score_a; end if;
  v_total:=coalesce(m.score_a,0)+p_score_a;
  v_final:=v_attempt>=2;
  update public.matches set score_a=v_total,scoring_attempts_completed=v_attempt,
    points_a=case when v_final then sign(v_total) else null end,
    points_b=case when v_final then -sign(v_total) else null end,
    state=case when v_final then 'completed' else 'pending' end,
    finished_at=case when v_final then now() else null end,
    submission_deadline=null,
    next_submission_at=case when v_final then null else now()+interval '1 minute' end,
    scoring_error=null where id=p_match_id;
  delete from public.proxy_match_submissions where match_id=p_match_id and attempt_no=v_attempt;
  return jsonb_build_object('finalized',v_final,'attempts_completed',v_attempt,
    'score_total',v_total,'next_submission_at',case when v_final then null else now()+interval '1 minute' end);
end $$;
revoke all on function public.proxy_complete_match(bigint,int,uuid) from public,anon,authenticated;
grant execute on function public.proxy_complete_match(bigint,int,uuid) to service_role;

drop function if exists public.proxy_fail_match(bigint,text,text);
create function public.proxy_fail_match(p_match_id bigint,p_error_code text,p_error_message text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  m public.matches;
  v_attempt smallint;
  v_final boolean;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select * into m from public.matches where id=p_match_id for update;
  if not found or m.state in ('completed','forfeit') then return jsonb_build_object('finalized',true); end if;
  v_attempt:=m.scoring_attempts_completed+1;
  if not exists(select 1 from public.proxy_match_submissions where match_id=p_match_id and user_id=m.player_a and attempt_no=v_attempt)
    or not exists(select 1 from public.proxy_match_submissions where match_id=p_match_id and user_id=m.player_b and attempt_no=v_attempt) then
    raise exception 'both_bots_required' using errcode='55000';
  end if;
  v_final:=v_attempt>=2;
  update public.matches set scoring_attempts_completed=v_attempt,
    points_a=case when v_final then sign(coalesce(score_a,0)) else null end,
    points_b=case when v_final then -sign(coalesce(score_a,0)) else null end,
    state=case when v_final then 'completed' else 'pending' end,
    scoring_error=left(coalesce(p_error_code,'scoring_timeout') || ': ' || coalesce(p_error_message,''),500),
    finished_at=case when v_final then now() else null end,
    submission_deadline=null,
    next_submission_at=case when v_final then null else now()+interval '1 minute' end
    where id=p_match_id;
  delete from public.proxy_match_submissions where match_id=p_match_id and attempt_no=v_attempt;
  return jsonb_build_object('finalized',v_final,'attempts_completed',v_attempt);
end $$;
revoke all on function public.proxy_fail_match(bigint,text,text) from public,anon,authenticated;
grant execute on function public.proxy_fail_match(bigint,text,text) to service_role;

drop function if exists public.get_my_today_matches();
create function public.get_my_today_matches()
returns table(match_id bigint,rnd int,day int,rd int,grp int,opponent text,state text,
  my_submission_state text,opponent_submission_state text,submission_deadline timestamptz,
  my_match_score smallint,my_match_points int,scoring_error text,
  attempts_completed smallint,can_submit boolean)
language sql stable security definer set search_path=public as $$
  select m.id,m.rnd,m.day,m.rd,m.grp,
    case when m.player_a=auth.uid() then pb.username else pa.username end,m.state,
    case when m.state in ('completed','forfeit') then 'resolved'
      when mine.user_id is not null then 'submitted' else 'waiting' end,
    case when m.state in ('completed','forfeit') then 'resolved'
      when theirs.user_id is not null then 'submitted' else 'waiting' end,
    m.submission_deadline,
    case when m.player_a=auth.uid() then m.score_a else -m.score_a end,
    case when m.player_a=auth.uid() then m.points_a else m.points_b end,
    m.scoring_error,m.scoring_attempts_completed,
    m.state='pending' and m.scoring_attempts_completed<2
      and (m.next_submission_at is null or m.next_submission_at<=now())
      and (m.submission_deadline is null or m.submission_deadline>=now())
  from public.matches m
  join public.profiles pa on pa.id=m.player_a
  join public.profiles pb on pb.id=m.player_b
  left join public.proxy_match_submissions mine on mine.match_id=m.id and mine.user_id=auth.uid()
    and mine.attempt_no=m.scoring_attempts_completed+1
  left join public.proxy_match_submissions theirs on theirs.match_id=m.id and theirs.user_id=
    case when m.player_a=auth.uid() then m.player_b else m.player_a end
    and theirs.attempt_no=m.scoring_attempts_completed+1
  join public.tournament_state ts on ts.phase='round' and ts.current_round=m.rnd and ts.current_day=m.day
  where auth.uid() in (m.player_a,m.player_b)
  order by m.rd,m.id;
$$;
revoke all on function public.get_my_today_matches() from public,anon;
grant execute on function public.get_my_today_matches() to authenticated;
