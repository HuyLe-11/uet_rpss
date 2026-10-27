-- The Cloudflare Worker owns official match execution. Create the first
-- pairing when qualification closes and expose per-match proxy readiness.
-- Use the named unique constraint in ON CONFLICT: RETURNS TABLE also declares
-- output variables named player_a/player_b, which makes column inference
-- ambiguous inside PL/pgSQL on some deployed PostgreSQL versions.
create or replace function public.prepare_swiss_round(p_rnd int,p_day int,p_rd int)
returns table(match_id bigint,grp int,player_a uuid,player_b uuid,
  job_a uuid,job_b uuid,match_state text)
language plpgsql security definer set search_path=public as $$
declare
  v_state public.tournament_state;
  g record; v_order uuid[]; v_n int; v_half int;
  v_a uuid; v_b uuid; v_i int; v_j int;
begin
  if auth.role()<>'service_role' and not public.is_admin() then
    raise exception 'admin_required' using errcode='42501';
  end if;
  select * into v_state from public.tournament_state where id=1 for share;
  if not found or v_state.phase<>'round' or v_state.current_round<>p_rnd or v_state.current_day<>p_day then
    raise exception 'round_context_stale' using errcode='55000';
  end if;
  if p_rd<1 or p_rd>7 then raise exception 'invalid_match_round'; end if;
  if not exists(select 1 from public.contest_days where rnd=p_rnd and day=p_day and state in ('open','grading')) then
    raise exception 'day_not_open';
  end if;
  if p_rd>1 and exists(select 1 from public.matches where rnd=p_rnd and day=p_day and rd=p_rd-1
      and state not in ('completed','forfeit')) then raise exception 'previous_match_round_pending'; end if;

  for g in select distinct rm.grp from public.round_members rm where rm.rnd=p_rnd order by rm.grp loop
    if p_rd=1 then
      select array_agg(q.user_id order by q.avg_rank,q.seed,q.user_id) into v_order from (
        select rm.user_id,rm.seed,
          coalesce((select avg(dr.rank) from public.daily_results dr where dr.rnd=rm.rnd
            and dr.user_id=rm.user_id and dr.day<p_day),0) avg_rank
        from public.round_members rm join public.profiles p on p.id=rm.user_id and p.status<>'banned'
        where rm.rnd=p_rnd and rm.grp=g.grp
          and (p_day<>7 or (select count(*) from public.submissions s where s.user_id=rm.user_id
            and s.rnd=p_rnd and s.day between 1 and 6)>=4)
      ) q;
    else
      select array_agg(q.user_id order by q.points desc,q.avg_rank,q.seed,q.user_id) into v_order from (
        select rm.user_id,rm.seed,
          coalesce((select avg(dr.rank) from public.daily_results dr where dr.rnd=rm.rnd
            and dr.user_id=rm.user_id and dr.day<p_day),0) avg_rank,
          coalesce((select sum(case when m.player_a=rm.user_id then m.points_a else m.points_b end)
            from public.matches m where m.rnd=p_rnd and m.day=p_day and m.rd<p_rd
              and m.state in ('completed','forfeit') and (m.player_a=rm.user_id or m.player_b=rm.user_id)),0) points
        from public.round_members rm join public.profiles p on p.id=rm.user_id and p.status<>'banned'
        where rm.rnd=p_rnd and rm.grp=g.grp
          and (p_day<>7 or (select count(*) from public.submissions s where s.user_id=rm.user_id
            and s.rnd=p_rnd and s.day between 1 and 6)>=4)
      ) q;
    end if;
    v_n:=coalesce(array_length(v_order,1),0);
    if v_n=0 then continue; end if;
    if v_n%2=1 then
      v_a:=null;
      for v_i in reverse v_n..1 loop
        if not exists(select 1 from public.round_byes b where b.rnd=p_rnd and b.grp=g.grp and b.user_id=v_order[v_i]) then
          v_a:=v_order[v_i]; exit;
        end if;
      end loop;
      if v_a is null then v_a:=v_order[v_n]; end if;
      insert into public.round_byes(rnd,day,rd,grp,user_id) values(p_rnd,p_day,p_rd,g.grp,v_a) on conflict do nothing;
      v_order:=array_remove(v_order,v_a);
      v_n:=coalesce(array_length(v_order,1),0);
      if v_n=0 then continue; end if;
    end if;
    v_half:=v_n/2;
    if p_rd=1 then
      for v_i in 1..v_half loop
        v_a:=v_order[v_i]; v_b:=v_order[v_i+v_half];
        insert into public.matches(rnd,day,rd,grp,player_a,player_b,state)
          values(p_rnd,p_day,p_rd,g.grp,v_a,v_b,'pending')
          on conflict on constraint matches_rnd_day_rd_player_a_player_b_key do nothing;
      end loop;
    else
      while coalesce(array_length(v_order,1),0)>=2 loop
        v_a:=v_order[1]; v_b:=null;
        for v_j in 2..array_length(v_order,1) loop
          if not exists(select 1 from public.matches old where old.rnd=p_rnd and old.grp=g.grp and old.day=p_day
            and ((old.player_a=v_a and old.player_b=v_order[v_j]) or (old.player_a=v_order[v_j] and old.player_b=v_a))) then
            v_b:=v_order[v_j]; exit;
          end if;
        end loop;
        if v_b is null then v_b:=v_order[2]; end if;
        insert into public.matches(rnd,day,rd,grp,player_a,player_b,state)
          values(p_rnd,p_day,p_rd,g.grp,v_a,v_b,'pending')
          on conflict on constraint matches_rnd_day_rd_player_a_player_b_key do nothing;
        v_order:=array_remove(array_remove(v_order,v_a),v_b);
      end loop;
    end if;
  end loop;
  return query select m.id,m.grp,m.player_a,m.player_b,sa.scoring_job_id,sb.scoring_job_id,m.state
    from public.matches m
    left join public.submissions sa on sa.user_id=m.player_a and sa.rnd=m.rnd and sa.day=m.day
    left join public.submissions sb on sb.user_id=m.player_b and sb.rnd=m.rnd and sb.day=m.day
    where m.rnd=p_rnd and m.day=p_day and m.rd=p_rd order by m.grp,m.id;
end $$;
revoke all on function public.prepare_swiss_round(int,int,int) from public,anon;
grant execute on function public.prepare_swiss_round(int,int,int) to authenticated,service_role;

create or replace function public.admin_close_qualification()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_qualified int; v_registered int; v_cut numeric; v_groups int;
begin
  if auth.role() <> 'service_role' and not public.is_admin() then
    raise exception 'admin_required' using errcode = '42501';
  end if;
  perform 1 from public.tournament_state where id = 1 for update;
  if (select phase from public.tournament_state where id = 1) <> 'entry' then raise exception 'entry_phase_required'; end if;
  if exists(select 1 from public.scoring_jobs where kind = 'entry' and status in ('dispatching','accepted','running')) then
    raise exception 'entry_jobs_still_running';
  end if;
  select entry_cut, num_groups into v_cut, v_groups from public.round_config where rnd = 1;
  if not found then raise exception 'round_one_not_configured'; end if;
  select count(*) into v_registered from public.profiles where role = 'contestant';
  update public.profiles set status = 'out', entry_score = null where role = 'contestant' and status <> 'banned';
  update public.profiles p set entry_score = best.score,
    status = case when best.score >= v_cut then 'active'::public.user_status else 'out'::public.user_status end
  from (select user_id, max((result ->> 'qualification_score')::numeric) score
        from public.scoring_jobs where kind = 'entry' and status = 'succeeded'
          and result ? 'qualification_score' group by user_id) best
  where p.id = best.user_id and p.role = 'contestant' and p.status <> 'banned';
  select count(*) into v_qualified from public.profiles where role = 'contestant' and status = 'active';
  if v_qualified = 0 then raise exception 'no_qualified_contestants'; end if;
  v_groups := least(v_groups, greatest(1, ceil(v_qualified::numeric / 40)::int));
  delete from public.round_members where rnd = 1;
  insert into public.round_members(rnd,user_id,grp,seed)
  with ordered as (
    select id, entry_score, row_number() over(order by entry_score desc,id) overall_rank
    from public.profiles where role = 'contestant' and status = 'active'
  ), banded as (select *, ceil(overall_rank::numeric / v_groups)::int band from ordered),
  randomized as (
    select *, row_number() over(partition by band order by md5(id::text || ':round-1')) - 1 group_slot from banded
  ) select 1,id,(group_slot % v_groups)::int,overall_rank::int from randomized;
  insert into public.contest_days(rnd,day,state) values(1,1,'open')
    on conflict(rnd,day) do update set state='open';
  update public.tournament_state set phase='round',current_round=1,current_day=1,pending_day=0,
    accepting_submissions=true,updated_at=now() where id=1;
  -- Without this call the UI has no match_id to pass to proxy_prepare_match.
  perform * from public.prepare_swiss_round(1,1,1);
  return jsonb_build_object('registered',v_registered,'qualified',v_qualified,'groups',v_groups,'entry_cut',v_cut);
end $$;
revoke all on function public.admin_close_qualification() from public,anon;
grant execute on function public.admin_close_qualification() to authenticated,service_role;

create or replace function public.admin_open_tournament_day(p_rnd int,p_day int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_state public.tournament_state; v_config public.round_config;
begin
  if auth.role()<>'service_role' and not public.is_admin() then raise exception 'admin_required' using errcode='42501'; end if;
  select * into v_state from public.tournament_state where id=1 for update;
  select * into v_config from public.round_config where rnd=p_rnd;
  if not found or v_config.is_offline then raise exception 'online_round_not_configured'; end if;
  if v_state.phase<>'round' or v_state.current_round<>p_rnd then raise exception 'round_context_stale'; end if;
  if p_day<1 or p_day>v_config.days then raise exception 'invalid_day'; end if;
  if p_day>1 and not exists(select 1 from public.contest_days where rnd=p_rnd and day=p_day-1 and state='graded') then
    raise exception 'previous_day_not_graded';
  end if;
  insert into public.contest_days(rnd,day,state) values(p_rnd,p_day,'open')
    on conflict(rnd,day) do update set state='open';
  update public.tournament_state set current_day=p_day,pending_day=0,accepting_submissions=true,updated_at=now() where id=1;
  perform * from public.prepare_swiss_round(p_rnd,p_day,1);
  return true;
end $$;
revoke all on function public.admin_open_tournament_day(int,int) from public,anon;
grant execute on function public.admin_open_tournament_day(int,int) to authenticated,service_role;

-- Migration 0025 installed a trigger tied to the obsolete per-day source table.
-- Official sources are now per-match in proxy_match_submissions.
drop trigger if exists matches_set_submission_deadline on public.matches;
drop function if exists public.set_match_submission_deadline();

create or replace function public.proxy_prepare_match(p_match_id bigint,p_source text,p_sha256 text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_match public.matches; v_opponent uuid; v_opponent_source text; v_opponent_at timestamptz;
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode='28000'; end if;
  if p_source is null or octet_length(p_source) not between 1 and 65536
    or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'invalid_bot_source' using errcode='22023'; end if;
  select * into v_match from public.matches where id=p_match_id and auth.uid() in (player_a,player_b) for update;
  if not found or v_match.state not in ('pending','running') then raise exception 'match_not_available' using errcode='55000'; end if;
  v_opponent := case when v_match.player_a=auth.uid() then v_match.player_b else v_match.player_a end;
  select source,submitted_at into v_opponent_source,v_opponent_at from public.proxy_match_submissions
    where match_id=p_match_id and user_id=v_opponent;
  if v_match.submission_deadline is not null and now()>v_match.submission_deadline
     and (v_opponent_at is null or v_opponent_at>v_match.submission_deadline) then
    update public.matches set state='forfeit',finished_at=now(),
      points_a=case when exists(select 1 from public.proxy_match_submissions s where s.match_id=p_match_id and s.user_id=player_a and s.submitted_at<=v_match.submission_deadline) then 1 else -1 end,
      points_b=case when exists(select 1 from public.proxy_match_submissions s where s.match_id=p_match_id and s.user_id=player_b and s.submitted_at<=v_match.submission_deadline) then 1 else -1 end
      where id=p_match_id;
    return jsonb_build_object('match_id',p_match_id,'ready',false,'expired',true,'opponent_id',v_opponent);
  end if;
  insert into public.proxy_match_submissions(match_id,user_id,source,sha256)
    values(p_match_id,auth.uid(),p_source,p_sha256) on conflict(match_id,user_id) do nothing;
  -- Daily participation is used by the last-day eligibility rule and rankings.
  insert into public.submissions(user_id,rnd,day,submitted_at,sha256,size_bytes)
    values(auth.uid(),v_match.rnd,v_match.day,now(),p_sha256,octet_length(p_source))
    on conflict(user_id,rnd,day) do nothing;
  if v_match.submission_deadline is null then
    update public.matches set submission_deadline=now()+interval '60 seconds' where id=p_match_id;
  end if;
  select source into v_opponent_source from public.proxy_match_submissions where match_id=p_match_id and user_id=v_opponent;
  return jsonb_build_object('match_id',p_match_id,'ready',v_opponent_source is not null,
    'opponent_id',v_opponent,'opponent_code',v_opponent_source);
end $$;
revoke all on function public.proxy_prepare_match(bigint,text,text) from public,anon;
grant execute on function public.proxy_prepare_match(bigint,text,text) to authenticated;

create or replace function public.proxy_resolve_match_timeout(p_match_id bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare m public.matches; a_ready boolean; b_ready boolean;
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode='28000'; end if;
  select * into m from public.matches where id=p_match_id and auth.uid() in (player_a,player_b) for update;
  if not found then raise exception 'match_not_available' using errcode='55000'; end if;
  if m.state in ('completed','forfeit') then return jsonb_build_object('resolved',true,'state',m.state); end if;
  if m.submission_deadline is null or now()<=m.submission_deadline then
    return jsonb_build_object('resolved',false,'state',m.state);
  end if;
  select exists(select 1 from public.proxy_match_submissions where match_id=p_match_id and user_id=m.player_a and submitted_at<=m.submission_deadline),
         exists(select 1 from public.proxy_match_submissions where match_id=p_match_id and user_id=m.player_b and submitted_at<=m.submission_deadline)
    into a_ready,b_ready;
  if a_ready and b_ready then return jsonb_build_object('resolved',false,'state',m.state); end if;
  update public.matches set state='forfeit',finished_at=now(),points_a=case when a_ready then 1 else -1 end,
    points_b=case when b_ready then 1 else -1 end where id=p_match_id;
  return jsonb_build_object('resolved',true,'state','forfeit','player_a_submitted',a_ready,'player_b_submitted',b_ready);
end $$;
revoke all on function public.proxy_resolve_match_timeout(bigint) from public,anon;
grant execute on function public.proxy_resolve_match_timeout(bigint) to authenticated;

drop function if exists public.get_my_today_matches();
create function public.get_my_today_matches()
returns table(match_id bigint,rnd int,day int,rd int,grp int,opponent text,state text,
  my_submission_state text,opponent_submission_state text,submission_deadline timestamptz)
language sql stable security definer set search_path=public as $$
  select m.id,m.rnd,m.day,m.rd,m.grp,
    case when m.player_a=auth.uid() then pb.username else pa.username end,m.state,
    case when m.state in ('completed','forfeit') then 'resolved'
      when mine.user_id is not null then 'submitted' else 'waiting' end,
    case when m.state in ('completed','forfeit') then 'resolved'
      when theirs.user_id is not null then 'submitted' else 'waiting' end,m.submission_deadline
  from public.matches m join public.profiles pa on pa.id=m.player_a join public.profiles pb on pb.id=m.player_b
  left join public.proxy_match_submissions mine on mine.match_id=m.id and mine.user_id=auth.uid()
  left join public.proxy_match_submissions theirs on theirs.match_id=m.id and theirs.user_id=
    case when m.player_a=auth.uid() then m.player_b else m.player_a end
  join public.tournament_state ts on ts.phase='round' and ts.current_round=m.rnd and ts.current_day=m.day
  where auth.uid() in (m.player_a,m.player_b) order by m.rd,m.id;
$$;
revoke all on function public.get_my_today_matches() from public,anon;
grant execute on function public.get_my_today_matches() to authenticated;
