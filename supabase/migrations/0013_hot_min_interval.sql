-- arb-scanner 4b: hot-lane minimum refresh interval.
-- seedQueue now warms only each token's BEST row to the hot lane (~1 row/token, ~73 total) instead of every
-- proven rung (~874). Without a floor, that tiny hot set would re-lease every couple of minutes and waste the
-- budget the shrink frees. Require a hot row to be at least 10 min stale before it's re-leased; unfilled hot
-- slots then spill to the cold-discovery sweep via the existing `limit greatest(n - hot_count, 0)`.
--
-- Backward-compatible with the currently-running old code (which still warms all proven rungs): on the old
-- ~874-row hot set each row is already re-scanned well beyond 10 min apart, so the interval barely bites —
-- meaning this migration can be applied BEFORE the code deploy with no freshness gap either way.
--
-- Only the HOT subquery changes (adds the min-interval); the COLD lane is identical to 0007.
create or replace function public.arb_dequeue_batch(n int, n_hot int)
returns setof public.arb_work_queue
language plpgsql
as $$
declare
  hot_count int;
begin
  -- HOT lane: proven best rows (priority >= 1), least-recently-scanned first, min 10-min refresh interval.
  return query
  update public.arb_work_queue wq
     set leased_until    = now() + interval '150 seconds',
         last_scanned_at = now()
   where wq.id in (
     select id from public.arb_work_queue
      where (leased_until is null or leased_until < now())
        and (last_scanned_at is null or last_scanned_at <= now() - interval '10 minutes')
        and priority >= 1
      order by last_scanned_at nulls first, priority desc
      limit greatest(coalesce(n_hot, 0), 0)
      for update skip locked
   )
  returning wq.*;

  get diagnostics hot_count = row_count;

  -- COLD lane: fill the remaining budget from anything still eligible. The hot rows above are now leased,
  -- so this WHERE (leased_until is null or < now()) excludes them — no row is handed out twice.
  return query
  update public.arb_work_queue wq
     set leased_until    = now() + interval '150 seconds',
         last_scanned_at = now()
   where wq.id in (
     select id from public.arb_work_queue
      where (leased_until is null or leased_until < now())
        and (last_scanned_at is null or last_scanned_at <= now())
      order by last_scanned_at nulls first, priority desc
      limit greatest(coalesce(n, 0) - hot_count, 0)
      for update skip locked
   )
  returning wq.*;
end;
$$;

-- Lock the RPC down like the others (create or replace resets grants → revoke after).
revoke execute on function public.arb_dequeue_batch(int, int) from anon, authenticated, public;
