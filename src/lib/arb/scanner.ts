import type { DexQuote, EdgeResult, Family, LockGraph, Opportunity, ScanUnit, Verification } from "../types";
import type { VerifyArgs } from "../quotes/verify";
import type { Store, ScanRunRecord } from "../db/store";
import type { RpmBudget } from "./budget";
import { redemptionEdge } from "./edge";
import { baseToken, tierToBaseUnits, isQuotableChain } from "./base-tokens";
import { SOLANA_INTERNAL_ID } from "../deport/address-codec";

/**
 * The scanner probes ONE small notional per route, not a tier ladder — this is a SPREAD screener.
 * It surfaces the round-trip gross price gap (`grossSpreadPct`); size and profit are the user's to
 * compute (the per-route optimizer drawer sweeps $25–$5k on demand). A single small probe (a) keeps
 * DEX price impact low so the spread ≈ the true mid-price gap, and (b) cuts quote spend ~3× vs the
 * old 3-tier ladder, so the cycling scanner reaches ~3× more distinct families within the same RPM
 * budget. Override the probe size via ARB_SCAN_NOTIONAL_USD (falls back to $1k on a non-numeric value).
 */
/**
 * Parse the probe-size env into a POSITIVE INTEGER. `tier_usd` is an `int` column, so a fractional
 * value would make every Supabase upsert/enqueue throw; a negative would feed a negative amountIn to
 * the quote API. Unset / non-numeric / non-integer / non-positive all fall back to $1k.
 */
export function parseNotional(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1000;
}
export const SCAN_NOTIONAL_USD = parseNotional(process.env.ARB_SCAN_NOTIONAL_USD);
/**
 * Notionals scanned per route. Retained as an array (and named DEFAULT_TIERS for call-site
 * compatibility with enumerateUnits/seedQueue) but now a single probe size — see SCAN_NOTIONAL_USD.
 */
export const DEFAULT_TIERS = [SCAN_NOTIONAL_USD];

/** Solana scanning is gated by ARB_SCAN_SOLANA (default on) — a no-deploy kill-switch if Jupiter throttles. */
function solanaScanEnabled(): boolean {
  return process.env.ARB_SCAN_SOLANA !== "false";
}
/** A chain the scan path can DEX-quote: any chain with a USDC base, minus Solana when ARB_SCAN_SOLANA=false. */
function scannableChain(internalChainId: number): boolean {
  if (internalChainId === SOLANA_INTERNAL_ID && !solanaScanEnabled()) return false;
  return isQuotableChain(internalChainId);
}

/**
 * PURE: expand the lock-graph into redemption scan-units. For every (rep, home) pair we emit BOTH
 * directions, because a depeg can sit on either side:
 *   - rep -> home: buy the deAsset cheap, dePort-redeem 1:1, sell the native.
 *   - home -> rep: buy the native cheap, dePort-mint 1:1, sell the deAsset.
 */
export function enumerateUnits(graph: LockGraph, tiers: number[] = DEFAULT_TIERS): ScanUnit[] {
  const units: ScanUnit[] = [];
  for (const f of graph.families) {
    if (!scannableChain(f.nativeChainId)) continue; // need a quotable home leg (EVM, or Solana when enabled)
    if (f.decimals === undefined) continue; // can't confirm the 1:1 raw move is decimal-safe
    for (const rep of f.reps) {
      if (rep.internalChainId === f.nativeChainId) continue;
      if (!scannableChain(rep.internalChainId)) continue;
      // The dePort move passes raw token units 1:1 between rep and native root, so the two legs MUST
      // share decimals or the sell leg is mis-scaled into a phantom spread. Forward-found reps can now
      // surface a non-standard deployment, so require a known, matching decimals before scanning.
      if (rep.decimals === undefined || rep.decimals !== f.decimals) continue;
      for (const tierUsd of tiers) {
        units.push({ debridgeId: f.debridgeId, buyChainId: rep.internalChainId, sellChainId: f.nativeChainId, tierUsd, kind: "redemption" });
        units.push({ debridgeId: f.debridgeId, buyChainId: f.nativeChainId, sellChainId: rep.internalChainId, tierUsd, kind: "redemption" });
      }
    }
  }
  return units;
}

/** A family's token address on a given chain (native root or a deAsset rep). */
function memberAddress(family: Family, internalChainId: number): string | undefined {
  if (internalChainId === family.nativeChainId) return family.nativeAddress;
  return family.reps.find((r) => r.internalChainId === internalChainId)?.address;
}

export interface ScanDeps {
  getFamily: (debridgeId: string) => Family | undefined;
  fetchQuote: (chainId: number, tokenIn: string, tokenOut: string, amountIn: string) => Promise<DexQuote>;
  getFeeUsd: (internalChainId: number, debridgeId: string) => Promise<number>;
  verify: (args: VerifyArgs) => Promise<Verification>;
  store: Store;
  budget: RpmBudget;
  concurrency?: number;
}

function opportunityId(u: ScanUnit): string {
  return `${u.debridgeId}:${u.buyChainId}:${u.sellChainId}:${u.tierUsd}:${u.kind}`;
}

export interface ScanUnitResult {
  opportunity: Opportunity | null;
  quotesSpent: number;
  /** true when both legs returned a real quote — the route has liquidity and is worth re-scanning. */
  live: boolean;
}

/**
 * Scan one unit into an Opportunity (or null). Never throws — a missing route / dead pool / API error
 * is reported as `live: false` so the queue can demote it instead of re-burning a quote on it forever.
 * Assumes its 2-quote budget is already reserved.
 */
export async function scanUnit(unit: ScanUnit, deps: ScanDeps): Promise<ScanUnitResult> {
  const family = deps.getFamily(unit.debridgeId);
  const buyBase = baseToken(unit.buyChainId);
  const sellBase = baseToken(unit.sellChainId);
  if (!family || !buyBase || !sellBase) return { opportunity: null, quotesSpent: 0, live: false };

  // Re-check quotability at dispatch, not just at enumeration: a unit enqueued while ARB_SCAN_SOLANA was
  // on persists in the store, so without this guard flipping the kill-switch OFF would still hand a queued
  // Solana unit to Jupiter. scannableChain reads the env per-call, so the switch is honored immediately.
  if (!scannableChain(unit.buyChainId) || !scannableChain(unit.sellChainId)) {
    return { opportunity: null, quotesSpent: 0, live: false };
  }

  const buyToken = memberAddress(family, unit.buyChainId);
  const sellToken = memberAddress(family, unit.sellChainId);
  if (!buyToken || !sellToken) return { opportunity: null, quotesSpent: 0, live: false };

  let quotesSpent = 0;
  const amountIn = tierToBaseUnits(unit.tierUsd, buyBase);
  let buyLeg: DexQuote;
  let sellLeg: DexQuote;
  // Liquidity probe: if either leg can't be quoted (no DEX route → the aggregator 500s/returns 0), the
  // route is dead — bail with live:false. This is the signal the cycling queue uses to stop wasting
  // budget on the ~no-liquidity wrapped-deAsset reps that forward enumeration surfaces.
  try {
    buyLeg = await deps.fetchQuote(unit.buyChainId, buyBase.address, buyToken, amountIn);
    quotesSpent++;
    if (buyLeg.amountOut === "0") return { opportunity: null, quotesSpent, live: false };
    // dePort move is 1:1 in raw units (members share native decimals): sell exactly what we bought.
    sellLeg = await deps.fetchQuote(unit.sellChainId, sellToken, sellBase.address, buyLeg.amountOut);
    quotesSpent++;
    if (sellLeg.amountOut === "0") return { opportunity: null, quotesSpent, live: false };
  } catch {
    return { opportunity: null, quotesSpent, live: false };
  }

  // Both legs quoted → the route is live. Fee/verify failures don't change that (don't penalize a
  // live route for a fee-lookup or cross-check hiccup), so they're best-effort.
  let feeUsd = 0;
  try {
    // The flat dePort fee is charged on the chain the transfer originates from (the buy chain).
    feeUsd = await deps.getFeeUsd(unit.buyChainId, unit.debridgeId);
  } catch {
    /* fee lookup has its own fallback table; treat a hard failure as 0 rather than killing the row */
  }
  const edge: EdgeResult = redemptionEdge(buyLeg, sellLeg, feeUsd);

  let verification: Verification | null = null;
  if (edge.profitable) {
    try {
      verification = await deps.verify({
        buyChainId: unit.buyChainId,
        usdcAddress: buyBase.address,
        buyTokenAddress: buyToken,
        amountInUsdcUnits: amountIn,
        debridgeBuyAmountOutUsd: buyLeg.amountOutUsd,
        tierUsd: unit.tierUsd,
        buyAmountOut: buyLeg.amountOut,
        buyTokenDecimals: family.decimals,
        sellChainId: unit.sellChainId,
        sellTokenAddress: sellToken,
      });
    } catch {
      /* verification is an optional corroboration; absence just leaves the row unverified */
    }
  }

  const opportunity: Opportunity = {
    id: opportunityId(unit),
    debridgeId: unit.debridgeId,
    kind: unit.kind,
    symbol: family.symbol,
    buyChainId: unit.buyChainId,
    sellChainId: unit.sellChainId,
    nativeChainId: family.nativeChainId,
    tierUsd: unit.tierUsd,
    edge,
    verification,
    lockPath: [
      { chainId: unit.buyChainId, address: buyToken, role: "buy with USDC" },
      { chainId: unit.sellChainId, address: sellToken, role: "dePort 1:1, sell for USDC" },
    ],
    computedAt: Date.now(),
  };
  return { opportunity, quotesSpent, live: true };
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Reserve budget, dequeue up to n units, scan with bounded concurrency, persist results. */
export async function runBatch(n: number, deps: ScanDeps): Promise<ScanRunRecord> {
  const startedAt = Date.now();
  // Honor the RPM budget (fix #4): only scan what the budget can grant. Each unit costs 2 quotes, so
  // we can afford floor(available/2) units this tick; never dequeue/scan more than that.
  const affordable = Math.floor(deps.budget.available() / 2);
  const count = Math.min(n, affordable);
  let units: ScanUnit[] = [];
  if (count > 0) {
    units = await deps.store.dequeue(count);
    // Reserve for the units actually dequeued (dequeue may return fewer than `count`). units.length ≤
    // count ≤ affordable, so tryAcquire should always succeed — but RESPECT the boolean: if a concurrent
    // scan drained the bucket between available() and here, do NOT scan this tick (skip both scanning
    // and markScanned). The units keep their refreshed lastScannedAt and simply cycle next tick; the
    // point is that concurrent scans never over-spend the RPM budget.
    if (units.length > 0 && !deps.budget.tryAcquire(units.length * 2)) units = [];
  }

  const results = await mapPool(units, deps.concurrency ?? 8, (u) =>
    scanUnit(u, deps).catch(() => ({ opportunity: null, quotesSpent: 0, live: false }))
  );

  const opps = results.map((r) => r.opportunity).filter((o): o is Opportunity => o !== null);
  if (opps.length > 0) await deps.store.upsertOpportunities(opps);

  // Feed scan outcomes back so the queue demotes dead (no-liquidity) routes and keeps cycling live ones.
  if (units.length > 0) await deps.store.markScanned(units.map((u, i) => ({ unit: u, live: results[i].live })));

  const run: ScanRunRecord = {
    startedAt,
    finishedAt: Date.now(),
    unitsProcessed: units.length,
    quotesSpent: results.reduce((s, r) => s + r.quotesSpent, 0),
    opportunitiesFound: opps.filter((o) => o.edge.profitable).length,
    partial: false,
  };
  await deps.store.recordScanRun(run);
  return run;
}

/**
 * Seed/refresh the work queue from the lock-graph. enqueue is idempotent (existing units are deduped /
 * have only their priority updated), so calling this on every graph (re)build adds newly-discovered
 * families' units without disturbing the cycling state of existing ones. (Snapshot persistence now lives
 * in getLockGraph's write-back, so this no longer saves the graph itself.)
 *
 * Priority = realized quotability: a route that has ever produced a quote (has an opportunity row) is
 * warm-started by PRIORITY (preferred among equally-stale peers in the dequeue tie-break), not by
 * resetting its scan time — so a 6h rebuild can't shove the whole proven set ahead of never-scanned
 * routes and starve them (fix #2). Rep count is deliberately NOT used — the most-replicated assets are
 * canonical wrapped natives (WETH/WBNB/…) that are efficiently priced and mostly un-quotable on their
 * secondary-chain reps, so rep-count priority front-loaded exactly the dead routes. Steady-state
 * demotion of dead routes is handled separately by markScanned (see DEAD_ROUTE_PENALTY_MS).
 */
export async function seedQueue(store: Store, graph: LockGraph, tiers: number[] = DEFAULT_TIERS): Promise<number> {
  const units = enumerateUnits(graph, tiers);
  const known = await store.knownUnitIds().catch(() => new Set<string>());
  await store.enqueue(units, (u) => (known.has(opportunityId(u)) ? 1 : 0));
  // Warm-start the proven-productive routes' PRIORITY (not their scan time) so they win the dequeue
  // tie-break among equally-stale peers. This preserves each route's lastScannedAt — re-seeding on a
  // 6h rebuild no longer re-floods the queue front and starves never-scanned routes (fix #2).
  if (known.size > 0) await store.requeueFresh([...known]).catch(() => {});
  return units.length;
}
