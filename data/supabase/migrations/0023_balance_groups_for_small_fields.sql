-- Keep the configured 40 groups for a full field, while avoiding empty or
-- singleton groups when a small field is used for testing.
create or replace function public.admin_close_qualification()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_qualified int; v_registered int; v_cut numeric; v_groups int;
begin
  if auth.role() <> 'service_role' and not public.is_admin() then
    raise exception 'admin_required' using errcode = '42501';
  end if;
  perform 1 from public.tournament_state where id = 1 for update;
  if (select phase from public.tournament_state where id = 1) <> 'entry' then
    raise exception 'entry_phase_required';
  end if;
  if exists(select 1 from public.scoring_jobs where kind = 'entry'
      and status in ('dispatching', 'accepted', 'running')) then
    raise exception 'entry_jobs_still_running';
  end if;

  select entry_cut, num_groups into v_cut, v_groups
    from public.round_config where rnd = 1;
  if not found then raise exception 'round_one_not_configured'; end if;
  select count(*) into v_registered from public.profiles where role = 'contestant';
  update public.profiles set status = 'out', entry_score = null
    where role = 'contestant' and status <> 'banned';
  update public.profiles p set entry_score = best.score,
    status = case when best.score >= v_cut then 'active'::public.user_status
                  else 'out'::public.user_status end
  from (
    select user_id, max((result ->> 'qualification_score')::numeric) score
    from public.scoring_jobs where kind = 'entry' and status = 'succeeded'
      and result ? 'qualification_score' group by user_id
  ) best where p.id = best.user_id and p.role = 'contestant' and p.status <> 'banned';
  select count(*) into v_qualified from public.profiles
    where role = 'contestant' and status = 'active';
  if v_qualified = 0 then raise exception 'no_qualified_contestants'; end if;

  -- The configured count is the maximum. Scale it down for small test fields
  -- so a handful of qualifiers can still meet in the same group.
  v_groups := least(v_groups, greatest(1, ceil(v_qualified::numeric / 40)::int));
  delete from public.round_members where rnd = 1;
  insert into public.round_members(rnd, user_id, grp, seed)
  with ordered as (
    select id, entry_score,
      row_number() over(order by entry_score desc, id) overall_rank
    from public.profiles where role = 'contestant' and status = 'active'
  ), banded as (
    select *, ceil(overall_rank::numeric / v_groups)::int band from ordered
  ), randomized as (
    select *, row_number() over(partition by band order by md5(id::text || ':round-1')) - 1 group_slot
    from banded
  )
  select 1, id, (group_slot % v_groups)::int, overall_rank::int from randomized;

  insert into public.contest_days(rnd, day, state) values (1, 1, 'open')
    on conflict (rnd, day) do update set state = 'open';
  update public.tournament_state set phase = 'round', current_round = 1,
    current_day = 1, pending_day = 0, accepting_submissions = false, updated_at = now()
    where id = 1;
  return jsonb_build_object('registered', v_registered, 'qualified', v_qualified,
    'groups', v_groups, 'entry_cut', v_cut);
end $$;

revoke all on function public.admin_close_qualification() from public, anon;
grant execute on function public.admin_close_qualification() to authenticated, service_role;
