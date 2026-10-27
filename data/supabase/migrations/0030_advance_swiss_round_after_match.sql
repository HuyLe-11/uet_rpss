-- A finished pair waits one minute before the next Swiss round is paired.
-- The Worker calls this only; it never computes pairings itself.
create or replace function public.proxy_advance_match_round(p_match_id bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  m public.matches;
  v_last_finished timestamptz;
  v_day_state public.day_state;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select * into m from public.matches where id=p_match_id;
  if not found then raise exception 'match_not_available' using errcode='55000'; end if;
  if m.state not in ('completed','forfeit') then
    return jsonb_build_object('advanced',false,'reason','match_not_finished');
  end if;
  if m.rd>=7 then return jsonb_build_object('advanced',false,'reason','last_round'); end if;
  select state into v_day_state from public.contest_days where rnd=m.rnd and day=m.day;
  if v_day_state<>'open' then return jsonb_build_object('advanced',false,'reason','day_not_open'); end if;
  if exists(select 1 from public.matches x where x.rnd=m.rnd and x.day=m.day and x.rd=m.rd
      and x.state not in ('completed','forfeit')) then
    return jsonb_build_object('advanced',false,'reason','round_matches_pending');
  end if;
  select max(finished_at) into v_last_finished from public.matches
    where rnd=m.rnd and day=m.day and rd=m.rd;
  if v_last_finished is null or now()<v_last_finished+interval '1 minute' then
    return jsonb_build_object('advanced',false,'reason','round_cooldown');
  end if;
  perform * from public.prepare_swiss_round(m.rnd,m.day,m.rd+1);
  return jsonb_build_object('advanced',true,'round',m.rd+1);
end $$;
revoke all on function public.proxy_advance_match_round(bigint) from public,anon,authenticated;
grant execute on function public.proxy_advance_match_round(bigint) to service_role;
