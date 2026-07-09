-- arb-scanner: spread-screener read path.
-- The /arbitrage page collapses opportunities to ONE row per token (debridge_id), ranked by the
-- round-trip gross spread. Before this migration the read path sorted/filtered by gross_spread_pct
-- with no supporting index, and SupabaseStore collapsed per-token by pulling a wide window and
-- de-duping in JS. This adds the indexes and an RPC that does the collapse server-side (distinct on),
-- so the API fetches only the page it returns and gets an exact distinct-token total.

-- Indexes for the new sort/filter (previously only net_edge_pct was indexed).
create index if not exists arb_opps_spread_idx
  on public.arb_opportunities (gross_spread_pct desc);
-- Composite supports `distinct on (debridge_id) order by debridge_id, gross_spread_pct desc`.
create index if not exists arb_opps_token_spread_idx
  on public.arb_opportunities (debridge_id, gross_spread_pct desc);

-- One row per token: the highest-gross-spread row per debridge_id, filtered + ranked + paginated in
-- SQL. Returns a SINGLE jsonb object { total, rows } — not a set of (row, total) tuples — so the exact
-- distinct-token total survives even an out-of-range (empty) page (a per-row window count would vanish
-- when zero rows are returned). The `id` tiebreaker makes both the per-token winner and the page order
-- deterministic across calls.
-- SECURITY INVOKER (default): the anon role's empty RLS denies it; only the service_role key reads.
create or replace function public.arb_top_opportunities_by_token(
  p_min_spread_pct double precision default null,
  p_chain_id       int              default null,
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
revoke execute on function public.arb_top_opportunities_by_token(
  double precision, int, boolean, timestamptz, int, int
) from anon, authenticated, public;
