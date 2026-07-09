-- arb-scanner: capital-size (tier) filter for the spread screener.
-- The screener now probes each route at a LADDER of small notionals (e.g. $10/$25/$50/$100) instead of a
-- single $1k, so it can surface edges that only exist at small size. The /arbitrage capital selector pins
-- the table to one ladder rung; "Best size" (no pin) keeps the distinct-on winner (highest gross spread
-- per token, which is the smallest viable size). This adds the optional p_tier_usd arg to the read RPC.

-- Supports the per-rung filter + the distinct-on(debridge_id) order without a full scan.
create index if not exists arb_opps_tier_token_spread_idx
  on public.arb_opportunities (tier_usd, debridge_id, gross_spread_pct desc);

-- Adding a parameter changes the function signature, so `create or replace` would leave the old 6-arg
-- version in place as a second overload — a call WITHOUT p_tier_usd would then match both and error
-- ("function is not unique"). Drop the old signature first, then create the new one.
drop function if exists public.arb_top_opportunities_by_token(
  double precision, int, boolean, timestamptz, int, int
);

-- One row per token: the highest-gross-spread row per debridge_id, filtered + ranked + paginated in SQL.
-- Returns a SINGLE jsonb object { total, rows } so the exact distinct-token total survives an empty page.
-- p_tier_usd (NEW): when non-null, restrict to that probe size before collapsing (the capital selector);
-- null = best size per token across the ladder. The `id` tiebreaker keeps winner + page order deterministic.
-- SECURITY INVOKER (default): the anon role's empty RLS denies it; only the service_role key reads.
create or replace function public.arb_top_opportunities_by_token(
  p_min_spread_pct double precision default null,
  p_chain_id       int              default null,
  p_tier_usd       int              default null,
  p_verified_only  boolean          default false,
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

-- Lock it down like the other RPCs (PostgREST grants EXECUTE to anon/authenticated by default).
-- `create or replace function` resets grants, so this REVOKE must run after the (re)create.
-- Signature now includes the extra `int` (p_tier_usd) between p_chain_id and p_verified_only.
revoke execute on function public.arb_top_opportunities_by_token(
  double precision, int, int, boolean, timestamptz, int, int
) from anon, authenticated, public;
