// Backfill the deBridge dePort/DMP submission log (getEvents) into public.arb_deport_events.
// Self-contained + resumable. Loads .env.local via @next/env so the service-role key stays on disk.
//
// Usage:
//   node scripts/backfill-deport-events.cjs                  # full history, resume from cursor
//   node scripts/backfill-deport-events.cjs --reset          # full history from skip 0
//   node scripts/backfill-deport-events.cjs --max-pages 50   # bounded run (validation)
//   node scripts/backfill-deport-events.cjs --from 7565164   # only events whose origin chain = Solana
//   node scripts/backfill-deport-events.cjs --to 7565164     # only events whose dest chain = Solana
// Filtered runs (--from/--to) are ad-hoc and do NOT touch the full-backfill cursor.

const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), true);
const { createClient } = require("@supabase/supabase-js");

const URL = "https://api.debridge.finance/api/Transactions/getEvents";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TAKE = 100; // server caps page size at 100
const THROTTLE_MS = 220; // ~4.5 rps — gentle on Cloudflare
const MAX_BACKOFF_MS = 60_000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name) => process.argv.includes(name);

const fromChain = arg("--from") ? Number(arg("--from")) : null;
const toChain = arg("--to") ? Number(arg("--to")) : null;
const maxPages = arg("--max-pages") ? Number(arg("--max-pages")) : Infinity;
const reset = hasFlag("--reset");
const filtered = fromChain != null || toChain != null;

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mapEvent(e) {
  // origin_chain_id is BIGINT NOT NULL and the family key; a single NULL aborts the whole-page batch upsert
  // (and the backfill process.exit(1)s mid-history). Drop rows missing it — same guard as the TS tail.
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

// Fetch one page with exponential backoff on Cloudflare 1015 / 429 / non-JSON bodies.
async function fetchPage(skip) {
  const body = JSON.stringify({
    chainIdsFrom: fromChain != null ? [fromChain] : [],
    chainIdsTo: toChain != null ? [toChain] : [],
    filter: "",
    skip,
    take: TAKE,
  });
  let backoff = 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { throw new Error(`non-JSON (${r.status}): ${text.slice(0, 80)}`); }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return j;
    } catch (e) {
      if (attempt >= 8) throw e;
      console.warn(`  page ${skip}: ${e.message} — backoff ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

async function readCursor() {
  const { data } = await db.from("arb_ingest_state").select("last_skip,backfill_done").eq("id", 1).maybeSingle();
  return data ?? { last_skip: 0, backfill_done: false };
}
async function writeCursor(last_skip, done) {
  await db.from("arb_ingest_state").update({ last_skip, backfill_done: done, updated_at: new Date().toISOString() }).eq("id", 1);
}

(async () => {
  let skip = 0;
  if (!filtered && !reset) {
    const cur = await readCursor();
    skip = Number(cur.last_skip) || 0;
  }
  const label = filtered ? `from=${fromChain ?? "*"} to=${toChain ?? "*"}` : "full history";
  console.log(`backfill (${label}) starting at skip=${skip}, take=${TAKE}, maxPages=${maxPages}`);

  let pages = 0;
  let inserted = 0;
  let total = null;
  let emptyStreak = 0;
  while (pages < maxPages) {
    const j = await fetchPage(skip);
    if (total == null) { total = j.count; console.log(`  total matching events: ${total}`); }
    const items = (j.items || []).map(mapEvent).filter(Boolean);
    if (items.length === 0) {
      // Deep offset pagination occasionally returns a transient empty page mid-history — only stop after
      // several in a row, otherwise skip past the gap (resumable cursor keeps advancing).
      if (++emptyStreak >= 3) { console.log("  3 consecutive empty pages — done."); break; }
      skip += TAKE;
      if (!filtered) await writeCursor(skip, false);
      await sleep(THROTTLE_MS);
      continue;
    }
    emptyStreak = 0;
    const { data: n, error } = await db.rpc("arb_upsert_deport_events", { items });
    if (error) { console.error("  upsert error:", error.message); process.exit(1); }
    inserted += Number(n) || 0;
    skip += TAKE;
    pages++;
    if (!filtered) await writeCursor(skip, false);
    if (pages % 25 === 0 || items.length < TAKE) {
      console.log(`  page ${pages} (skip ${skip}/${total ?? "?"}) — +${n} new (cum ${inserted})`);
    }
    if (skip >= (total ?? Infinity)) { console.log("  reached end of history."); break; }
    await sleep(THROTTLE_MS);
  }
  if (!filtered && skip >= (total ?? 0)) await writeCursor(skip, true);
  const { count } = await db.from("arb_deport_events").select("*", { count: "exact", head: true });
  console.log(`done. pages=${pages} newlyInserted=${inserted} tableRows=${count}`);
  process.exit(0);
})().catch((e) => {
  console.error("backfill failed:", e.message || e);
  process.exit(1);
});
