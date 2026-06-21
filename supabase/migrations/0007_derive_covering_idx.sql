-- arb_derive_families regressed again as the event log grew to ~1.14M rows: the planner stopped using
-- the 0005 composite index (arb_de_events_derive_idx) because it does NOT cover the selected metadata
-- columns (token_symbol/name/decimals), so it preferred the single-column debridge_id index + an
-- Incremental Sort of all 1.14M rows. That sort pushed the function past the ~60s API gateway timeout,
-- so the app's RPC errored, deriveFamiliesFromEvents threw, and the lock-graph silently collapsed to
-- EVM-only (333 families, partial=true — dropping all 244 Solana + 7 Tron families).
--
-- Fix: a COVERING index with the exact DISTINCT ON key order plus INCLUDE(metadata). The derive is then
-- an Index Only Scan with no sort: ~12.7s (and lower after VACUUM) — comfortably under the gateway limit.
-- The old non-covering composite index is now strictly redundant (same key prefix) and is dropped to
-- save write amplification on the high-volume, tail-ingested events table.
--
-- Applied live via CREATE/DROP INDEX CONCURRENTLY (non-transactional). The statements below are written
-- plainly for a fresh-DB migration run; switch to CONCURRENTLY if applying to a live, write-active DB.

create index if not exists arb_de_events_derive_cov_idx
  on public.arb_deport_events (debridge_id, origin_chain_id, token_address, block_ts desc nulls last)
  include (token_symbol, token_name, token_decimals);

drop index if exists public.arb_de_events_derive_idx;
