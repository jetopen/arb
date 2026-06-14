import type { Hex } from "viem";
import { getLockGraph } from "../deport/graph";
import { fetchDexQuote } from "../quotes/debridge";
import { getFixedFeeUsd } from "../deport/fees";
import { getNativeUsd } from "../quotes/native-price";
import { verifyCandidate } from "../quotes/verify";
import { fetchKyberQuote } from "../quotes/kyberswap";
import { getPoolLiquidityUsd } from "../liquidity/geckoterminal";
import { getStore } from "../db/store";
import { supabaseConfigured } from "../db/supabase";
import { RpmBudget } from "./budget";
import { runBatch, seedQueue, type ScanDeps } from "./scanner";
import { optimizeRoute } from "./optimize";

let budget: RpmBudget | null = null;
function getBudget(): RpmBudget {
  if (!budget) budget = new RpmBudget(Number(process.env.ARB_SCAN_RPM ?? 120));
  return budget;
}

// Seed the queue once per process. seedQueue is itself idempotent (queueSize check + ON CONFLICT),
// but this avoids a queueSize() round-trip on every scan tick.
let seeded = false;

/** Wire the production scan dependencies (real quotes, fees, verification) onto the cached graph. */
export async function buildScanDeps(): Promise<ScanDeps> {
  const graph = await getLockGraph();
  const famMap = new Map(graph.families.map((f) => [f.debridgeId, f]));
  const store = getStore();
  if (!seeded) {
    await seedQueue(store, graph);
    seeded = true;
  }

  const apiKey = process.env.DEBRIDGE_API_KEY || undefined;
  return {
    getFamily: (id) => famMap.get(id),
    fetchQuote: (c, i, o, a) => fetchDexQuote(c, i, o, a, apiKey),
    getFeeUsd: async (chainId, dbId) => getFixedFeeUsd(chainId, dbId as Hex, await getNativeUsd(chainId)),
    verify: (args) => verifyCandidate(args, { fetchKyber: fetchKyberQuote, getLiquidityUsd: getPoolLiquidityUsd }),
    store,
    budget: getBudget(),
    concurrency: Number(process.env.ARB_SCAN_CONCURRENCY ?? 8),
  };
}

export async function runScan(n: number) {
  const deps = await buildScanDeps();
  const run = await runBatch(n, deps);
  return {
    ...run,
    remaining: await deps.store.queueSize(),
    rpmAvailable: deps.budget.available(),
  };
}

/** On-demand trade-size optimization for one route (used by the detail drawer). */
export async function runOptimize(debridgeId: string, buyChainId: number, sellChainId: number) {
  const graph = await getLockGraph();
  const family = graph.families.find((f) => f.debridgeId === debridgeId);
  if (!family) return { error: "family not found" as const };
  const member = (chainId: number) =>
    chainId === family.nativeChainId
      ? family.nativeAddress
      : family.reps.find((r) => r.internalChainId === chainId)?.address;
  const buyToken = member(buyChainId);
  const sellToken = member(sellChainId);
  if (!buyToken || !sellToken) return { error: "tokens not found on those chains" as const };

  const apiKey = process.env.DEBRIDGE_API_KEY || undefined;
  return optimizeRoute(
    { debridgeId, buyChainId, sellChainId, buyToken, sellToken, symbol: family.symbol },
    {
      fetchQuote: (c, i, o, a) => fetchDexQuote(c, i, o, a, apiKey),
      getFeeUsd: async (chainId, dbId) => getFixedFeeUsd(chainId, dbId as Hex, await getNativeUsd(chainId)),
    }
  );
}

export async function getGraphSummary(force = false) {
  const graph = await getLockGraph(force);
  const multi = graph.families.filter((f) => new Set(f.reps.map((r) => r.internalChainId)).size >= 2);
  return {
    families: graph.families.length,
    multiChainFamilies: multi.length,
    chainsScanned: graph.chainsScanned,
    partial: graph.partial,
    builtAt: graph.builtAt,
    persisted: supabaseConfigured(),
    queueSize: await getStore().queueSize(),
  };
}
