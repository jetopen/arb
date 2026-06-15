import type { Hex } from "viem";
import { getLockGraph } from "../deport/graph";
import { fetchDexQuote } from "../quotes/debridge";
import { fetchJupiterQuote } from "../quotes/jupiter";
import { SOLANA_INTERNAL_ID } from "../deport/address-codec";
import { getFixedFeeUsd } from "../deport/fees";
import { getNativeUsd } from "../quotes/native-price";
import { verifyCandidate, verifySolanaCandidate } from "../quotes/verify";
import { fetchKyberQuote } from "../quotes/kyberswap";
import { getPoolLiquidityUsd, getTokenStats } from "../liquidity/geckoterminal";
import { getStore } from "../db/store";
import { supabaseConfigured } from "../db/supabase";
import { chainName } from "../deport/registry";
import { RpmBudget } from "./budget";
import { runBatch, seedQueue, type ScanDeps } from "./scanner";
import { optimizeRoute } from "./optimize";

let budget: RpmBudget | null = null;
function getBudget(): RpmBudget {
  if (!budget) budget = new RpmBudget(Number(process.env.ARB_SCAN_RPM ?? 120));
  return budget;
}

// Re-seed whenever the lock-graph is (re)built, so families discovered on a graph refresh (6h TTL)
// get enqueued. Tracking builtAt (not a one-shot boolean) avoids a queueSize() round-trip every tick
// while still propagating new routes. seedQueue's enqueue is idempotent (dedup / ON CONFLICT).
let seededGraphAt = 0;

/** Wire the production scan dependencies (real quotes, fees, verification) onto the cached graph. */
export async function buildScanDeps(): Promise<ScanDeps> {
  const graph = await getLockGraph();
  const famMap = new Map(graph.families.map((f) => [f.debridgeId, f]));
  const store = getStore();
  if (seededGraphAt !== graph.builtAt) {
    await seedQueue(store, graph);
    seededGraphAt = graph.builtAt;
  }

  const apiKey = process.env.DEBRIDGE_API_KEY || undefined;
  return {
    getFamily: (id) => famMap.get(id),
    fetchQuote: (c, i, o, a) =>
      c === SOLANA_INTERNAL_ID ? fetchJupiterQuote(i, o, a) : fetchDexQuote(c, i, o, a, apiKey),
    getFeeUsd: async (chainId, dbId) => getFixedFeeUsd(chainId, dbId as Hex, await getNativeUsd(chainId)),
    verify: (args) =>
      args.buyChainId === SOLANA_INTERNAL_ID
        ? verifySolanaCandidate(args, { getTokenStats })
        : verifyCandidate(args, { fetchKyber: fetchKyberQuote, getLiquidityUsd: getPoolLiquidityUsd }),
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

  // optimizeRoute, like scanUnit, passes raw token units 1:1 across the redemption — both legs must
  // share a known decimals or the size sweep is mis-scaled. Forward-found reps can lack/mismatch it.
  const decimalsOf = (chainId: number) =>
    chainId === family.nativeChainId ? family.decimals : family.reps.find((r) => r.internalChainId === chainId)?.decimals;
  const buyDecimals = decimalsOf(buyChainId);
  const sellDecimals = decimalsOf(sellChainId);
  if (buyDecimals === undefined || sellDecimals === undefined || buyDecimals !== sellDecimals) {
    return { error: "token decimals unknown or mismatched — 1:1 redemption not size-safe" as const };
  }

  const apiKey = process.env.DEBRIDGE_API_KEY || undefined;
  return optimizeRoute(
    { debridgeId, buyChainId, sellChainId, buyToken, sellToken, symbol: family.symbol },
    {
      fetchQuote: (c, i, o, a) =>
        c === SOLANA_INTERNAL_ID ? fetchJupiterQuote(i, o, a) : fetchDexQuote(c, i, o, a, apiKey),
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

export interface TrackedRep {
  internalChainId: number;
  chainName: string;
  address: string;
  isNativeRoot: boolean;
  symbol?: string;
  decimals?: number;
}

export interface TrackedFamily {
  debridgeId: string;
  symbol?: string;
  nativeChainId: number;
  nativeChainName: string;
  repCount: number;
  reps: TrackedRep[];
}

export interface GraphDetail {
  families: TrackedFamily[];
  total: number;
  page: number;
  take: number;
  partial: boolean;
  builtAt: number;
  chainsScanned: number[];
}

/** Browsable view of the tracked dePort asset set — families with their per-chain representations. */
export async function getGraphDetail(
  opts: { page?: number; take?: number; multiChainOnly?: boolean; force?: boolean } = {}
): Promise<GraphDetail> {
  const graph = await getLockGraph(opts.force ?? false);
  let families = graph.families;
  if (opts.multiChainOnly) {
    families = families.filter((f) => new Set(f.reps.map((r) => r.internalChainId)).size >= 2);
  }
  // Most-represented families first (the interesting, multi-chain ones), then by symbol for stability.
  families = [...families].sort(
    (a, b) => b.reps.length - a.reps.length || (a.symbol ?? "").localeCompare(b.symbol ?? "")
  );

  const total = families.length;
  const take = Math.min(Math.max(opts.take ?? 100, 1), 500);
  const page = Math.max(opts.page ?? 1, 1);
  const start = (page - 1) * take;

  return {
    total,
    page,
    take,
    partial: graph.partial,
    builtAt: graph.builtAt,
    chainsScanned: graph.chainsScanned,
    families: families.slice(start, start + take).map((f) => ({
      debridgeId: f.debridgeId,
      symbol: f.symbol,
      nativeChainId: f.nativeChainId,
      nativeChainName: chainName(f.nativeChainId),
      repCount: f.reps.length,
      reps: [...f.reps]
        .sort((a, b) => Number(b.isNativeRoot) - Number(a.isNativeRoot))
        .map((r) => ({
          internalChainId: r.internalChainId,
          chainName: chainName(r.internalChainId),
          address: r.address,
          isNativeRoot: r.isNativeRoot,
          symbol: r.symbol,
          decimals: r.decimals,
        })),
    })),
  };
}
