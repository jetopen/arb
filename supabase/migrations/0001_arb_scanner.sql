-- arb-scanner Phase 2 schema. Uses the public schema with an `arb_` prefix so supabase-js
-- (PostgREST, which only exposes `public` by default) works without extra config.
-- RLS is enabled with NO policies: the browser/anon/authenticated roles are denied entirely;
-- only the server-side service_role key (which bypasses RLS) can read/write. The browser never
-- talks to these tables directly — it goes through the Next.js API routes.

-- ---------------------------------------------------------------------------
-- families: the dePort lock-graph (one row per debridgeId / lock origin)
-- ---------------------------------------------------------------------------
create table if not exists public.arb_families (
  debridge_id          text primary key,
  native_chain_id      int  not null,
  native_address       text not null,
  symbol               text,
  name                 text,
  decimals             int,
  native_on_home_chain boolean not null default false,
  reps                 jsonb not null default '[]'::jsonb,
  built_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- opportunities: ranked results (latest snapshot per scan-unit id)
-- ---------------------------------------------------------------------------
create table if not exists public.arb_opportunities (
  id               text primary key,
  debridge_id      text not null,
  kind             text not null,
  symbol           text,
  buy_chain_id     int  not null,
  sell_chain_id    int  not null,
  native_chain_id  int  not null,
  tier_usd         int  not null,
  net_edge_pct     double precision not null,
  net_usd          double precision not null,
  gross_spread_pct double precision not null,
  edge             jsonb not null,
  verification     jsonb,
  lock_path        jsonb not null,
  verified         boolean not null default false,
  times_seen       int not null default 1,
  times_profitable int not null default 0,
  first_seen_at    timestamptz not null default now(),
  computed_at      timestamptz not null default now()
);
create index if not exists arb_opps_net_idx      on public.arb_opportunities (net_edge_pct desc);
create index if not exists arb_opps_tier_idx     on public.arb_opportunities (tier_usd);
create index if not exists arb_opps_verified_idx on public.arb_opportunities (verified);
create index if not exists arb_opps_profit_idx   on public.arb_opportunities (times_profitable desc);

-- ---------------------------------------------------------------------------
-- scan_runs: telemetry per batch
-- ---------------------------------------------------------------------------
create table if not exists public.arb_scan_runs (
  id                  bigint generated always as identity primary key,
  started_at          timestamptz not null,
  finished_at         timestamptz not null,
  units_processed     int not null,
  quotes_spent        int not null,
  opportunities_found int not null,
  partial             boolean not null default false
);

-- ---------------------------------------------------------------------------
-- work_queue: leased scan units (route batches + an optional daemon drain it safely)
-- ---------------------------------------------------------------------------
create table if not exists public.arb_work_queue (
  id              text primary key,
  debridge_id     text not null,
  buy_chain_id    int  not null,
  sell_chain_id   int  not null,
  tier_usd        int  not null,
  kind            text not null,
  priority        double precision not null default 0,
  leased_until    timestamptz,
  last_scanned_at timestamptz
);
create index if not exists arb_wq_lease_idx on public.arb_work_queue (leased_until nulls first, priority desc);

-- ---------------------------------------------------------------------------
-- RPCs (jsonb batch in, so one round-trip)
-- ---------------------------------------------------------------------------

-- Atomic leased dequeue: pick the least-recently-scanned unleased units (priority breaks ties),
-- lease them past the route's maxDuration (150s > 120s) so a slow batch can't be double-processed,
-- and never hand the same unit to two concurrent workers (for update skip locked).
-- Time-first ordering guarantees fair, complete cycling — high-priority families can't starve the tail.
create or replace function public.arb_dequeue_work(n int)
returns setof public.arb_work_queue
language plpgsql
as $$
begin
  return query
  update public.arb_work_queue wq
     set leased_until    = now() + interval '150 seconds',
         last_scanned_at = now()
   where wq.id in (
     select id from public.arb_work_queue
      where leased_until is null or leased_until < now()
      order by last_scanned_at nulls first, priority desc
      limit greatest(n, 0)
      for update skip locked
   )
  returning wq.*;
end;
$$;

-- Upsert opportunities, incrementing times_seen / times_profitable on conflict.
create or replace function public.arb_upsert_opportunities(items jsonb)
returns void
language plpgsql
as $$
begin
  insert into public.arb_opportunities as o
    (id, debridge_id, kind, symbol, buy_chain_id, sell_chain_id, native_chain_id, tier_usd,
     net_edge_pct, net_usd, gross_spread_pct, edge, verification, lock_path, verified,
     times_profitable, computed_at)
  select x.id, x.debridge_id, x.kind, x.symbol, x.buy_chain_id, x.sell_chain_id, x.native_chain_id, x.tier_usd,
         x.net_edge_pct, x.net_usd, x.gross_spread_pct, x.edge, x.verification, x.lock_path,
         -- `verified` is the cross-check result (verification.verified), NOT merely "profitable".
         coalesce(x.verified, false),
         case when coalesce((x.edge->>'profitable')::boolean, false) then 1 else 0 end,
         now()
    from jsonb_to_recordset(items) as x(
      id text, debridge_id text, kind text, symbol text,
      buy_chain_id int, sell_chain_id int, native_chain_id int, tier_usd int,
      net_edge_pct double precision, net_usd double precision, gross_spread_pct double precision,
      edge jsonb, verification jsonb, lock_path jsonb, verified boolean
    )
  on conflict (id) do update set
    net_edge_pct     = excluded.net_edge_pct,
    net_usd          = excluded.net_usd,
    gross_spread_pct = excluded.gross_spread_pct,
    edge             = excluded.edge,
    verification     = excluded.verification,
    lock_path        = excluded.lock_path,
    verified         = excluded.verified,
    symbol           = excluded.symbol,
    times_seen       = o.times_seen + 1,
    times_profitable = o.times_profitable + case when coalesce((excluded.edge->>'profitable')::boolean, false) then 1 else 0 end,
    computed_at      = now();
end;
$$;

-- Enqueue work units, updating priority on conflict (id is the stable scan-unit key).
create or replace function public.arb_enqueue_work(items jsonb)
returns void
language plpgsql
as $$
begin
  insert into public.arb_work_queue (id, debridge_id, buy_chain_id, sell_chain_id, tier_usd, kind, priority)
  select x.id, x.debridge_id, x.buy_chain_id, x.sell_chain_id, x.tier_usd, x.kind, coalesce(x.priority, 0)
    from jsonb_to_recordset(items) as x(
      id text, debridge_id text, buy_chain_id int, sell_chain_id int, tier_usd int, kind text, priority double precision
    )
  on conflict (id) do update set priority = excluded.priority;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: deny everyone except service_role (which bypasses RLS).
-- ---------------------------------------------------------------------------
alter table public.arb_families      enable row level security;
alter table public.arb_opportunities enable row level security;
alter table public.arb_scan_runs     enable row level security;
alter table public.arb_work_queue    enable row level security;

-- ---------------------------------------------------------------------------
-- Lock the RPCs down: PostgREST grants EXECUTE on public functions to anon/authenticated by
-- default, exposing them at /rest/v1/rpc/<fn> with the public anon key. RLS blocks the data
-- effect (these run SECURITY INVOKER, so the anon role's empty RLS denies reads/writes), but we
-- still revoke EXECUTE so they aren't reachable at all (defense-in-depth + no anon DoS amplifier).
-- The server uses the service_role key, which bypasses RLS and is unaffected.
-- NOTE: `create or replace function` resets grants, so these REVOKEs must run AFTER each (re)create.
-- Do NOT make these SECURITY DEFINER — that would bypass RLS for anon and re-open the hole.
revoke execute on function public.arb_dequeue_work(int)           from anon, authenticated, public;
revoke execute on function public.arb_enqueue_work(jsonb)         from anon, authenticated, public;
revoke execute on function public.arb_upsert_opportunities(jsonb) from anon, authenticated, public;
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;
