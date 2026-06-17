-- 0010: tx-simulation results on opportunities.
--
-- Adds a nullable `simulation` jsonb column carrying the executable-path sim verdict
-- ({ executable, buy, sell, send, claim, simulatedAt }) and threads it through the upsert RPC, plus a
-- partial index for the "executable only" screener filter. Idempotent (add-if-not-exists +
-- create-or-replace), so it is safe to re-run.

alter table public.arb_opportunities add column if not exists simulation jsonb;

-- Partial index backing the "executable only" filter (simulation.executable === true).
create index if not exists arb_opps_executable_idx
  on public.arb_opportunities (((simulation ->> 'executable')))
  where simulation is not null;

-- Re-create the upsert to carry `simulation` (mirrors 0001, with the new column added to the insert
-- column list, the select, the recordset typing, and the on-conflict update).
create or replace function public.arb_upsert_opportunities(items jsonb)
returns void
language plpgsql
as $$
begin
  insert into public.arb_opportunities as o
    (id, debridge_id, kind, symbol, buy_chain_id, sell_chain_id, native_chain_id, tier_usd,
     net_edge_pct, net_usd, gross_spread_pct, edge, verification, simulation, lock_path, verified,
     times_profitable, computed_at)
  select x.id, x.debridge_id, x.kind, x.symbol, x.buy_chain_id, x.sell_chain_id, x.native_chain_id, x.tier_usd,
         x.net_edge_pct, x.net_usd, x.gross_spread_pct, x.edge, x.verification, x.simulation, x.lock_path,
         -- `verified` is the cross-check result (verification.verified), NOT merely "profitable".
         coalesce(x.verified, false),
         case when coalesce((x.edge->>'profitable')::boolean, false) then 1 else 0 end,
         now()
    from jsonb_to_recordset(items) as x(
      id text, debridge_id text, kind text, symbol text,
      buy_chain_id int, sell_chain_id int, native_chain_id int, tier_usd int,
      net_edge_pct double precision, net_usd double precision, gross_spread_pct double precision,
      edge jsonb, verification jsonb, simulation jsonb, lock_path jsonb, verified boolean
    )
  on conflict (id) do update set
    net_edge_pct     = excluded.net_edge_pct,
    net_usd          = excluded.net_usd,
    gross_spread_pct = excluded.gross_spread_pct,
    edge             = excluded.edge,
    verification     = excluded.verification,
    simulation       = COALESCE(excluded.simulation, o.simulation),
    lock_path        = excluded.lock_path,
    verified         = excluded.verified,
    symbol           = excluded.symbol,
    times_seen       = o.times_seen + 1,
    times_profitable = o.times_profitable + case when coalesce((excluded.edge->>'profitable')::boolean, false) then 1 else 0 end,
    computed_at      = now();
end;
$$;

-- create or replace resets grants — re-revoke (defense-in-depth; server uses service_role which bypasses RLS).
revoke execute on function public.arb_upsert_opportunities(jsonb) from anon, authenticated, public;
