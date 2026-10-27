-- Record prolonged OnlineCompiler failures separately from contestant
-- forfeits. Both submitted bots receive a neutral draw so the day can finish.
alter table public.matches add column if not exists scoring_error text;

create or replace function public.proxy_fail_match(
  p_match_id bigint,p_error_code text,p_error_message text default null
)
returns boolean language plpgsql security definer set search_path=public as $$
declare m public.matches;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select * into m from public.matches where id=p_match_id for update;
  if not found then raise exception 'match_not_available' using errcode='55000'; end if;
  if m.state in ('completed','forfeit') then return false; end if;
  if not exists(select 1 from public.proxy_match_submissions where match_id=p_match_id and user_id=m.player_a)
     or not exists(select 1 from public.proxy_match_submissions where match_id=p_match_id and user_id=m.player_b) then
    raise exception 'both_bots_required' using errcode='55000';
  end if;
  update public.matches set score_a=0,points_a=0,points_b=0,state='completed',
    scoring_error=left(coalesce(p_error_code,'scoring_timeout') || ': ' || coalesce(p_error_message,''),500),
    finished_at=now() where id=p_match_id;
  delete from public.proxy_match_submissions where match_id=p_match_id;
  return true;
end $$;
revoke all on function public.proxy_fail_match(bigint,text,text) from public,anon,authenticated;
grant execute on function public.proxy_fail_match(bigint,text,text) to service_role;

-- Match results are server-authored only. The service-role Worker identifies
-- whose bot was the runner so SQL can orient its signed score for player_a.
drop function if exists public.proxy_complete_match(bigint,int);
create function public.proxy_complete_match(
  p_match_id bigint,p_score_a int,p_scoring_user_id uuid
)
returns boolean language plpgsql security definer set search_path=public as $$
declare m public.matches;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select * into m from public.matches where id=p_match_id for update;
  if not found or m.state not in ('pending','running') then return false; end if;
  if p_scoring_user_id not in (m.player_a,m.player_b) then raise exception 'invalid_scoring_user' using errcode='42501'; end if;
  if p_score_a not between -2 and 2 then raise exception 'invalid_match_score' using errcode='22023'; end if;
  if not exists(select 1 from public.proxy_match_submissions where match_id=p_match_id and user_id=m.player_a)
    or not exists(select 1 from public.proxy_match_submissions where match_id=p_match_id and user_id=m.player_b) then
    raise exception 'both_bots_required' using errcode='55000';
  end if;
  if p_scoring_user_id<>m.player_a then p_score_a:=-p_score_a; end if;
  update public.matches set score_a=p_score_a,points_a=sign(p_score_a),points_b=-sign(p_score_a),
    state='completed',finished_at=now(),scoring_error=null where id=p_match_id;
  delete from public.proxy_match_submissions where match_id=p_match_id;
  return true;
end $$;
revoke all on function public.proxy_complete_match(bigint,int,uuid) from public,anon,authenticated;
grant execute on function public.proxy_complete_match(bigint,int,uuid) to service_role;

drop function if exists public.get_my_today_matches();
create function public.get_my_today_matches()
returns table(
  match_id bigint,rnd int,day int,rd int,grp int,opponent text,state text,
  my_submission_state text,opponent_submission_state text,submission_deadline timestamptz,
  my_match_score smallint,my_match_points int,scoring_error text
)
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
    m.scoring_error
  from public.matches m
  join public.profiles pa on pa.id=m.player_a
  join public.profiles pb on pb.id=m.player_b
  left join public.proxy_match_submissions mine on mine.match_id=m.id and mine.user_id=auth.uid()
  left join public.proxy_match_submissions theirs on theirs.match_id=m.id and theirs.user_id=
    case when m.player_a=auth.uid() then m.player_b else m.player_a end
  join public.tournament_state ts on ts.phase='round' and ts.current_round=m.rnd and ts.current_day=m.day
  where auth.uid() in (m.player_a,m.player_b)
  order by m.rd,m.id;
$$;
revoke all on function public.get_my_today_matches() from public,anon;
grant execute on function public.get_my_today_matches() to authenticated;
