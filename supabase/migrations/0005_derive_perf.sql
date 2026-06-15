-- arb_derive_families scanned the whole event log with a sort each call (~8.6s at 0.5M rows → hit the
-- 8s statement timeout under backfill load, silently dropping non-EVM coverage). Add a composite index
-- that satisfies the distinct-on ordering directly (no sort) and raise the function's statement_timeout
-- as a safety margin while the log grows toward ~1.14M rows.

create index if not exists arb_de_events_derive_idx
  on public.arb_deport_events (debridge_id, origin_chain_id, token_address, block_ts desc nulls last);

create or replace function public.arb_derive_families()
returns jsonb
language sql
stable
set statement_timeout = '120s'
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
revoke execute on function public.arb_derive_families() from anon, authenticated, public;
