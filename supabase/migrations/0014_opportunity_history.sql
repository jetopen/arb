-- arb-scanner 5c: per-scan spread history.
-- arb_opportunities only keeps the LATEST snapshot per unit (the upsert overwrites), so "has this +2% held
-- for hours or did it flash once on a stale quote?" — the question that decides whether to act — is
-- unanswerable. Append a slim history point on every upsert (bounded by a 7-day retention), so the drawer can
-- show a sparkline + "profitable N of last M".

create table if not exists public.arb_opportunity_history (
  id               bigint generated always as identity primary key,
  unit_id          text not null,
  ts               timestamptz not null default now(),
  gross_spread_pct double precision not null,
  net_usd          double precision not null,
  tier_usd         int not null
);
-- Read index (per-unit, newest first) + a ts index so the retention delete is index-backed (cheap when it
-- removes 0 rows in steady state).
create index if not exists arb_opp_hist_unit_idx on public.arb_opportunity_history (unit_id, ts desc);
create index if not exists arb_opp_hist_ts_idx   on public.arb_opportunity_history (ts);
alter table public.arb_opportunity_history enable row level security;

-- Re-create the upsert (mirrors 0010) and append one history point per item, then prune >7d. Additive +
-- backward-compatible: old code just doesn't read the new table; the history append is a no-op for callers.
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

  -- 5c: append a history point per item (trajectory), then prune the 7-day tail.
  insert into public.arb_opportunity_history (unit_id, gross_spread_pct, net_usd, tier_usd)
  select x.id, x.gross_spread_pct, x.net_usd, x.tier_usd
    from jsonb_to_recordset(items) as x(id text, gross_spread_pct double precision, net_usd double precision, tier_usd int);

  delete from public.arb_opportunity_history where ts < now() - interval '7 days';
end;
$$;

-- create or replace resets grants — re-revoke (server uses service_role which bypasses RLS).
revoke execute on function public.arb_upsert_opportunities(jsonb) from anon, authenticated, public;
