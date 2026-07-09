-- arb-scanner: Discord alert dedup.
-- The scanner re-finds a profitable route on every tick it stays profitable; without dedup that would
-- ping Discord every ~12s for the same opportunity. This table records which opportunity ids have already
-- been alerted; arb_filter_new_alerts atomically marks a batch and returns ONLY the not-yet-alerted ids.
create table if not exists public.arb_alerts_sent (
  id      text primary key,                 -- opportunity / scan-unit id (debridgeId:buy:sell:tier:kind)
  sent_at timestamptz not null default now()
);

-- Insert the given ids (ignoring any already present) and return only the newly-inserted ids — i.e. the
-- opportunities not yet alerted. One atomic round-trip; safe across concurrent callers. `returns table`
-- so PostgREST yields a predictable [{id}] shape.
create or replace function public.arb_filter_new_alerts(p_ids text[])
returns table(id text)
language sql
as $$
  insert into public.arb_alerts_sent (id)
  select distinct unnest(p_ids)
  on conflict (id) do nothing
  returning id;
$$;

alter table public.arb_alerts_sent enable row level security;
revoke execute on function public.arb_filter_new_alerts(text[]) from anon, authenticated, public;
