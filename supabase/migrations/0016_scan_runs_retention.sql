-- 0016: arb_scan_runs retention. The table was append-only — one row per batch tick (~6-9k rows/day,
-- ~150-250 MB/yr toward the free-tier 500 MB cap) with NO index, so lastScanRun()'s
-- `order by finished_at desc limit 1` seq-scanned a perpetually growing heap.
-- Mirror the proven 0014 inline-prune pattern: recording a run prunes the >14-day tail in the same call
-- (index-backed, so steady-state deletes ~one tick's worth of rows). 14 days is plenty for uptime
-- forensics; the interval below is the single knob if that ever changes.
-- DEPLOY ORDER: apply this BEFORE the code that switches recordScanRun to the RPC (as 0012-0014 were).

create index if not exists arb_scan_runs_finished_idx
  on public.arb_scan_runs (finished_at desc);

-- p_-prefixed params so they can't shadow the column names inside plpgsql.
create or replace function public.arb_record_scan_run(
  p_started_at timestamptz,
  p_finished_at timestamptz,
  p_units_processed int,
  p_quotes_spent int,
  p_opportunities_found int,
  p_partial boolean
) returns void
language plpgsql
as $$
begin
  insert into public.arb_scan_runs (started_at, finished_at, units_processed, quotes_spent, opportunities_found, partial)
  values (p_started_at, p_finished_at, p_units_processed, p_quotes_spent, p_opportunities_found, p_partial);

  delete from public.arb_scan_runs where finished_at < now() - interval '14 days';
end;
$$;

-- create or replace resets grants — keep the RPC service-role-only (house rule per 0014).
revoke execute on function public.arb_record_scan_run(timestamptz, timestamptz, int, int, int, boolean)
  from anon, authenticated, public;
