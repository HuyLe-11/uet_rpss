-- Extend the opponent response window to 90 seconds. Keep the source function
-- update idempotent so this can follow the already-applied 0026/0027 migrations.
do $$
declare
  v_definition text;
  v_old text := 'interval ''60 seconds''';
  v_new text := 'interval ''90 seconds''';
begin
  v_definition := pg_get_functiondef('public.proxy_prepare_match(bigint,text,text)'::regprocedure);
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  elsif position(v_new in v_definition) = 0 then
    raise exception 'proxy_match_timeout_interval_not_found';
  end if;
end $$;

-- If deployed while a match is already waiting, extend its still-open deadline
-- from the first submission timestamp. Closed/expired matches are untouched.
with first_submissions as (
  select match_id, min(submitted_at) first_submitted_at
  from public.proxy_match_submissions group by match_id
)
update public.matches m
set submission_deadline = f.first_submitted_at + interval '90 seconds'
from first_submissions f
where m.id = f.match_id and m.state = 'pending'
  and m.submission_deadline > now()
  and (select count(*) from public.proxy_match_submissions s where s.match_id=m.id) = 1;

drop function if exists public.get_my_today_matches();
create function public.get_my_today_matches()
returns table(
  match_id bigint,rnd int,day int,rd int,grp int,opponent text,state text,
  my_submission_state text,opponent_submission_state text,submission_deadline timestamptz,
  my_match_score smallint,my_match_points int
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
    case when m.player_a=auth.uid() then m.points_a else m.points_b end
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
