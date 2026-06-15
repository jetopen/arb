-- arb-scanner: dePort/DMP submission-log index — the chain-complete deAsset discovery source.
-- The EVM-only, token-list-seeded crawler misses (a) EVM families on no token-list and (b) every
-- non-EVM representation. deBridge's getEvents submission log carries debridgeId + origin/dest chain +
-- token metadata for EVERY cross-chain transfer (all chains, incl. Solana). We index it here and derive
-- the family graph from it. Backfilled once (~1.14M rows) then tailed; see scripts/backfill-deport-events.cjs.

create table if not exists public.arb_deport_events (
  submission_id   text primary key,
  debridge_id     text   not null,
  type            int    not null,           -- 1 = sent (lock/burn), 2 = claimed (mint/redeem)
  origin_chain_id bigint not null,           -- eventOriginChainId (deBridge internal id)
  to_chain_id     bigint,                    -- chainToId
  token_address   text   not null,           -- raw hex as returned (20-byte EVM / 32-byte Solana / ...)
  token_symbol    text,
  token_name      text,
  token_decimals  int,
  block_ts        bigint                     -- blockTimeStamp (unix seconds)
);
create index if not exists arb_de_events_debridge_idx on public.arb_deport_events (debridge_id);
create index if not exists arb_de_events_origin_idx   on public.arb_deport_events (origin_chain_id);
create index if not exists arb_de_events_blockts_idx  on public.arb_deport_events (block_ts desc);

-- Single-row ingest cursor: backfill resume point + tail watermark.
create table if not exists public.arb_ingest_state (
  id                int primary key default 1,
  last_skip         bigint  not null default 0,
  backfill_done     boolean not null default false,
  tail_watermark_ts bigint,
  updated_at        timestamptz not null default now(),
  constraint arb_ingest_state_singleton check (id = 1)
);
insert into public.arb_ingest_state (id) values (1) on conflict (id) do nothing;

-- Batch insert; events are immutable so a conflicting submission_id is a no-op. Returns rows inserted.
create or replace function public.arb_upsert_deport_events(items jsonb)
returns int
language plpgsql
as $$
declare n int;
begin
  insert into public.arb_deport_events
    (submission_id, debridge_id, type, origin_chain_id, to_chain_id,
     token_address, token_symbol, token_name, token_decimals, block_ts)
  select x.submission_id, x.debridge_id, x.type, x.origin_chain_id, x.to_chain_id,
         x.token_address, x.token_symbol, x.token_name, x.token_decimals, x.block_ts
    from jsonb_to_recordset(items) as x(
      submission_id text, debridge_id text, type int, origin_chain_id bigint, to_chain_id bigint,
      token_address text, token_symbol text, token_name text, token_decimals int, block_ts bigint
    )
  on conflict (submission_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- RLS: deny all (service_role bypasses); lock the RPC down like the others.
-- Derive families from the event index: one row per (debridge_id, origin_chain_id, token_address) with
-- the latest metadata, aggregated into a jsonb array of {debridge_id, reps[]}. Returned as a single
-- jsonb value (not a row set) so PostgREST's max-rows cap doesn't truncate it. Node then identifies the
-- native root per family via computeDebridgeId.
create or replace function public.arb_derive_families()
returns jsonb
language sql
stable
as $$
  with reps as (
    select distinct on (debridge_id, origin_chain_id, token_address)
      debridge_id, origin_chain_id, token_address, token_symbol, token_name, token_decimals
    from public.arb_deport_events
    order by debridge_id, origin_chain_id, token_address, block_ts desc nulls last
  )
  select coalesce(jsonb_agg(jsonb_build_object('debridge_id', debridge_id, 'reps', reps)), '[]'::jsonb)
  from (
    select debridge_id,
      jsonb_agg(jsonb_build_object(
        'chainId',  origin_chain_id,
        'address',  token_address,
        'symbol',   token_symbol,
        'name',     token_name,
        'decimals', token_decimals
      )) as reps
    from reps
    group by debridge_id
  ) g;
$$;

alter table public.arb_deport_events enable row level security;
alter table public.arb_ingest_state  enable row level security;
revoke execute on function public.arb_upsert_deport_events(jsonb) from anon, authenticated, public;
revoke execute on function public.arb_derive_families()           from anon, authenticated, public;
