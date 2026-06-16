-- arb-scanner: hot-lane dequeue.
-- The work queue was purely time-fair (arb_dequeue_work: order by last_scanned_at nulls first, priority
-- desc) — so the ~29 tokens that actually have two-sided liquidity competed equally with ~1000 dead reps,
-- and `priority` was only a tiebreak, never a queue-jump. Result: the live set refreshed slowly and fell
-- out of the read-freshness window. This adds a reserved HOT lane for the proven/realized-quotability set
-- (priority >= 1, set by seedQueue's enqueue priorityOf + requeueFresh) so it refreshes every tick while
-- the cold-discovery sweep continues with the remaining budget.

-- arb_dequeue_batch(n, n_hot): lease up to n_hot proven rows, then fill up to n total from the rest.
-- Two SEQUENTIAL statements (NOT a single multi-CTE) so the cold statement SEES the hot lease and can't
-- re-grab a hot row. Same eligibility / freshness gate / 150s lease / FOR UPDATE SKIP LOCKED as
-- arb_dequeue_work. arb_dequeue_work is left in place for rollback.
create or replace function public.arb_dequeue_batch(n int, n_hot int)
returns setof public.arb_work_queue
language plpgsql
as $$
declare
  hot_count int;
begin
  -- HOT lane: proven routes only (priority >= 1), least-recently-scanned first.
  return query
  update public.arb_work_queue wq
     set leased_until    = now() + interval '150 seconds',
         last_scanned_at = now()
   where wq.id in (
     select id from public.arb_work_queue
      where (leased_until is null or leased_until < now())
        and (last_scanned_at is null or last_scanned_at <= now())
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
