// READ-ONLY backtest: re-run the scan pipeline with 1INCH as the quote source over routes we marked DEAD
// (debridgeId never produced an opportunity), to MEASURE how many become live + net-positive-after-verify.
// Settles "does 1inch route anything deBridge/0x can't (the MGLD/GRASS class)?" with a number — the 0x run
// over this same dead set found 0/896 newly-live (see memory/deport-arb-edge-reality). No store writes.
// Needs ONEINCH_API_KEY (else every leg reads dead → no-op). Run: npm run backtest:1inch
//
// NOTE: 1inch free tier is ~1 RPS — the quote module self-throttles (ONEINCH_RPS, default 1) and the
// default per-route delay here is 1100ms, so a full ~900-route sweep takes ~35+ min. Start with the
// default cap (BACKTEST_N=150) to smoke it, then BACKTEST_N=2000 for the full comparable run.
import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd(), true);

const N = Math.min(Math.max(Number(process.env.BACKTEST_N) || 150, 1), 2000);
const DELAY_MS = Math.max(Number(process.env.BACKTEST_DELAY_MS) || 1100, 0);

const { getLockGraph } = await import("@/lib/deport/graph");
const { enumerateUnits, scanUnit } = await import("@/lib/arb/scanner");
const { fetchOneInchQuote, oneInchSupported } = await import("@/lib/quotes/oneinch");
const { fetchZeroExQuote } = await import("@/lib/quotes/zerox");
const { getStore } = await import("@/lib/db/store");
const { getFixedFeeUsd } = await import("@/lib/deport/fees");
const { getNativeUsd } = await import("@/lib/quotes/native-price");
const { verifyCandidate, verifyViaGeckoTerminal } = await import("@/lib/quotes/verify");
const { fetchKyberQuote, kyberSlug } = await import("@/lib/quotes/kyberswap");
const { getPoolLiquidityUsd, getTokenStats } = await import("@/lib/liquidity/geckoterminal");

// Key-INDEPENDENT 1inch chain check for the dead-set filter (oneInchSupported() is gated on the key, which
// would zero the set when sizing without a key). These 8 chains use internal==evm ids, so the raw id check holds.
const ONEINCH_EVM = new Set([1, 10, 56, 137, 8453, 42161, 43114, 59144]);
const oiChain = (c: number) => ONEINCH_EVM.has(c);

const graph = await getLockGraph();
const famMap = new Map(graph.families.map((f: any) => [f.debridgeId, f]));

// DEAD = families that NEVER produced an opportunity. knownUnitIds() ids are `dbId:buy:sell:tier:kind`;
// dbId is 0x-hex (no colon), so split(":")[0] recovers the ever-live debridgeId set.
const store = getStore();
const known: Set<string> = await store.knownUnitIds().catch(() => new Set<string>());
const everLive = new Set([...known].map((id) => id.split(":")[0]));

const allUnits = enumerateUnits(graph);
// Smallest enumerated tier, not a hardcoded 10 (the ladder comes from ARB_SCAN_NOTIONAL_USD and need not
// contain 10 — hardcoding it makes `dead` empty under a custom ladder and prints a false "settled" verdict).
const baseTier = Math.min(...[...new Set(allUnits.map((u: any) => u.tierUsd))]);
const isDead1inch = (u: any) => u.tierUsd === baseTier && !everLive.has(u.debridgeId) && oiChain(u.buyChainId) && oiChain(u.sellChainId);
const dead = allUnits.filter(isDead1inch).slice(0, N);

// Total dead 1inch-eligible routes at the base tier (before the cap) — sizes the experiment even without a key.
const deadTotal = allUnits.filter(isDead1inch).length;
console.log(`[backtest] graph families=${graph.families.length} everLive=${everLive.size} | dead 1inch-eligible $${baseTier} routes: ${deadTotal} total, testing ${dead.length} (cap ${N})`);
if (deadTotal === 0) {
  console.log("[backtest] dead set is EMPTY (no units at the base tier) — nothing to test; NOT a 'settled' result.");
  process.exit(0);
}

if (!process.env.ONEINCH_API_KEY) {
  console.log("[backtest] ONEINCH_API_KEY not set — every 1inch leg reads dead, so the quote loop is a no-op.");
  console.log("[backtest] Add ONEINCH_API_KEY to .env.local and re-run to get the recovery tally.");
  process.exit(0);
}

const deadQuote = (c: number, i: string, o: string, a: string) => ({
  internalChainId: c, tokenIn: i, tokenOut: o, amountIn: a, amountOut: "0",
  amountInUsd: 0, amountOutUsd: 0, priceImpactBps: 0, gasUsd: 0, recommendedSlippageBps: 0, source: "1inch" as const,
});

const deps: any = {
  getFamily: (id: string) => famMap.get(id),
  // 1inch-only liveness: route both legs through 1inch; null → synthetic dead quote so scanUnit's dead path fires.
  fetchQuote: async (c: number, i: string, o: string, a: string) => {
    if (!oneInchSupported(c)) return deadQuote(c, i, o, a);
    const q = await fetchOneInchQuote(c, i, o, a);
    return q ?? deadQuote(c, i, o, a);
  },
  getFeeUsd: async (chainId: number, dbId: string) => getFixedFeeUsd(chainId, dbId as any, await getNativeUsd(chainId)),
  // Mirror buildScanDeps: judge net-positive AFTER the real verify gate (kills the ~100% artifacts).
  verify: (args: any) =>
    kyberSlug(args.buyChainId) && kyberSlug(args.sellChainId)
      ? verifyCandidate(args, { fetchKyber: fetchKyberQuote, getLiquidityUsd: getPoolLiquidityUsd, fetchZeroEx: fetchZeroExQuote })
      : verifyViaGeckoTerminal(args, { getTokenStats, fetchZeroEx: fetchZeroExQuote }),
};

let tested = 0, newlyLive = 0, profitable = 0, verified = 0, routable = 0, netPositive = 0;
const wins: { sym: string; route: string; net: number; gross: number; status: string }[] = [];

for (const u of dead) {
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
  if (tested % 25 === 0) console.log(`[backtest] ${tested}/${dead.length} … live=${newlyLive} profitable=${profitable} net+=${netPositive}`);
  if (DELAY_MS) await new Promise((res) => setTimeout(res, DELAY_MS));
}

console.log("\n=== 1INCH DEAD-ROUTE BACKTEST ===");
console.log(`tested:        ${tested}`);
console.log(`newly-live:    ${newlyLive}  (both legs 1inch-quoted on a route deBridge marked dead)`);
console.log(`profitable:    ${profitable}  (positive net at $10 before verify)`);
console.log(`verified:      ${verified}   |  aggregatorRoutable: ${routable}`);
console.log(`net-positive$: ${netPositive}`);
wins.sort((a, b) => b.net - a.net);
for (const w of wins.slice(0, 15)) {
  console.log(`  ${w.sym.padEnd(12)} ${w.route.padEnd(16)} net $${w.net.toFixed(2).padStart(8)}  gross ${w.gross.toFixed(1)}%  ${w.status}`);
}
console.log(`\nNOTE: 1inch's quote endpoint returns no USD value, so amountInUsd/amountOutUsd are 0 → the`);
console.log(`profitable / net-positive$ / wins columns above are NOT measured for 1inch (structurally 0).`);
console.log(`Only 'newly-live' (both legs quoted) reflects real 1inch data; the decision rests on it.`);
console.log(`\nBaseline: the 0x backtest over this same dead set found 0 newly-live / 0 net-positive (of 896).`);
console.log(`Decision: newly-live > 0 → consider the verify-path 1inch fallback; 0 → the 1inch question is settled, rotate/drop the key.`);
process.exit(0);
