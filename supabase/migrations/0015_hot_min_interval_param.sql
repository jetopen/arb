-- arb-scanner: parameterize the hot-lane minimum refresh interval.
-- 0013 hard-coded `interval '10 minutes'` in arb_dequeue_batch, so the ARB_HOT_MIN_INTERVAL_MS env knob
-- (src/lib/db/store.ts HOT_MIN_INTERVAL_MS) only affected MemoryStore — the deployed Supabase path always
-- ran at 10 min regardless. This re-creates the function with an explicit `hot_min_interval_ms` argument
-- so the caller's env value is authoritative on both stores.
--
-- Backward-compatible: the old 2-arg signature keeps resolving via the DEFAULT (600000 ms = the previous
-- hard-coded 10 min), so this migration can be applied BEFORE the code deploy with zero behavior change;
-- the code change (supabase-store.dequeue passing the third arg) then activates the knob.
--
-- Only the HOT subquery's staleness bound changes; the COLD lane is identical to 0013.

-- Drop the 2-arg overload FIRST (same transaction, so no visible gap): if both signatures existed,
-- PostgREST would see a 2-arg call as ambiguous (PGRST203) since the 3-arg default also matches it.
drop function if exists public.arb_dequeue_batch(int, int);

create or replace function public.arb_dequeue_batch(n int, n_hot int, hot_min_interval_ms bigint default 600000)
returns setof public.arb_work_queue
language plpgsql
as $$
declare
  hot_count int;
begin
  -- HOT lane: proven best rows (priority >= 1), least-recently-scanned first, min refresh interval.
  return query
  update public.arb_work_queue wq
     set leased_until    = now() + interval '150 seconds',
         last_scanned_at = now()
   where wq.id in (
     select id from public.arb_work_queue
      where (leased_until is null or leased_until < now())
        and (last_scanned_at is null
             or last_scanned_at <= now() - make_interval(secs => greatest(coalesce(hot_min_interval_ms, 600000), 0) / 1000.0))
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
revoke execute on function public.arb_dequeue_batch(int, int, bigint) from anon, authenticated, public;
