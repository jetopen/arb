-- arb-scanner: materialized lock-graph snapshot read-through.
-- arb_families (migration 0001) already holds one row per family with its cross-chain `reps`, but the READ
-- path was never wired: the graph was rebuilt live (~15-25s of on-chain multicalls) on every cold cache.
-- getLockGraph now reads/writes the snapshot through these RPCs (write-back on each live build). This
-- migration supplies the two pieces the read-through needs:
--   1. a singleton META row — arb_families carries no snapshot-level builtAt/chainsScanned/partial, and its
--      per-row built_at is first-seen (the upsert omits the column), so it can't gate snapshot freshness.
--   2. a jsonb load RPC — a plain row select hits PostgREST's 1000-row cap and would silently truncate the
--      graph (the same trap arb_derive_families dodges in 0004). Returning a single jsonb value sidesteps it.

-- ---------------------------------------------------------------------------
-- graph_meta: snapshot-level metadata (one row; pairs with the arb_families rows)
-- ---------------------------------------------------------------------------
create table if not exists public.arb_graph_meta (
  id             int     primary key default 1,
  built_at       bigint  not null,                       -- LockGraph.builtAt (unix ms)
  chains_scanned jsonb   not null default '[]'::jsonb,    -- number[] of internal chain ids
  partial        boolean not null default false,         -- coverage-gap flag
  updated_at     timestamptz not null default now(),
  constraint arb_graph_meta_singleton check (id = 1)
);

-- ---------------------------------------------------------------------------
-- save: atomically upsert all families + the meta row in one transaction.
-- UPSERT-ONLY (never deletes): high-water-mark coverage — a partial or failed build can never SHRINK the
-- served set. deBridge rep addresses are deterministic/immutable, so an extra/stale family is harmless;
-- losing one would create a coverage gap. p_families uses arb_families' snake_case column names.
-- ---------------------------------------------------------------------------
create or replace function public.arb_save_graph(p_meta jsonb, p_families jsonb)
returns void
language plpgsql
as $$
begin
  insert into public.arb_families
    (debridge_id, native_chain_id, native_address, symbol, name, decimals, native_on_home_chain, reps, built_at)
  select x.debridge_id, x.native_chain_id, x.native_address, x.symbol, x.name, x.decimals,
         coalesce(x.native_on_home_chain, false), coalesce(x.reps, '[]'::jsonb), now()
    from jsonb_to_recordset(p_families) as x(
      debridge_id text, native_chain_id int, native_address text, symbol text, name text,
      decimals int, native_on_home_chain boolean, reps jsonb
    )
  on conflict (debridge_id) do update set
    native_chain_id      = excluded.native_chain_id,
    native_address       = excluded.native_address,
    symbol               = excluded.symbol,
    name                 = excluded.name,
    decimals             = excluded.decimals,
    native_on_home_chain = excluded.native_on_home_chain,
    reps                 = excluded.reps,
    built_at             = now();

  insert into public.arb_graph_meta (id, built_at, chains_scanned, partial, updated_at)
  values (1,
          (p_meta->>'built_at')::bigint,
          coalesce(p_meta->'chains_scanned', '[]'::jsonb),
          coalesce((p_meta->>'partial')::boolean, false),
          now())
  on conflict (id) do update set
    built_at       = excluded.built_at,
    chains_scanned = excluded.chains_scanned,
    partial        = excluded.partial,
    updated_at     = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- load: the whole snapshot as a SINGLE jsonb value (no PostgREST row cap). `meta` is null when the
-- snapshot has never been written — the caller treats that as "no snapshot" and rebuilds. Families are
-- emitted with their full row shape (snake_case + the reps jsonb); Node maps them back via rowToFamily.
-- ---------------------------------------------------------------------------
create or replace function public.arb_load_graph()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'meta',     (select to_jsonb(m) from public.arb_graph_meta m where m.id = 1),
    'families', coalesce((select jsonb_agg(to_jsonb(f)) from public.arb_families f), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- RLS + grants: deny everyone except service_role (which bypasses RLS), matching every other arb_ table.
-- `create or replace function` resets grants, so REVOKE runs after each (re)create. Do NOT make these
-- SECURITY DEFINER — that would bypass RLS for anon.
-- ---------------------------------------------------------------------------
alter table public.arb_graph_meta enable row level security;
revoke execute on function public.arb_save_graph(jsonb, jsonb) from anon, authenticated, public;
revoke execute on function public.arb_load_graph()             from anon, authenticated, public;
