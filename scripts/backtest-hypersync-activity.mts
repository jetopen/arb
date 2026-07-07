// READ-ONLY gate: use HyperSync (Envio) to sweep RAW on-chain Transfer activity for every dePort rep we
// marked DEAD (debridgeId never produced an opportunity), then re-quote the ACTIVE-but-dead shortlist
// through the REAL scan path (deBridge quote + Kyber/GeckoTerminal verify, NO prefilter). Settles the one
// question every prior test (GT/DexScreener/Kyber/0x/1inch) couldn't: is any "dead" rep actually being
// TRADED on-chain, independent of every index/aggregator? HyperSync only TARGETS here — it never quotes.
// No store writes. Needs ENVIO_API_TOKEN (envio.dev/app/api-tokens). Run: npm run backtest:hypersync
//
// NOTE: on-chain Transfers include mint/bridge, not just swaps — so activity>0 means "worth re-quoting",
// and the re-quote step (deBridge/Kyber) is what confirms a tradeable market. That's the honest test of
// "does on-chain activity surface reps the GeckoTerminal prefilter is wrongly skipping (GRASS/MGLD class)?"
import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd(), true);

const LOOKBACK_DAYS = Math.max(Number(process.env.ACTIVITY_LOOKBACK_DAYS) || 7, 0.5);
const MIN_TRANSFERS = Math.max(Number(process.env.ACTIVITY_MIN_TRANSFERS) || 8, 1);
const MAX_PAGES = Math.max(Number(process.env.ACTIVITY_MAX_PAGES) || 100, 1);
const N = Math.min(Math.max(Number(process.env.BACKTEST_N) || 200, 1), 4000); // cap on active reps re-quoted
const DELAY_MS = Math.max(Number(process.env.BACKTEST_DELAY_MS) || 250, 0);

const { getLockGraph } = await import("@/lib/deport/graph");
const { enumerateUnits, scanUnit } = await import("@/lib/arb/scanner");
const { getStore } = await import("@/lib/db/store");
const { getFixedFeeUsd } = await import("@/lib/deport/fees");
const { getNativeUsd } = await import("@/lib/quotes/native-price");
const { verifyCandidate, verifyViaGeckoTerminal } = await import("@/lib/quotes/verify");
const { fetchKyberQuote, kyberSlug } = await import("@/lib/quotes/kyberswap");
const { fetchZeroExQuote } = await import("@/lib/quotes/zerox");
const { getPoolLiquidityUsd, getTokenStats } = await import("@/lib/liquidity/geckoterminal");
const { fetchDexQuote } = await import("@/lib/quotes/debridge");
const { fetchJupiterQuote } = await import("@/lib/quotes/jupiter");
const { SOLANA_INTERNAL_ID } = await import("@/lib/deport/address-codec");
const { HYPERSYNC_CHAINS } = await import("@/lib/hypersync/chains");
const { getHeight, getChainActivity } = await import("@/lib/hypersync/client");
const { chainName } = await import("@/lib/deport/registry");

// Positive control: GRASS-BSC rep (0xf43a…c8db) has a real (near-dead) Topaz pool Kyber routes but GT
// understates — it should show on-chain activity. The bulk of dead reps should show ~0 (negative control).
const GRASS_BSC = { chainId: 56, address: "0xf43ac1e44bcb375d318d4fa265eff191a229c8db" };

const graph = await getLockGraph();
const famMap = new Map(graph.families.map((f: any) => [f.debridgeId, f]));

// DEAD = families that NEVER produced an opportunity. knownUnitIds() ids are `dbId:buy:sell:tier:kind`;
// dbId is 0x-hex (no colon), so split(":")[0] recovers the ever-live debridgeId set.
const store = getStore();
const known: Set<string> = await store.knownUnitIds().catch(() => new Set<string>());
const everLive = new Set([...known].map((id) => id.split(":")[0]));

// The rep (thin non-native side) of a unit — enumerateUnits always pairs a rep with its native chain.
const repOf = (u: any) => {
  const fam = famMap.get(u.debridgeId);
  if (!fam) return null;
  const repChain = u.buyChainId === fam.nativeChainId ? u.sellChainId : u.buyChainId;
  const rep = fam.reps.find((r: any) => r.internalChainId === repChain);
  return rep ? { chainId: repChain, address: String(rep.address), symbol: fam.symbol as string | undefined } : null;
};

// Unique dead reps on HyperSync-served chains, plus the dead $10 units that touch each (for the re-quote).
type RepKey = string; // `${chainId}:${address.toLowerCase()}`
const repKey = (c: number, a: string): RepKey => `${c}:${a.toLowerCase()}`;
const reps = new Map<RepKey, { chainId: number; address: string; symbol?: string }>();
const unitsByRep = new Map<RepKey, any[]>();

for (const u of enumerateUnits(graph)) {
  if (u.tierUsd !== 10 || everLive.has(u.debridgeId)) continue;
  const r = repOf(u);
  if (!r || !HYPERSYNC_CHAINS.has(r.chainId)) continue;
  const k = repKey(r.chainId, r.address);
  if (!reps.has(k)) reps.set(k, { chainId: r.chainId, address: r.address, symbol: r.symbol });
  (unitsByRep.get(k) ?? unitsByRep.set(k, []).get(k)!).push(u);
}

const byChain = new Map<number, string[]>(); // chainId -> lowercased rep addresses
for (const r of reps.values()) (byChain.get(r.chainId) ?? byChain.set(r.chainId, []).get(r.chainId)!).push(r.address.toLowerCase());

console.log(
  `[activity] graph families=${graph.families.length} everLive=${everLive.size} | dead reps on HyperSync chains: ${reps.size} across ${byChain.size} chains (lookback ${LOOKBACK_DAYS}d, min-transfers ${MIN_TRANSFERS})`
);
for (const [c, addrs] of byChain) console.log(`  ${chainName(c).padEnd(12)} (${c}) — ${addrs.length} reps`);

if (!process.env.ENVIO_API_TOKEN) {
  console.log("\n[activity] ENVIO_API_TOKEN not set — generate one at https://envio.dev/app/api-tokens,");
  console.log("[activity] add it to .env.local as ENVIO_API_TOKEN=…, and re-run to get the activity + recovery tally.");
  process.exit(0);
}

// --- Sweep on-chain Transfer activity, one query stream per chain -------------------------------------
const activity = new Map<RepKey, { transferCount: number; lastBlock: number }>();
for (const [chainId, addrs] of byChain) {
  const spb = HYPERSYNC_CHAINS.get(chainId)!.secondsPerBlock;
  const height = await getHeight(chainId);
  if (height === null) {
    console.log(`[activity] ${chainName(chainId)} (${chainId}) — height unavailable (skipped)`);
    continue;
  }
  const fromBlock = Math.max(0, height - Math.ceil((LOOKBACK_DAYS * 86400) / spb));
  const m = await getChainActivity(chainId, addrs, fromBlock, height, { maxPages: MAX_PAGES });
  if (m === null) {
    console.log(`[activity] ${chainName(chainId)} (${chainId}) — sweep failed (fail-open, skipped)`);
    continue;
  }
  for (const [addr, act] of m) activity.set(repKey(chainId, addr), act);
  console.log(`[activity] ${chainName(chainId).padEnd(12)} (${chainId}) blocks ${fromBlock}..${height} — ${m.size}/${addrs.length} reps with activity`);
}

// --- Distribution + controls -------------------------------------------------------------------------
let zero = 0, low = 0, high = 0;
for (const k of reps.keys()) {
  const c = activity.get(k)?.transferCount ?? 0;
  if (c === 0) zero++;
  else if (c <= 10) low++;
  else high++;
}
console.log("\n=== ON-CHAIN ACTIVITY DISTRIBUTION (dead reps) ===");
console.log(`  0 transfers:    ${zero}`);
console.log(`  1–10 transfers: ${low}`);
console.log(`  >10 transfers:  ${high}`);

const grassKey = repKey(GRASS_BSC.chainId, GRASS_BSC.address);
if (reps.has(grassKey)) {
  const a = activity.get(grassKey);
  console.log(`  control GRASS-BSC (positive): ${a ? `${a.transferCount} transfers, lastBlock ${a.lastBlock}` : "0 transfers"}`);
} else {
  console.log("  control GRASS-BSC: not in the current dead set (family may have gone ever-live or dropped)");
}

const top = [...reps.entries()]
  .map(([k, r]) => ({ ...r, count: activity.get(k)?.transferCount ?? 0 }))
  .filter((r) => r.count > 0)
  .sort((a, b) => b.count - a.count)
  .slice(0, 20);
if (top.length) {
  console.log("\nTop active dead reps:");
  for (const r of top) console.log(`  ${(r.symbol ?? "—").padEnd(12)} ${chainName(r.chainId).padEnd(10)} ${r.address}  ${r.count} transfers`);
}

// --- Re-quote the ACTIVE-but-dead shortlist through the REAL scan path (no prefilter) ----------------
const shortlist = [...reps.entries()].filter(([k]) => (activity.get(k)?.transferCount ?? 0) >= MIN_TRANSFERS).slice(0, N);
console.log(`\n[activity] re-quoting ${shortlist.length} active-but-dead reps (>=${MIN_TRANSFERS} transfers) through deBridge/Kyber…`);

const apiKey = process.env.DEBRIDGE_API_KEY || undefined;
const deps: any = {
  getFamily: (id: string) => famMap.get(id),
  // REAL scan path: deBridge estimation for EVM, Jupiter for Solana. NO prefilter — the point is to quote
  // reps HyperSync flags active even where the GeckoTerminal prefilter would skip them (GRASS/MGLD class).
  fetchQuote: (c: number, i: string, o: string, a: string) =>
    c === SOLANA_INTERNAL_ID ? fetchJupiterQuote(i, o, a) : fetchDexQuote(c, i, o, a, apiKey),
  getFeeUsd: async (chainId: number, dbId: string) => getFixedFeeUsd(chainId, dbId as any, await getNativeUsd(chainId)),
  // Mirror buildScanDeps: judge net-positive AFTER the real verify gate (kills the ~100% artifacts).
  verify: (args: any) =>
    kyberSlug(args.buyChainId) && kyberSlug(args.sellChainId)
      ? verifyCandidate(args, { fetchKyber: fetchKyberQuote, getLiquidityUsd: getPoolLiquidityUsd, fetchZeroEx: fetchZeroExQuote })
      : verifyViaGeckoTerminal(args, { getTokenStats, fetchZeroEx: fetchZeroExQuote }),
};

let tested = 0, newlyLive = 0, profitable = 0, verified = 0, routable = 0, netPositive = 0;
const wins: { sym: string; route: string; net: number; gross: number; status: string }[] = [];

for (const [k] of shortlist) {
  for (const u of unitsByRep.get(k) ?? []) {
    tested++;
    let r: any;
    try {
      r = await scanUnit(u, deps);
    } catch {
      r = { opportunity: null, live: false };
    }
    if (r.live) newlyLive++;
    const o = r.opportunity;
    if (o) {
      if (o.edge.profitable) profitable++;
      const v = o.verification;
      if (v?.verified) verified++;
      if (v?.aggregatorRoutable) routable++;
      if (o.edge.netUsd > 0) {
        netPositive++;
        wins.push({
          sym: o.symbol ?? "—",
          route: `${o.buyChainId}->${o.sellChainId}`,
          net: o.edge.netUsd,
          gross: o.edge.grossSpreadPct,
          status: v?.verified ? `verified(${(v.sourcesAgreed || []).join("+")})` : v?.aggregatorRoutable ? "routable" : v?.rejectReason ? `reject:${v.rejectReason}` : "unverified",
        });
      }
    }
    if (DELAY_MS) await new Promise((res) => setTimeout(res, DELAY_MS));
  }
}

console.log("\n=== HYPERSYNC ACTIVITY GATE ===");
console.log(`dead reps swept:  ${reps.size}   active (>=${MIN_TRANSFERS} transfers): ${shortlist.length}`);
console.log(`units re-quoted:  ${tested}`);
console.log(`newly-live:       ${newlyLive}  (both legs quoted on a route deBridge had marked dead)`);
console.log(`profitable:       ${profitable}  (positive net at $10 before verify)`);
console.log(`verified:         ${verified}   |  aggregatorRoutable: ${routable}`);
console.log(`net-positive$:    ${netPositive}`);
wins.sort((a, b) => b.net - a.net);
for (const w of wins.slice(0, 15)) {
  console.log(`  ${w.sym.padEnd(12)} ${w.route.padEnd(16)} net $${w.net.toFixed(2).padStart(8)}  gross ${w.gross.toFixed(1)}%  ${w.status}`);
}
console.log(`\nBaseline: the 0x (0/896) and 1inch (0/616) dead-route backtests recovered nothing via aggregator eyes.`);
console.log(`Decision: active-and-newly-live > 0 → proceed to Phase 2 wiring; ~0 → HyperSync confirms the ceiling`);
console.log(`          from on-chain ground truth (the strongest proof yet) — document + drop the token.`);
process.exit(0);
