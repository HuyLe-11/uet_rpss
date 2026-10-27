create or replace function public.get_my_today_matches()
returns table(match_id bigint,rnd int,day int,rd int,grp int,opponent text,state text)
language sql stable security definer set search_path=public as $$
  select m.id,m.rnd,m.day,m.rd,m.grp,
    case when m.player_a=auth.uid() then pb.username else pa.username end opponent,
    m.state
  from public.matches m
  join public.profiles pa on pa.id=m.player_a
  join public.profiles pb on pb.id=m.player_b
  join public.tournament_state ts on ts.current_round=m.rnd
    and ts.current_day=m.day and ts.phase='round'
  where m.player_a=auth.uid() or m.player_b=auth.uid()
  order by m.rd;
$$;
grant execute on function public.get_my_today_matches() to authenticated;
