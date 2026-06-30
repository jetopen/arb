// READ-ONLY backtest: re-run the scan pipeline with 0x as the quote source over routes we marked DEAD
// (debridgeId never produced an opportunity), to MEASURE how many become live + net-positive-after-verify.
// Settles "could RFQ/dead-pool liquidity make more dePort routes fillable?" with a number, not an inference.
// No store writes. Needs ZEROX_API_KEY (else every leg reads dead → no-op). Run: npx tsx scripts/backtest-0x-liveness.mts
import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd(), true);

const N = Math.min(Math.max(Number(process.env.BACKTEST_N) || 150, 1), 2000);
const DELAY_MS = Math.max(Number(process.env.BACKTEST_DELAY_MS) || 250, 0);

const { getLockGraph } = await import("@/lib/deport/graph");
const { enumerateUnits, scanUnit } = await import("@/lib/arb/scanner");
const { fetchZeroExQuote, zeroExSupported } = await import("@/lib/quotes/zerox");
const { getStore } = await import("@/lib/db/store");
const { getFixedFeeUsd } = await import("@/lib/deport/fees");
const { getNativeUsd } = await import("@/lib/quotes/native-price");
const { verifyCandidate, verifyViaGeckoTerminal } = await import("@/lib/quotes/verify");
const { fetchKyberQuote, kyberSlug } = await import("@/lib/quotes/kyberswap");
const { getPoolLiquidityUsd, getTokenStats } = await import("@/lib/liquidity/geckoterminal");

// Key-INDEPENDENT 0x chain check for the dead-set filter (zeroExSupported() is gated on the key, which would
// zero the set when sizing without a key). These 13 chains use internal==evm ids, so the raw id check holds.
const ZEROX_EVM = new Set([1, 10, 56, 137, 8453, 42161, 43114, 59144, 5000, 534352, 81457, 34443, 130]);
const zxChain = (c: number) => ZEROX_EVM.has(c);

const graph = await getLockGraph();
const famMap = new Map(graph.families.map((f: any) => [f.debridgeId, f]));

// DEAD = families that NEVER produced an opportunity. knownUnitIds() ids are `dbId:buy:sell:tier:kind`;
// dbId is 0x-hex (no colon), so split(":")[0] recovers the ever-live debridgeId set.
const store = getStore();
const known: Set<string> = await store.knownUnitIds().catch(() => new Set<string>());
const everLive = new Set([...known].map((id) => id.split(":")[0]));

const isDead0x = (u: any) => u.tierUsd === 10 && !everLive.has(u.debridgeId) && zxChain(u.buyChainId) && zxChain(u.sellChainId);
const dead = enumerateUnits(graph).filter(isDead0x).slice(0, N);

// Total dead 0x-eligible $10 routes (before the cap) — sizes the experiment even without a key.
const deadTotal = enumerateUnits(graph).filter(isDead0x).length;
console.log(`[backtest] graph families=${graph.families.length} everLive=${everLive.size} | dead 0x-eligible $10 routes: ${deadTotal} total, testing ${dead.length} (cap ${N})`);

if (!process.env.ZEROX_API_KEY) {
  console.log("[backtest] ZEROX_API_KEY not set — every 0x leg reads dead, so the quote loop is a no-op.");
  console.log("[backtest] Add ZEROX_API_KEY to .env.local and re-run to get the recovery tally.");
  process.exit(0);
}

const deadQuote = (c: number, i: string, o: string, a: string) => ({
  internalChainId: c, tokenIn: i, tokenOut: o, amountIn: a, amountOut: "0",
  amountInUsd: 0, amountOutUsd: 0, priceImpactBps: 0, gasUsd: 0, recommendedSlippageBps: 0, source: "0x" as const,
});

const deps: any = {
  getFamily: (id: string) => famMap.get(id),
  // 0x-only liveness: route both legs through 0x; null → synthetic dead quote so scanUnit's dead path fires.
  fetchQuote: async (c: number, i: string, o: string, a: string) => {
    if (!zeroExSupported(c)) return deadQuote(c, i, o, a);
    const q = await fetchZeroExQuote(c, i, o, a);
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

console.log("\n=== 0x DEAD-ROUTE BACKTEST ===");
console.log(`tested:        ${tested}`);
console.log(`newly-live:    ${newlyLive}  (both legs 0x-quoted on a route deBridge marked dead)`);
console.log(`profitable:    ${profitable}  (positive net at $10 before verify)`);
console.log(`verified:      ${verified}   |  aggregatorRoutable: ${routable}`);
console.log(`net-positive$: ${netPositive}`);
wins.sort((a, b) => b.net - a.net);
for (const w of wins.slice(0, 15)) {
  console.log(`  ${w.sym.padEnd(12)} ${w.route.padEnd(16)} net $${w.net.toFixed(2).padStart(8)}  gross ${w.gross.toFixed(1)}%  ${w.status}`);
}
console.log(`\nDecision: promote 0x to the liveness probe only if a handful net > a few $ AFTER verify; else the coverage question is settled.`);
process.exit(0);
