import { getServiceClient, supabaseConfigured } from "../db/supabase";

const GET_EVENTS_URL = "https://api.debridge.finance/api/Transactions/getEvents";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Map a raw getEvents item to an arb_deport_events row (null if it lacks the required keys). */
export function mapEvent(e: any): Record<string, unknown> | null {
  // origin_chain_id is BIGINT NOT NULL and is the family-identity key — a row missing it is useless AND,
  // because arb_upsert_deport_events inserts the whole page in one jsonb_to_recordset batch, a single NULL
  // would abort the entire upsert (losing every good row on the page and stalling the cron). Drop it here.
  if (!e || !e.submissionId || !e.debridgeId || e.eventOriginChainId == null) return null;
  return {
    submission_id: e.submissionId,
    debridge_id: e.debridgeId,
    type: typeof e.type === "number" ? e.type : 0,
    origin_chain_id: e.eventOriginChainId,
    to_chain_id: e.chainToId ?? null,
    token_address: (e.tokenAddress || "").toLowerCase(),
    token_symbol: e.tokenSymbol ?? null,
    token_name: e.tokenName ?? null,
    token_decimals: typeof e.tokenDecimals === "number" ? e.tokenDecimals : null,
    block_ts: e.blockTimeStamp ?? null,
  };
}

/** Fetch one getEvents page (server caps `take` at 100). Browser UA dodges Cloudflare's no-UA 1015 block;
 *  retries non-JSON/HTTP errors with a short exponential backoff. */
export async function fetchEventsPage(
  skip: number,
  take = 100,
  filter: { from?: number; to?: number } = {}
): Promise<{ count: number; items: any[] }> {
  const body = JSON.stringify({
    chainIdsFrom: filter.from != null ? [filter.from] : [],
    chainIdsTo: filter.to != null ? [filter.to] : [],
    filter: "",
    skip,
    take,
  });
  let backoff = 800;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(GET_EVENTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA },
        body,
      });
      const text = await r.text();
      let j: any;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(`non-JSON (${r.status})`);
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { count: j.count ?? 0, items: j.items ?? [] };
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((res) => setTimeout(res, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  }
}

/**
 * Keep the event index current: poll the newest pages and upsert anything not yet stored. Stops once two
 * consecutive pages add nothing (caught up) or after `maxPages`. Cheap and idempotent (PK dedupe) — safe
 * to run on a cron. No-op without Supabase. Run the one-time historical backfill separately
 * (scripts/backfill-deport-events.cjs).
 */
export async function tailDeportEvents(maxPages = 20): Promise<{ scanned: number; inserted: number }> {
  if (!supabaseConfigured()) return { scanned: 0, inserted: 0 };
  const db = getServiceClient();
  let skip = 0;
  let scanned = 0;
  let inserted = 0;
  let dryPages = 0;
  for (let p = 0; p < maxPages; p++) {
    const { items } = await fetchEventsPage(skip, 100);
    const rows = items.map(mapEvent).filter((r): r is Record<string, unknown> => r !== null);
    if (rows.length === 0) break;
    const { data: n, error } = await db.rpc("arb_upsert_deport_events", { items: rows });
    if (error) throw new Error(`tailDeportEvents: ${error.message}`);
    scanned += rows.length;
    const newRows = Number(n) || 0;
    inserted += newRows;
    if (newRows === 0) {
      if (++dryPages >= 2) break; // caught up to the indexed tail
    } else {
      dryPages = 0;
    }
    skip += 100;
  }
  return { scanned, inserted };
}
