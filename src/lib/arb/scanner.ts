import type { DexQuote, EdgeResult, Family, LockGraph, Opportunity, ScanUnit, SimulationResult, Verification } from "../types";
import type { VerifyArgs } from "../quotes/verify";
import type { SimulateArgs } from "../sim/simulate";
import type { Store, ScanRunRecord } from "../db/store";
import type { RpmBudget } from "./budget";
import { redemptionEdge } from "./edge";
import { baseToken, tierToBaseUnits, isQuotableChain, rescaleRaw } from "./base-tokens";
import { SOLANA_INTERNAL_ID } from "../deport/address-codec";
import { isTransientQuoteError } from "../quotes/quote-error";

/**
 * The scanner probes a small LADDER of notionals per route — this is a SPREAD screener. Thin deAsset
 * pools move hard on size, so the round-trip gross gap (`grossSpreadPct`) is often only visible at small
 * notionals: a single $1k probe shows a phantom loss on a pool that is genuinely +1% at $25. We scan
 * each route at a few micro sizes and the read path keeps each token's BEST-size row (one row per token),
 * so small-capital edges surface and rank instead of being buried. Sizes come from ARB_SCAN_NOTIONAL_USD
 * (comma-separated, e.g. "10,25,50,100"); a single value still works. The per-route optimizer drawer
 * sweeps $10–$5k on demand for the full net-vs-size curve. Note: the ladder multiplies quote spend per
 * route (one unit per size), so the cycling scanner reaches fewer distinct families per RPM tick —
 * dead (no-liquidity) sizes self-demote, and ARB_SCAN_RPM / ARB_SCAN_CONCURRENCY tune throughput.
 */
/**
 * Default micro ladder used when ARB_SCAN_NOTIONAL_USD is unset/invalid — tuned for the thin-pool deAsset
 * universe where edges live at small size ($10–$100).
 */
export const DEFAULT_LADDER = [10, 25, 50, 100];

/**
 * Parse the probe-size env into a sorted ladder of POSITIVE INTEGERS. `tier_usd` is an `int` column, so a
 * fractional value would make every Supabase upsert/enqueue throw, and a negative would feed a negative
 * amountIn to the quote API — so every rung must be a positive integer. Accepts a comma list
 * ("10,25,50,100"); a single value ("1000") parses to a one-rung ladder (back-compat). Unset / all-invalid
 * falls back to DEFAULT_LADDER. Result is de-duped and ascending.
 */
export function parseNotionalLadder(raw: string | undefined): number[] {
  const rungs = (raw ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const unique = [...new Set(rungs)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : DEFAULT_LADDER;
}

/** Notionals scanned per route — a small ladder; one ScanUnit/Opportunity per (route, direction, size). */
export const DEFAULT_TIERS = parseNotionalLadder(process.env.ARB_SCAN_NOTIONAL_USD);

/** Solana scanning is gated by ARB_SCAN_SOLANA (default on) — a no-deploy kill-switch if Jupiter throttles. */
function solanaScanEnabled(): boolean {
  return process.env.ARB_SCAN_SOLANA !== "false";
}
/** Tx simulation is OPT-IN via ARB_SIMULATE (default off) — enable once build endpoints + slot probing are proven. */
function simulationEnabled(): boolean {
  return process.env.ARB_SIMULATE === "true";
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
      // The dePort move is 1:1 by VALUE, not by raw integer: a deToken carries min(native, 8) decimals,
      // so a rep and its native root can legitimately differ (e.g. an 18-dec EVM token ↔ its 8-dec Solana
      // deAsset). scanUnit rescales the bridged amount by the decimal delta, so we only require decimals to
      // be KNOWN, not equal — dropping the old equal-decimals gate that hid most Solana↔EVM pairs.
      if (rep.decimals === undefined) continue;
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

/** A family member's token decimals on a given chain (native root or a deAsset rep). */
function memberDecimals(family: Family, internalChainId: number): number | undefined {
  if (internalChainId === family.nativeChainId) return family.decimals;
  return family.reps.find((r) => r.internalChainId === internalChainId)?.decimals;
}

export interface ScanDeps {
  getFamily: (debridgeId: string) => Family | undefined;
  fetchQuote: (chainId: number, tokenIn: string, tokenOut: string, amountIn: string) => Promise<DexQuote>;
  getFeeUsd: (internalChainId: number, debridgeId: string) => Promise<number>;
  verify: (args: VerifyArgs) => Promise<Verification>;
  /** Optional tx simulation of the executable path; gated by ARB_SIMULATE. Best-effort (null on failure). */
  simulate?: (args: SimulateArgs) => Promise<SimulationResult | null>;
  store: Store;
  budget: RpmBudget;
  concurrency?: number;
  /** Optional post-upsert hook for side-channel notifications (e.g. Discord). Receives the batch's
   *  opportunities; best-effort — runBatch swallows its errors so a notifier can't break scanning. */
  notify?: (opps: Opportunity[]) => Promise<void>;
}

function opportunityId(u: ScanUnit): string {
  return `${u.debridgeId}:${u.buyChainId}:${u.sellChainId}:${u.tierUsd}:${u.kind}`;
}

/** Route identity WITHOUT the tier, so warm-start priority spans ALL ladder rungs of a proven route
 *  (proving any one rung warms every rung). The full id is dbId:buy:sell:tier:kind; this drops the tier. */
function routeKey(u: ScanUnit): string {
  return `${u.debridgeId}:${u.buyChainId}:${u.sellChainId}:${u.kind}`;
}
/** Strip the tier from a full opportunity/unit id to get its route key. debridgeId is 0x-hex (no colon). */
export function routeKeyOfId(id: string): string {
  const p = id.split(":");
  return p.length === 5 ? `${p[0]}:${p[1]}:${p[2]}:${p[4]}` : id;
}

export interface ScanUnitResult {
  opportunity: Opportunity | null;
  quotesSpent: number;
  /** true when both legs returned a real quote — the route has liquidity and is worth re-scanning. */
  live: boolean;
  /** true when a non-live result was a TRANSIENT upstream failure (5xx/429/network) rather than a permanent
   *  no-route — markScanned applies a short backoff instead of the 6h dead-route penalty. */
  transient: boolean;
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
  if (!family || !buyBase || !sellBase) return { opportunity: null, quotesSpent: 0, live: false, transient: false };

  // Re-check quotability at dispatch, not just at enumeration: a unit enqueued while ARB_SCAN_SOLANA was
  // on persists in the store, so without this guard flipping the kill-switch OFF would still hand a queued
  // Solana unit to Jupiter. scannableChain reads the env per-call, so the switch is honored immediately.
  if (!scannableChain(unit.buyChainId) || !scannableChain(unit.sellChainId)) {
    return { opportunity: null, quotesSpent: 0, live: false, transient: false };
  }

  const buyToken = memberAddress(family, unit.buyChainId);
  const sellToken = memberAddress(family, unit.sellChainId);
  if (!buyToken || !sellToken) return { opportunity: null, quotesSpent: 0, live: false, transient: false };
  // Decimals drive the dePort rescale (1:1 by value, not by raw integer). enumerateUnits already drops
  // units whose decimals are unknown; re-guard here for queued units and direct callers.
  const buyDecimals = memberDecimals(family, unit.buyChainId);
  const sellDecimals = memberDecimals(family, unit.sellChainId);
  if (buyDecimals === undefined || sellDecimals === undefined) return { opportunity: null, quotesSpent: 0, live: false, transient: false };

  let quotesSpent = 0;
  const amountIn = tierToBaseUnits(unit.tierUsd, buyBase);
  let buyLeg: DexQuote;
  let sellLeg: DexQuote;
  let bridged = "0"; // the buy output rescaled to the sell leg's decimals (the amount actually sold)
  // Liquidity probe: if either leg can't be quoted (no DEX route → the aggregator 500s/returns 0), the
  // route is dead — bail with live:false. This is the signal the cycling queue uses to stop wasting
  // budget on the ~no-liquidity wrapped-deAsset reps that forward enumeration surfaces.
  try {
    buyLeg = await deps.fetchQuote(unit.buyChainId, buyBase.address, buyToken, amountIn);
    quotesSpent++;
    if (buyLeg.amountOut === "0") return { opportunity: null, quotesSpent, live: false, transient: false };
    // The dePort move conserves value, not raw units: rescale the bought amount by the buy→sell decimal
    // delta before the sell leg (an 18-dec native ↔ its 8-dec deAsset differ by 10^10). Same decimals →
    // factor 1, so the existing EVM↔EVM path is unchanged.
    bridged = rescaleRaw(buyLeg.amountOut, buyDecimals, sellDecimals);
    if (bridged === "0") return { opportunity: null, quotesSpent, live: false, transient: false };
    sellLeg = await deps.fetchQuote(unit.sellChainId, sellToken, sellBase.address, bridged);
    quotesSpent++;
    if (sellLeg.amountOut === "0") return { opportunity: null, quotesSpent, live: false, transient: false };
  } catch (e) {
    // Distinguish a TRANSIENT upstream failure (5xx/429/network) from a permanent no-route (4xx): the
    // former must NOT 6h-demote a flaky-but-live route (Flow/Sei estimation is intermittently 5xx).
    return { opportunity: null, quotesSpent, live: false, transient: isTransientQuoteError(e) };
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

  // Verification (independent cross-check) and tx simulation (executable-path revert check) are both
  // best-effort corroborations gated on profitability. Run them in parallel — neither throws out of here
  // (each swallows to null), so a cross-check or sim hiccup never sinks a live, profitable row.
  let verification: Verification | null = null;
  let simulation: SimulationResult | null = null;
  if (edge.profitable) {
    const verifyP = deps
      .verify({
        buyChainId: unit.buyChainId,
        usdcAddress: buyBase.address,
        buyTokenAddress: buyToken,
        amountInUsdcUnits: amountIn,
        debridgeBuyAmountOutUsd: buyLeg.amountOutUsd,
        tierUsd: unit.tierUsd,
        buyAmountOut: buyLeg.amountOut,
        buyTokenDecimals: buyDecimals,
        buyQuoteSource: buyLeg.source,
        sellChainId: unit.sellChainId,
        sellTokenAddress: sellToken,
        // Sell-leg quote → the GeckoTerminal verify also price-checks the SOLD deAsset (often the thin leg).
        sellAmountIn: bridged,
        sellTokenDecimals: sellDecimals,
        sellAmountOutUsd: sellLeg.amountOutUsd,
      })
      .catch(() => null); // verification is optional corroboration; absence leaves the row unverified
    const simulateP =
      simulationEnabled() && deps.simulate
        ? deps
            .simulate({
              kind: unit.kind,
              debridgeId: unit.debridgeId,
              buyChainId: unit.buyChainId,
              buyUsdc: buyBase.address,
              buyToken,
              amountIn,
              sellChainId: unit.sellChainId,
              sellToken,
              sellUsdc: sellBase.address,
              sellAmountIn: bridged,
              buySlippageBps: buyLeg.recommendedSlippageBps,
              sellSlippageBps: sellLeg.recommendedSlippageBps,
              buyAmountOut: buyLeg.amountOut,
            })
            .catch(() => null) // simulation is optional; absence leaves the row un-simulated
        : Promise.resolve(null);
    [verification, simulation] = await Promise.all([verifyP, simulateP]);
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
    ...(simulation ? { simulation } : {}),
    lockPath: [
      { chainId: unit.buyChainId, address: buyToken, role: "buy with USDC" },
      { chainId: unit.sellChainId, address: sellToken, role: "dePort 1:1 by value, sell for USDC" },
    ],
    computedAt: Date.now(),
  };
  return { opportunity, quotesSpent, live: true, transient: false };
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

/** Reserve budget, dequeue up to n units, scan with bounded concurrency, persist results. Returns the
 *  persisted ScanRunRecord plus `transientCount` (units that failed with a TRANSIENT upstream error this
 *  tick — NOT persisted; the loop watches it to detect a provider 429/quota storm, which is otherwise
 *  invisible because per-unit throws are swallowed and never reach the loop's errStreak). */
export async function runBatch(n: number, deps: ScanDeps): Promise<ScanRunRecord & { transientCount: number }> {
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
    scanUnit(u, deps).catch(() => ({ opportunity: null, quotesSpent: 0, live: false, transient: true }))
  );

  const opps = results.map((r) => r.opportunity).filter((o): o is Opportunity => o !== null);
  if (opps.length > 0) await deps.store.upsertOpportunities(opps);
  // notify and markScanned are independent after upsert — run in parallel.
  await Promise.all([
    deps.notify && opps.length > 0 ? deps.notify(opps).catch(() => {}) : Promise.resolve(),
    units.length > 0
      ? deps.store.markScanned(units.map((u, i) => ({ unit: u, live: results[i].live, transient: results[i].transient })))
      : Promise.resolve(),
  ]);

  const run: ScanRunRecord = {
    startedAt,
    finishedAt: Date.now(),
    unitsProcessed: units.length,
    quotesSpent: results.reduce((s, r) => s + r.quotesSpent, 0),
    opportunitiesFound: opps.filter((o) => o.edge.profitable).length,
    partial: false,
  };
  await deps.store.recordScanRun(run);
  const transientCount = results.filter((r) => r.transient).length;
  return { ...run, transientCount };
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
  // Warm-start by ROUTE (tier-agnostic), not by exact opportunity id. The screener moved from a single
  // $1k probe to a micro-ladder, which rewrote every id (…:tier:…); an exact-id match would orphan every
  // proven route (its old `:1000:` id never matches a new rung) and shove the genuinely-live routes into
  // the cold lane. Keying on the route means proving ANY rung warms ALL rungs of that route. Route-dedup
  // also shrinks the proven set, so more distinct routes fit under knownUnitIds' cap.
  const knownRoutes = new Set([...known].map(routeKeyOfId));
  await store.enqueue(units, (u) => (knownRoutes.has(routeKey(u)) ? 1 : 0));
  // Bump the PRIORITY (not scan time) of every current rung of a proven route so it wins the dequeue
  // tie-break among equally-stale peers, without re-flooding the queue front (preserves lastScannedAt).
  const provenUnitIds = units.filter((u) => knownRoutes.has(routeKey(u))).map(opportunityId);
  if (provenUnitIds.length > 0) await store.requeueFresh(provenUnitIds).catch(() => {});
  return units.length;
}
