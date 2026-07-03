import type { Hex } from "viem";
import { getLockGraph } from "../deport/graph";
import { fetchDexQuote } from "../quotes/debridge";
import { fetchJupiterQuote } from "../quotes/jupiter";
import { SOLANA_INTERNAL_ID } from "../deport/address-codec";
import { getFixedFeeUsd } from "../deport/fees";
import { getNativeUsd } from "../quotes/native-price";
import { verifyCandidate, verifyViaGeckoTerminal } from "../quotes/verify";
import { simulateOpportunity } from "../sim/simulate";
import { fetchKyberQuote, kyberSlug } from "../quotes/kyberswap";
import { fetchZeroExQuote } from "../quotes/zerox";
import { getPoolLiquidityUsd, getTokenStats } from "../liquidity/geckoterminal";
import { getStore } from "../db/store";
import { supabaseConfigured } from "../db/supabase";
import { chainName } from "../deport/registry";
import { RpmBudget } from "./budget";
import { passesLiquidityPrefilter } from "./liquidity-prefilter";
import { runBatch, seedQueue, type ScanDeps } from "./scanner";
import { optimizeRoute } from "./optimize";
import { sendDiscordAlert } from "../alerts/providers/discord";
import { shouldAlert, bestPerToken, formatOpportunityEmbed, parseAlertMinSpread, ALERT_BATCH_CAP } from "../alerts/opportunity-alert";

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
  // Discord alerts (server-side, fired from whoever drives scans — incl. the headless worker). Active
  // only when DISCORD_WEBHOOK_URL is set; alerts on net-profitable routes OR gross spread >= the optional
  // ARB_ALERT_MIN_SPREAD_PCT. filterNewAlerts dedups so each opportunity pings once, not every tick.
  const discordUrl = process.env.DISCORD_WEBHOOK_URL || undefined;
  const alertMinSpread = parseAlertMinSpread(process.env.ARB_ALERT_MIN_SPREAD_PCT);
  const notify: ScanDeps["notify"] = discordUrl
    ? async (opps) => {
        // Collapse to ONE row per token (strongest first) so a single profitable token can't emit an alert
        // per ladder rung × direction (up to 8) and exhaust the cap. Cap BEFORE marking, so extras beyond
        // the cap stay un-marked and get another chance next batch.
        const candidates = bestPerToken(opps.filter((o) => shouldAlert(o, alertMinSpread))).slice(0, ALERT_BATCH_CAP);
        if (candidates.length === 0) return;
        // Dedup the cross-batch ping on the TOKEN (debridgeId), not the rung-specific opportunity id — so a
        // token pings once even if a different rung/direction wins the next batch.
        const fresh = new Set(await store.filterNewAlerts(candidates.map((o) => o.debridgeId)));
        for (const o of candidates) {
          if (fresh.has(o.debridgeId)) await sendDiscordAlert(discordUrl, { embeds: [formatOpportunityEmbed(o)] });
        }
      }
    : undefined;

  return {
    getFamily: (id) => famMap.get(id),
    fetchQuote: (c, i, o, a) =>
      c === SOLANA_INTERNAL_ID ? fetchJupiterQuote(i, o, a) : fetchDexQuote(c, i, o, a, apiKey),
    getFeeUsd: async (chainId, dbId) => getFixedFeeUsd(chainId, dbId as Hex, await getNativeUsd(chainId)),
    // Cross-check via KyberSwap only when it covers BOTH legs; if EITHER leg is on a chain Kyber can't
    // quote (Solana, Sei, Tron, HyperEVM, Flow, Monad, MegaETH, …), use the GeckoTerminal path — it gates
    // both legs' liquidity AND price-checks the buy and (when a sell quote is passed) the sell leg, so a
    // depegged non-Kyber sell side can't slip through verifyCandidate's buy-leg-only cross-check.
    // When Kyber/GeckoTerminal can't corroborate a leg (a pool 1inch/0x route but they don't index — the
    // MGLD/deMGLD false-negative class), both paths fall back to a 0x routability check (fetchZeroEx) and badge
    // it `aggregatorRoutable` rather than hard-rejecting. Needs ZEROX_API_KEY; absent → degrades to routable.
    verify: (args) =>
      kyberSlug(args.buyChainId) && kyberSlug(args.sellChainId)
        ? verifyCandidate(args, { fetchKyber: fetchKyberQuote, getLiquidityUsd: getPoolLiquidityUsd, fetchZeroEx: fetchZeroExQuote })
        : verifyViaGeckoTerminal(args, { getTokenStats, fetchZeroEx: fetchZeroExQuote }),
    // Tx simulation of the executable path (build → eth_call with state overrides). Gated upstream by
    // ARB_SIMULATE in scanUnit; here we just supply the impl + the deBridge API key for the build calls.
    simulate: (args) => simulateOpportunity({ ...args, apiKey }),
    // Cached GeckoTerminal liquidity pre-filter for the cold sweep: skips units whose deAsset rep has no
    // indexed pool at all, for 0 quote spend. Fails open; kill-switch ARB_PREFILTER=false.
    prefilter: (chainId, address) => passesLiquidityPrefilter(chainId, address),
    store,
    budget: getBudget(),
    concurrency: Number(process.env.ARB_SCAN_CONCURRENCY ?? 8),
    notify,
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

  // optimizeRoute mirrors scanUnit: the dePort move is 1:1 by VALUE, so the size sweep rescales the
  // bridged amount by the buy→sell decimal delta. Decimals only need to be KNOWN (rep ≠ native is fine —
  // e.g. an 18-dec EVM token ↔ its 8-dec Solana deAsset); forward-found reps can still lack them.
  const decimalsOf = (chainId: number) =>
    chainId === family.nativeChainId ? family.decimals : family.reps.find((r) => r.internalChainId === chainId)?.decimals;
  const buyDecimals = decimalsOf(buyChainId);
  const sellDecimals = decimalsOf(sellChainId);
  if (buyDecimals === undefined || sellDecimals === undefined) {
    return { error: "token decimals unknown — 1:1 redemption not size-safe" as const };
  }

  const apiKey = process.env.DEBRIDGE_API_KEY || undefined;
  return optimizeRoute(
    { debridgeId, buyChainId, sellChainId, buyToken, sellToken, symbol: family.symbol, buyDecimals, sellDecimals },
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
