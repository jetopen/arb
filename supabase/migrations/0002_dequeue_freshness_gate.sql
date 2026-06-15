-- arb-scanner fix #3: enforce the dead-route penalty in the dequeue.
--
-- The 6h demotion sets last_scanned_at = now() + penalty so the time-ordered dequeue stops re-scanning
-- a no-liquidity route. But arb_dequeue_work (0001) had no `last_scanned_at <= now()` gate, so whenever
-- the non-demoted set was smaller than the requested batch, a demoted route was re-dequeued immediately
-- and the penalty never held. This replaces the function body verbatim from 0001 plus a freshness gate:
--   AND (last_scanned_at IS NULL OR last_scanned_at <= now())
-- so only never-scanned (null) or due routes are eligible. Everything else (lease semantics, ordering,
-- `for update skip locked`, the returning shape) is unchanged.

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
      where (leased_until is null or leased_until < now())
        -- Freshness gate: a route demoted into the future is ineligible until its penalty elapses.
        and (last_scanned_at is null or last_scanned_at <= now())
      order by last_scanned_at nulls first, priority desc
      limit greatest(n, 0)
      for update skip locked
   )
  returning wq.*;
end;
$$;

-- `create or replace function` resets grants, so re-apply the 0001 lockdown (defense-in-depth: keep the
-- RPC unreachable by anon/authenticated; the server uses the RLS-bypassing service_role key).
revoke execute on function public.arb_dequeue_work(int) from anon, authenticated, public;
