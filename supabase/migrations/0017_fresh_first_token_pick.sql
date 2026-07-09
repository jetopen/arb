-- 0017: fresh-first per-token pick for the spread screener. Since the dashboard fetches ALL-TIME rows
-- (maxAgeMs=0, staleness shown per-row instead of hidden), the pure max-gross `distinct on` let a STALE
-- row with marginally better gross shadow a FRESHER row of the same token (live-proven: PING's Jun-24
-- row at -99.99999% beat its Jul-8 row at -100%). New trailing param p_fresh_after:
--   - rows at/after it (fresh) outrank ALL older rows and compete on gross among themselves;
--   - rows before it (stale) fall back to MOST-RECENT-first (then gross, id) — a dead token's honest
--     representative is its last-known state, not its most flattering ancient quote (the naive
--     "best-gross among stale" fallback re-created the PING shadow once its Jul-8 rows aged out of the
--     band too — verified live before this refinement);
--   - null = legacy ordering, byte-identical for existing callers. Re-rank only, never an exclusion.
--
-- DRIFT REPAIR folded in (verified live 2026-07-10): the pre-0011 7-arg overload was still present on
-- the production DB (0011's drop-and-recreate never ran there — the known 0010/0011 drift), which made
-- default calls ambiguous (42725) the moment the 9-arg version appeared. Both legacy signatures are
-- dropped below; `if exists` keeps this idempotent on DBs that had either lineage.

drop function if exists public.arb_top_opportunities_by_token(
  double precision, int, int, boolean, timestamptz, int, int
);
drop function if exists public.arb_top_opportunities_by_token(
  double precision, int, int, boolean, boolean, timestamptz, int, int
);

create or replace function public.arb_top_opportunities_by_token(
  p_min_spread_pct double precision default null,
  p_chain_id       int              default null,
  p_tier_usd       int              default null,
  p_verified_only  boolean          default false,
  p_executable_only boolean         default false,
  p_computed_after timestamptz      default null,
  p_limit          int              default 50,
  p_offset         int              default 0,
  p_fresh_after    timestamptz      default null
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
     order by f.debridge_id,
              (p_fresh_after is null or f.computed_at >= p_fresh_after) desc,          -- fresh band first
              case when p_fresh_after is not null and f.computed_at < p_fresh_after    -- stale: most recent
                   then f.computed_at end desc,
              f.gross_spread_pct desc,                                                 -- fresh: best gross
              f.id
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

-- create or replace resets grants; re-revoke. New signature appends p_fresh_after (timestamptz) last.
revoke execute on function public.arb_top_opportunities_by_token(
  double precision, int, int, boolean, boolean, timestamptz, int, int, timestamptz
) from anon, authenticated, public;
