-- Replace the ambiguous ON CONFLICT column inference in the already-installed
-- prepare_swiss_round body. RETURNS TABLE exposes player_a/player_b as output
-- variables, so PostgreSQL can resolve those names as either variables or
-- matches columns. Target the generated unique constraint explicitly.
do $$
declare
  v_definition text;
  v_original text := 'on conflict (rnd, day, rd, player_a, player_b)';
  v_fixed text := 'on conflict on constraint matches_rnd_day_rd_player_a_player_b_key';
begin
  v_definition := pg_get_functiondef('public.prepare_swiss_round(integer,integer,integer)'::regprocedure);
  if position(v_original in v_definition) > 0 then
    v_definition := replace(v_definition, v_original, v_fixed);
    execute v_definition;
  elsif position(v_fixed in v_definition) = 0 then
    raise exception 'prepare_swiss_round_conflict_clause_not_found';
  end if;
end $$;
