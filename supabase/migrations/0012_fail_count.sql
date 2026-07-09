-- arb-scanner 4d: per-row exponential dead-route backoff.
-- The flat 6h dead-route penalty (DEAD_ROUTE_PENALTY_MS) meant ~8.7k never-quotable reps each retried every
-- 6h forever, saturating the cold lane and leaving a standing eligible backlog. Add a fail_count and back off
-- 6h·2^fail_count (capped 72h) so the persistent-dead long tail is re-checked ever more rarely, freeing budget
-- for genuinely new units (which enter at fail_count 0). Additive + backward-compatible: the old code never
-- reads fail_count nor calls arb_demote_dead, so this is safe to apply while the current scanner is running.

alter table public.arb_work_queue add column if not exists fail_count int not null default 0;

-- Demote permanently-dead routes with exponential backoff. The SET expressions all read the OLD row values,
-- so the interval uses the pre-increment fail_count: first demote 6h (2^0) fail_count→1, then 12h (2^1)→2,
-- 24h→3, 48h→4, then 72h (cap) onward. least() caps the interval; least(fail_count,4) caps the exponent so
-- power() can never overflow the interval type on a route demoted very many times.
create or replace function public.arb_demote_dead(p_ids text[])
returns void
language plpgsql
as $$
begin
  update public.arb_work_queue
     set last_scanned_at = now() + least(interval '6 hours' * power(2, least(fail_count, 4)), interval '72 hours'),
         fail_count      = fail_count + 1,
         leased_until    = null
   where id = any(p_ids);
end;
$$;

-- Lock it down like the other RPCs (create or replace resets grants → revoke after).
revoke execute on function public.arb_demote_dead(text[]) from anon, authenticated, public;
