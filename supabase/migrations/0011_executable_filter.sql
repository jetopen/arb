-- 0011: "executable only" filter for the spread screener (requires 0010's simulation column).
-- Adds p_executable_only to the per-token read RPC: when true, keep only rows whose tx simulation
-- verdict is executable (simulation.executable === true). Mirrors the p_tier_usd add in 0009.

-- Adding a parameter changes the signature; drop the 7-arg version first so a call to the new function
-- can't match two overloads ("function is not unique").
drop function if exists public.arb_top_opportunities_by_token(
  double precision, int, int, boolean, timestamptz, int, int
);

create or replace function public.arb_top_opportunities_by_token(
  p_min_spread_pct double precision default null,
  p_chain_id       int              default null,
  p_tier_usd       int              default null,
  p_verified_only  boolean          default false,
  p_executable_only boolean         default false,
  p_computed_after timestamptz      default null,
  p_limit          int              default 50,
  p_offset         int              default 0
)
returns jsonb
language sql
stable
as $$
  with filtered as (
    select o.*
      from public.arb_opportunities o
     where (p_min_spread_pct is null or o.gross_spread_pct >= p_min_spread_pct)
       and (p_chain_id is null or o.buy_chain_id = p_chain_id or o.sell_chain_id = p_chain_id)
       and (p_tier_usd is null or o.tier_usd = p_tier_usd)
       and (not p_verified_only or o.verified = true)
       -- executable === true (sim ran AND every simulatable leg passed AND the claim is honorable).
       and (not p_executable_only or (o.simulation ->> 'executable') = 'true')
       and (p_computed_after is null or o.computed_at >= p_computed_after)
  ),
  best as (
    select distinct on (f.debridge_id) f.*
      from filtered f
     order by f.debridge_id, f.gross_spread_pct desc, f.id
  ),
  page as (
    select b.*
      from best b
     order by b.gross_spread_pct desc, b.id
     offset greatest(p_offset, 0)
     limit  greatest(p_limit, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from best),
    'rows',  coalesce(
               (select jsonb_agg(to_jsonb(page.*) order by page.gross_spread_pct desc, page.id) from page),
               '[]'::jsonb
             )
  );
$$;

-- create or replace resets grants; re-revoke. New signature inserts a boolean (p_executable_only) after
-- p_verified_only.
revoke execute on function public.arb_top_opportunities_by_token(
  double precision, int, int, boolean, boolean, timestamptz, int, int
) from anon, authenticated, public;
