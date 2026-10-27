-- Browser-facing Cloudflare scoring state. Bot source is retained only until
-- the official match is completed, then removed by the completion RPC.
create table if not exists public.proxy_match_submissions (
  match_id bigint not null references public.matches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  source text not null check (octet_length(source) between 1 and 65536),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  submitted_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

alter table public.proxy_match_submissions enable row level security;
revoke all on public.proxy_match_submissions from anon, authenticated;

create or replace function public.proxy_prepare_match(
  p_match_id bigint,
  p_source text,
  p_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_match public.matches;
  v_opponent uuid;
  v_opponent_source text;
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if p_source is null or octet_length(p_source) not between 1 and 65536
     or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_bot_source' using errcode = '22023';
  end if;

  select * into v_match from public.matches
   where id = p_match_id and (player_a = auth.uid() or player_b = auth.uid())
   for update;
  if not found or v_match.state not in ('pending', 'running') then
    raise exception 'match_not_available' using errcode = '55000';
  end if;

  insert into public.proxy_match_submissions(match_id, user_id, source, sha256)
  values (p_match_id, auth.uid(), p_source, p_sha256)
  on conflict (match_id, user_id) do nothing;

  v_opponent := case when v_match.player_a = auth.uid() then v_match.player_b else v_match.player_a end;
  select source into v_opponent_source from public.proxy_match_submissions
   where match_id = p_match_id and user_id = v_opponent;

  return jsonb_build_object(
    'match_id', p_match_id,
    'ready', v_opponent_source is not null,
    'opponent_code', v_opponent_source
  );
end $$;

create or replace function public.proxy_complete_match(
  p_match_id bigint,
  p_score_a int
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_match public.matches;
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  select * into v_match from public.matches
   where id = p_match_id and (player_a = auth.uid() or player_b = auth.uid())
   for update;
  if not found or v_match.state not in ('pending', 'running') then return false; end if;
  if p_score_a not between -2 and 2 then raise exception 'invalid_match_score' using errcode = '22023'; end if;
  if not exists (select 1 from public.proxy_match_submissions where match_id = p_match_id and user_id = v_match.player_a)
     or not exists (select 1 from public.proxy_match_submissions where match_id = p_match_id and user_id = v_match.player_b) then
    raise exception 'both_bots_required' using errcode = '55000';
  end if;
  p_score_a := case when v_match.player_a = auth.uid() then p_score_a else -p_score_a end;
  update public.matches
     set score_a = p_score_a, points_a = sign(p_score_a), points_b = -sign(p_score_a),
         state = 'completed', finished_at = now()
   where id = p_match_id;
  delete from public.proxy_match_submissions where match_id = p_match_id;
  return true;
end $$;

grant execute on function public.proxy_prepare_match(bigint, text, text) to authenticated;
grant execute on function public.proxy_complete_match(bigint, int) to authenticated;
