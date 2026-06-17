// GENUINE liquidity check: for the non-EVM / bonus chains, does the scanner's "no opportunity" verdict
// mean the routes truly have NO liquidity, or is liquidity actually there and something upstream is
// hiding it? For each target chain we:
//   1. inventory its reps in arb_families (total / decimals-known / decimals-undefined),
//   2. cross-reference arb_work_queue (enqueued? demoted as dead?) and arb_opportunities (produced a quote = live),
//   3. INDEPENDENTLY live-probe a sample of reps three ways and classify each:
//        - deBridge /chain/estimation  USDC->rep ($25)   (EVM + non-EVM via the aggregator)
//        - Jupiter quote               USDC->rep ($25)   (Solana only)
//        - GeckoTerminal token         total_reserve_in_usd + price  (does a DEX pool exist at all?)
//      -> LIVE (quote>0) | AGG_GAP (GT pool exists but aggregator can't route) | DEAD (both empty) | NO_GT_SLUG
//
// Read-only. Prints a verdict table; writes nothing. Usage: node scripts/probe-liquidity-truth.mjs

import nextEnv from "@next/env";
try { nextEnv?.loadEnvConfig?.(process.cwd(), true); } catch { /* prod */ }
import { createClient } from "@supabase/supabase-js";

const DLN = "https://dln.debridge.finance";
const JUP = "https://lite-api.jup.ag/swap/v1";
const GT = "https://api.geckoterminal.com/api/v2";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error("Missing SUPABASE_* in .env.local"); process.exit(1); }
const db = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const apiKey = process.env.DEBRIDGE_API_KEY || undefined;

const SOLANA = 7565164;
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// base = USDC/USDT base address per chain (from src/lib/arb/base-tokens.ts), decimals 6 each.
const BASE = {
  100000027: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392", // Sei USDC
  100000026: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",          // Tron USDT
  100000022: "0xb88339cb7199b77e23db6e890353e22632ba630f", // HyperEVM USDC
  100000009: "0xf1815bd50389c46847f0bda824ec8da914045d14", // Flow USDC
  100000030: "0x754704bc059f8c67012fed69bc8a327a5aafb603", // Monad USDC
  100000031: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", // MegaETH USDT0
  [SOLANA]:  SOLANA_USDC,
};
const NAME = {
  100000027: "Sei", 100000026: "Tron", 100000022: "HyperEVM",
  100000009: "Flow", 100000030: "Monad", 100000031: "MegaETH", [SOLANA]: "Solana",
};
// GeckoTerminal slug (matches src/lib/liquidity/geckoterminal.ts; guesses for the two not yet mapped).
const GT_SLUG = {
  100000027: "sei-evm", 100000026: "tron", 100000022: "hyperevm",
  100000009: "flow-evm", 100000030: "monad", 100000031: "megaeth", [SOLANA]: "solana",
};
const SAMPLE = Number(process.argv[2]) || 6; // reps sampled per chain for the live probe
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function estimate(chainId, tokenIn, amountIn, tokenOut) {
  const url = `${DLN}/v1.0/chain/estimation?chainId=${chainId}&tokenIn=${tokenIn}&tokenInAmount=${amountIn}&tokenOut=${tokenOut}`;
  try {
    const res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { out: 0, why: j?.errorId || `HTTP ${res.status}` };
    const out = Number(j?.estimation?.tokenOut?.amount ?? 0);
    return { out, usd: j?.estimation?.tokenOut?.approximateUsdValue };
  } catch (e) { return { out: 0, why: e?.message ?? "fetch err" }; }
}
async function jupiter(tokenIn, amountIn, tokenOut) {
  const url = `${JUP}/quote?inputMint=${tokenIn}&outputMint=${tokenOut}&amount=${amountIn}&slippageBps=100`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
    if (!res.ok) return { out: 0, why: `HTTP ${res.status}` };
    const j = await res.json();
    return { out: Number(j?.outAmount ?? 0), usd: Number(j?.swapUsdValue ?? 0) || undefined };
  } catch (e) { return { out: 0, why: e?.message ?? "fetch err" }; }
}
async function gtToken(slug, addr) {
  if (!slug) return { liq: null, price: null, why: "no slug" };
  const url = `${GT}/networks/${slug}/tokens/${addr}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return { liq: null, price: null, why: `HTTP ${res.status}` };
    const j = await res.json();
    const a = j?.data?.attributes ?? {};
    return { liq: a.total_reserve_in_usd != null ? Number(a.total_reserve_in_usd) : null,
             price: a.price_usd != null ? Number(a.price_usd) : null };
  } catch (e) { return { liq: null, price: null, why: e?.message ?? "fetch err" }; }
}

(async () => {
  const [{ data: fams, error: e1 }, { data: opps }, { data: queue }] = await Promise.all([
    db.from("arb_families").select("debridge_id,native_chain_id,decimals,reps"),
    db.from("arb_opportunities").select("buy_chain_id,sell_chain_id,debridge_id").limit(20000),
    db.from("arb_work_queue").select("buy_chain_id,sell_chain_id,last_scanned_at").limit(50000),
  ]);
  if (e1) { console.error("families read failed:", e1.message); process.exit(1); }

  const nowMs = Date.now();
  // routes that produced a quote (live) keyed by chain touched
  const liveByChain = new Map(); // chainId -> Set of debridgeId
  for (const o of opps ?? []) {
    for (const c of [o.buy_chain_id, o.sell_chain_id]) {
      if (!liveByChain.has(c)) liveByChain.set(c, new Set());
      liveByChain.get(c).add(o.debridge_id);
    }
  }
  // queue scan-state per chain: enqueued / demoted (last_scanned_at in the future = dead penalty) / scanned
  const qstate = new Map(); // chainId -> {enq, demoted, scanned, never}
  for (const q of queue ?? []) {
    for (const c of [q.buy_chain_id, q.sell_chain_id]) {
      if (!qstate.has(c)) qstate.set(c, { enq: 0, demoted: 0, scanned: 0, never: 0 });
      const s = qstate.get(c); s.enq++;
      const t = q.last_scanned_at ? Date.parse(q.last_scanned_at) : null;
      if (t == null) s.never++;
      else if (t > nowMs + 60_000) s.demoted++;
      else s.scanned++;
    }
  }

  const targets = Object.keys(BASE).map(Number);
  // Build per-chain rep inventory: reps living ON that chain, with their family + decimals.
  const repsOnChain = new Map(); // chainId -> [{debridgeId, address, decimals, symbol, nativeChainId, nativeDecimals}]
  for (const t of targets) repsOnChain.set(t, []);
  for (const f of fams ?? []) {
    for (const r of f.reps ?? []) {
      const c = Number(r.internalChainId);
      if (!repsOnChain.has(c)) continue;
      repsOnChain.get(c).push({
        debridgeId: f.debridge_id, address: r.address, decimals: r.decimals,
        symbol: r.symbol ?? "?", nativeChainId: f.native_chain_id, nativeDecimals: f.decimals,
      });
    }
  }

  console.log(`\n==== INVENTORY (what the graph + scanner already know) ====`);
  console.log(`chain        reps  dec?  noDec  | enq  scanned demoted never | liveFams`);
  for (const t of targets) {
    const reps = repsOnChain.get(t);
    const dec = reps.filter((r) => Number.isInteger(r.decimals)).length;
    const noDec = reps.length - dec;
    const q = qstate.get(t) ?? { enq: 0, scanned: 0, demoted: 0, never: 0 };
    const live = liveByChain.get(t)?.size ?? 0;
    console.log(
      `${NAME[t].padEnd(10)} ${String(reps.length).padStart(5)} ${String(dec).padStart(5)} ` +
      `${String(noDec).padStart(6)}  | ${String(q.enq).padStart(4)} ${String(q.scanned).padStart(7)} ` +
      `${String(q.demoted).padStart(7)} ${String(q.never).padStart(5)} | ${String(live).padStart(6)}`
    );
  }

  console.log(`\n==== INDEPENDENT LIVE PROBE (sample ${SAMPLE}/chain): is there REALLY no liquidity? ====`);
  const tally = {};
  for (const t of targets) {
    const reps = repsOnChain.get(t).filter((r) => Number.isInteger(r.decimals));
    // sample: prefer reps with a real symbol (likely thin tokens, not wrapped natives)
    const sample = reps.slice(0, SAMPLE);
    console.log(`\n-- ${NAME[t]} (${reps.length} dec-known reps; sampling ${sample.length}) --`);
    for (const r of sample) {
      const amountIn = (10n ** 6n * 25n).toString(); // $25 in 6-dec base units
      let q;
      if (t === SOLANA) q = await jupiter(BASE[t], amountIn, r.address);
      else q = await estimate(t, BASE[t], amountIn, r.address);
      await sleep(t === SOLANA ? 550 : 350);
      const gt = await gtToken(GT_SLUG[t], r.address);
      await sleep(1100); // GT free tier ~30/min

      let verdict;
      if (q.out > 0) verdict = "LIVE";
      else if (gt.liq && gt.liq > 0) verdict = "AGG_GAP"; // pool exists, aggregator/Jupiter can't route
      else if (gt.why === "no slug" || gt.liq == null) verdict = "DEAD?"; // quote dead, GT inconclusive
      else verdict = "DEAD"; // quote dead AND GT shows ~no pool
      tally[verdict] = (tally[verdict] ?? 0) + 1;

      const liqStr = gt.liq != null ? `$${Math.round(gt.liq).toLocaleString()}` : (gt.why ?? "n/a");
      console.log(
        `  ${verdict.padEnd(8)} ${(r.symbol || "?").padEnd(10)} ${String(r.decimals).padStart(2)}d ` +
        `quote=${q.out > 0 ? "OK $" + (q.usd?.toFixed?.(2) ?? "?") : "0(" + (q.why ?? "") + ")"} ` +
        `GTpool=${liqStr}${gt.price ? " @$" + gt.price : ""}  ${r.address.slice(0, 14)}…`
      );
    }
  }
  console.log(`\n==== VERDICT TALLY ====`);
  console.log(JSON.stringify(tally));
  console.log(`LIVE=quote routes; AGG_GAP=GT pool exists but no aggregator route; DEAD=genuinely no liquidity; DEAD?=quote dead, GT inconclusive`);
  process.exit(0);
})().catch((e) => { console.error("probe failed:", e?.stack ?? e); process.exit(1); });
