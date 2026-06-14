import type { DexQuote, EdgeResult, Family, LockGraph, Opportunity, ScanUnit, Verification } from "../types";
import type { VerifyArgs } from "../quotes/verify";
import type { Store, ScanRunRecord } from "../db/store";
import type { RpmBudget } from "./budget";
import { redemptionEdge } from "./edge";
import { baseToken, tierToBaseUnits } from "./base-tokens";
import { isEvmDeportChain } from "../deport/registry";

export const DEFAULT_TIERS = [1000, 10000, 50000];

/**
 * PURE: expand the lock-graph into redemption scan-units. For every (rep, home) pair we emit BOTH
 * directions, because a depeg can sit on either side:
 *   - rep -> home: buy the deAsset cheap, dePort-redeem 1:1, sell the native.
 *   - home -> rep: buy the native cheap, dePort-mint 1:1, sell the deAsset.
 */
export function enumerateUnits(graph: LockGraph, tiers: number[] = DEFAULT_TIERS): ScanUnit[] {
  const units: ScanUnit[] = [];
  for (const f of graph.families) {
    if (!f.nativeOnHomeChain || !baseToken(f.nativeChainId)) continue; // need a quotable home leg
    for (const rep of f.reps) {
      if (rep.internalChainId === f.nativeChainId) continue;
      if (!isEvmDeportChain(rep.internalChainId) || !baseToken(rep.internalChainId)) continue;
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

/** Scan one unit into an Opportunity (or null). Assumes its 2-quote budget is already reserved. */
export async function scanUnit(
  unit: ScanUnit,
  deps: ScanDeps
): Promise<{ opportunity: Opportunity | null; quotesSpent: number }> {
  const family = deps.getFamily(unit.debridgeId);
  const buyBase = baseToken(unit.buyChainId);
  const sellBase = baseToken(unit.sellChainId);
  if (!family || !buyBase || !sellBase) return { opportunity: null, quotesSpent: 0 };

  const buyToken = memberAddress(family, unit.buyChainId);
  const sellToken = memberAddress(family, unit.sellChainId);
  if (!buyToken || !sellToken) return { opportunity: null, quotesSpent: 0 };

  let quotesSpent = 0;
  const amountIn = tierToBaseUnits(unit.tierUsd, buyBase);
  const buyLeg = await deps.fetchQuote(unit.buyChainId, buyBase.address, buyToken, amountIn);
  quotesSpent++;
  if (buyLeg.amountOut === "0") return { opportunity: null, quotesSpent };

  // dePort move is 1:1 in raw units (members share native decimals): sell exactly what we bought.
  const sellLeg = await deps.fetchQuote(unit.sellChainId, sellToken, sellBase.address, buyLeg.amountOut);
  quotesSpent++;

  // The flat dePort fee is charged on the chain the transfer originates from (the buy chain).
  const feeUsd = await deps.getFeeUsd(unit.buyChainId, unit.debridgeId);
  const edge: EdgeResult = redemptionEdge(buyLeg, sellLeg, feeUsd);

  let verification: Verification | null = null;
  if (edge.profitable) {
    verification = await deps.verify({
      buyChainId: unit.buyChainId,
      usdcAddress: buyBase.address,
      buyTokenAddress: buyToken,
      amountInUsdcUnits: amountIn,
      debridgeBuyAmountOutUsd: buyLeg.amountOutUsd,
      tierUsd: unit.tierUsd,
    });
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
  return { opportunity, quotesSpent };
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
  const affordable = Math.floor(deps.budget.available() / 2);
  const count = Math.min(n, affordable);
  let units: ScanUnit[] = [];
  if (count > 0) {
    deps.budget.tryAcquire(count * 2);
    units = await deps.store.dequeue(count);
  }

  const results = await mapPool(units, deps.concurrency ?? 8, (u) =>
    scanUnit(u, deps).catch(() => ({ opportunity: null, quotesSpent: 0 }))
  );

  const opps = results.map((r) => r.opportunity).filter((o): o is Opportunity => o !== null);
  if (opps.length > 0) await deps.store.upsertOpportunities(opps);

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
 * Seed the work queue from the lock-graph if it is empty, and persist the graph.
 * Priority = the family's rep count (more representations ⇒ more established asset ⇒ scan it sooner).
 */
export async function seedQueue(store: Store, graph: LockGraph, tiers: number[] = DEFAULT_TIERS): Promise<number> {
  if ((await store.queueSize()) > 0) return store.queueSize();
  try {
    await store.saveFamilies(graph.families);
  } catch {
    /* persistence is best-effort; never block scanning */
  }
  const units = enumerateUnits(graph, tiers);
  const priorityByFamily = new Map(graph.families.map((f) => [f.debridgeId, f.reps.length]));
  await store.enqueue(units, (u) => priorityByFamily.get(u.debridgeId) ?? 0);
  return units.length;
}
