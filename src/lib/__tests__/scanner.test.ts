import { describe, it, expect } from "vitest";
import { enumerateUnits, scanUnit, runBatch, seedQueue, parseNotionalLadder, routeKeyOfId, DEFAULT_LADDER, DEFAULT_TIERS, type ScanDeps } from "../arb/scanner";
import { MemoryStore } from "../db/store";
import { RpmBudget } from "../arb/budget";
import type { DexQuote, Family, LockGraph, Opportunity, SimulationResult } from "../types";
import type { VerifyArgs } from "../quotes/verify";
import { QuoteHttpError } from "../quotes/quote-error";

function fam(over: Partial<Family>): Family {
  return {
    debridgeId: "0xfam",
    nativeChainId: 56, // BSC home (quotable, has base)
    nativeAddress: "0xnative",
    symbol: "TKN",
    decimals: 18,
    nativeOnHomeChain: true,
    reps: [
      { internalChainId: 56, address: "0xnative", isNativeRoot: true, decimals: 18 },
      { internalChainId: 42161, address: "0xdeasset", isNativeRoot: false, decimals: 18 }, // deAsset on Arbitrum
    ],
    ...over,
  };
}

function graphOf(families: Family[]): LockGraph {
  return { families, builtAt: 0, chainsScanned: [56, 42161], partial: false };
}

function quote(over: Partial<DexQuote>): DexQuote {
  return {
    internalChainId: 0,
    tokenIn: "0x",
    tokenOut: "0x",
    amountIn: "0",
    amountOut: "0",
    amountInUsd: 0,
    amountOutUsd: 0,
    priceImpactBps: 0,
    gasUsd: 0,
    recommendedSlippageBps: 0,
    source: "debridge",
    ...over,
  };
}

describe("enumerateUnits", () => {
  it("emits both directions per (rep, tier) for quotable families", () => {
    const units = enumerateUnits(graphOf([fam({})]), [1000, 10000]);
    // 1 rep × 2 tiers × 2 directions
    expect(units).toHaveLength(4);
    expect(units.some((u) => u.buyChainId === 42161 && u.sellChainId === 56)).toBe(true); // rep -> home
    expect(units.some((u) => u.buyChainId === 56 && u.sellChainId === 42161)).toBe(true); // home -> rep
  });

  it("emits both directions per rung of the default ladder", () => {
    const units = enumerateUnits(graphOf([fam({})]));
    // 1 rep × DEFAULT_TIERS rungs × 2 directions
    expect(DEFAULT_TIERS.length).toBeGreaterThanOrEqual(1);
    expect(units).toHaveLength(2 * DEFAULT_TIERS.length);
  });

  it("skips families whose home chain has no USDC base (non-quotable)", () => {
    // Injective (internal id 100000029) has no USDC base in BASE_USDC (deferred) → not quotable → skipped.
    const injHome = fam({ nativeChainId: 100000029, nativeOnHomeChain: false });
    expect(enumerateUnits(graphOf([injHome]), [1000])).toHaveLength(0);
  });

  it("scans a Solana-native family when ARB_SCAN_SOLANA is on, skips it when off", () => {
    const solFam = fam({
      nativeChainId: 7565164,
      nativeAddress: "0xsol",
      reps: [
        { internalChainId: 7565164, address: "0xsol", isNativeRoot: true, decimals: 18 },
        { internalChainId: 42161, address: "0xdeasset", isNativeRoot: false, decimals: 18 },
      ],
    });
    const prev = process.env.ARB_SCAN_SOLANA;
    try {
      delete process.env.ARB_SCAN_SOLANA; // default → enabled
      expect(enumerateUnits(graphOf([solFam]), [1000])).toHaveLength(2); // both directions of the one rep
      process.env.ARB_SCAN_SOLANA = "false"; // kill-switch
      expect(enumerateUnits(graphOf([solFam]), [1000])).toHaveLength(0);
    } finally {
      // Restore even if an assertion throws, so ARB_SCAN_SOLANA='false' never leaks into later tests.
      if (prev === undefined) delete process.env.ARB_SCAN_SOLANA;
      else process.env.ARB_SCAN_SOLANA = prev;
    }
  });

  it("emits cross-decimal reps (rescaled, e.g. an 18-dec native ↔ its 8-dec deAsset), but skips UNKNOWN decimals", () => {
    // rep decimals differ from the native root (18 vs 8 — a deBridge deToken). The dePort move is 1:1 by
    // value and scanUnit rescales, so this is NO LONGER skipped — both directions are emitted.
    const crossDecimal = fam({
      reps: [
        { internalChainId: 56, address: "0xnative", isNativeRoot: true, decimals: 18 },
        { internalChainId: 42161, address: "0xdeasset", isNativeRoot: false, decimals: 8 },
      ],
    });
    expect(enumerateUnits(graphOf([crossDecimal]), [1000])).toHaveLength(2); // rep→home + home→rep

    // rep decimals unknown (forward-found, ERC20 read failed) → still skip: can't rescale safely
    const unknownRep = fam({
      reps: [
        { internalChainId: 56, address: "0xnative", isNativeRoot: true, decimals: 18 },
        { internalChainId: 42161, address: "0xdeasset", isNativeRoot: false },
      ],
    });
    expect(enumerateUnits(graphOf([unknownRep]), [1000])).toHaveLength(0);

    // family decimals unknown → skip the whole family
    expect(enumerateUnits(graphOf([fam({ decimals: undefined })]), [1000])).toHaveLength(0);
  });
});

describe("scanUnit", () => {
  const family = fam({});
  function deps(over: Partial<ScanDeps> = {}): ScanDeps {
    return {
      getFamily: () => family,
      // buy: $10k USDC -> 100 deAsset ; sell: 100 native -> $10,090 USDC  => profitable
      fetchQuote: async (_chainId, _tokenIn, tokenOut) => {
        const isBuy = tokenOut === "0xdeasset"; // buy leg acquires the deAsset
        return isBuy
          ? quote({ amountOut: "100", amountInUsd: 10000, amountOutUsd: 10000, gasUsd: 0.5 })
          : quote({ amountOut: "10090000000", amountInUsd: 10090, amountOutUsd: 10090, gasUsd: 0.5 });
      },
      getFeeUsd: async () => 4,
      verify: async (_a: VerifyArgs) => ({ verified: true, sourcesAgreed: ["debridge", "kyberswap"], quoteDisagreementBps: 10, liquidityUsd: 5_000_000 }),
      store: new MemoryStore(),
      budget: new RpmBudget(100, 0),
      ...over,
    };
  }

  it("produces a profitable, verified opportunity with a lock path", async () => {
    const { opportunity, quotesSpent } = await scanUnit(
      { debridgeId: "0xfam", buyChainId: 42161, sellChainId: 56, tierUsd: 10000, kind: "redemption" },
      deps()
    );
    expect(quotesSpent).toBe(2);
    expect(opportunity).not.toBeNull();
    expect(opportunity!.edge.profitable).toBe(true);
    expect(opportunity!.verification?.verified).toBe(true);
    expect(opportunity!.lockPath).toHaveLength(2);
    expect(opportunity!.id).toBe("0xfam:42161:56:10000:redemption");
  });

  it("does NOT verify when the edge is unprofitable", async () => {
    let verifyCalls = 0;
    const d = deps({
      fetchQuote: async (_chainId, _tokenIn, tokenOut) => {
        const isBuy = tokenOut === "0xdeasset";
        return isBuy
          ? quote({ amountOut: "100", amountInUsd: 10000, amountOutUsd: 10000 })
          : quote({ amountOut: "9990000000", amountInUsd: 9990, amountOutUsd: 9990 }); // loss
      },
      verify: async () => {
        verifyCalls++;
        return { verified: true, sourcesAgreed: [], quoteDisagreementBps: null, liquidityUsd: null };
      },
    });
    const { opportunity } = await scanUnit(
      { debridgeId: "0xfam", buyChainId: 42161, sellChainId: 56, tierUsd: 10000, kind: "redemption" },
      d
    );
    expect(opportunity!.edge.profitable).toBe(false);
    expect(opportunity!.verification).toBeNull();
    expect(verifyCalls).toBe(0);
  });

  const route = { debridgeId: "0xfam", buyChainId: 42161, sellChainId: 56, tierUsd: 10000, kind: "redemption" as const };

  it("reports live:true when both legs quote", async () => {
    const r = await scanUnit(route, deps());
    expect(r.live).toBe(true);
    expect(r.opportunity).not.toBeNull();
  });

  it("reports live:false (no opportunity) when a leg has no route (amountOut 0)", async () => {
    const r = await scanUnit(route, deps({ fetchQuote: async () => quote({ amountOut: "0" }) }));
    expect(r.live).toBe(false);
    expect(r.opportunity).toBeNull();
  });

  it("reports live:false when a quote throws (dead pool / aggregator 500) without propagating", async () => {
    const r = await scanUnit(
      route,
      deps({
        fetchQuote: async () => {
          throw new Error("estimation 500 for chain");
        },
      })
    );
    expect(r.live).toBe(false);
    expect(r.opportunity).toBeNull();
  });

  it("classifies a 5xx/429 quote failure as TRANSIENT (so it gets a short backoff, not a 6h demote)", async () => {
    const r500 = await scanUnit(route, deps({ fetchQuote: async () => { throw new QuoteHttpError(500); } }));
    expect(r500.live).toBe(false);
    expect(r500.transient).toBe(true);
    const r429 = await scanUnit(route, deps({ fetchQuote: async () => { throw new QuoteHttpError(429); } }));
    expect(r429.transient).toBe(true);
  });

  it("classifies a permanent no-route as NOT transient (amountOut 0, or a 4xx like TOKEN_PAIR_NOT_TRADABLE)", async () => {
    const rZero = await scanUnit(route, deps({ fetchQuote: async () => quote({ amountOut: "0" }) }));
    expect(rZero.live).toBe(false);
    expect(rZero.transient).toBe(false);
    const r400 = await scanUnit(route, deps({ fetchQuote: async () => { throw new QuoteHttpError(400); } }));
    expect(r400.live).toBe(false);
    expect(r400.transient).toBe(false);
  });

  it("rescales the bridged amount across a decimal delta before the sell leg (buy 8-dec → sell 18-dec)", async () => {
    // An 18-dec native with an 8-dec deAsset (the deBridge deToken case). The dePort move is 1:1 by VALUE,
    // so the 8-dec buy output must be scaled up by 10^10 before the 18-dec sell leg.
    const crossFam = fam({
      nativeChainId: 56,
      nativeAddress: "0xnative",
      decimals: 18,
      reps: [
        { internalChainId: 56, address: "0xnative", isNativeRoot: true, decimals: 18 },
        { internalChainId: 42161, address: "0xdeasset", isNativeRoot: false, decimals: 8 },
      ],
    });
    const sellAmountsIn: string[] = [];
    const d = deps({
      getFamily: () => crossFam,
      fetchQuote: async (_chainId, _tokenIn, tokenOut, amountIn) => {
        const isBuy = tokenOut === "0xdeasset"; // buy leg acquires the 8-dec deAsset
        if (!isBuy) sellAmountsIn.push(amountIn);
        return isBuy
          ? quote({ amountOut: "100000000", amountInUsd: 1000, amountOutUsd: 1000 }) // 1.0 token @ 8 decimals
          : quote({ amountOut: "1005000000", amountInUsd: 1005, amountOutUsd: 1005 });
      },
    });
    const { opportunity } = await scanUnit(
      { debridgeId: "0xfam", buyChainId: 42161, sellChainId: 56, tierUsd: 1000, kind: "redemption" },
      d
    );
    expect(sellAmountsIn).toEqual(["1000000000000000000"]); // 1e8 (8dp) → 1e18 (18dp)
    expect(opportunity).not.toBeNull();
  });

  const simResult: SimulationResult = {
    executable: true,
    buy: { status: "pass" },
    sell: { status: "pass" },
    send: { status: "skipped" },
    claim: { status: "pass" },
    simulatedAt: 0,
  };

  it("attaches simulation to a profitable opportunity when ARB_SIMULATE=true and deps.simulate is set", async () => {
    const prev = process.env.ARB_SIMULATE;
    process.env.ARB_SIMULATE = "true";
    try {
      let simCalls = 0;
      const d = deps({
        simulate: async () => {
          simCalls++;
          return simResult;
        },
      });
      const { opportunity } = await scanUnit(route, d);
      expect(simCalls).toBe(1);
      expect(opportunity!.simulation).toEqual(simResult);
    } finally {
      if (prev === undefined) delete process.env.ARB_SIMULATE;
      else process.env.ARB_SIMULATE = prev;
    }
  });

  it("does NOT call deps.simulate or attach simulation when ARB_SIMULATE is off", async () => {
    const prev = process.env.ARB_SIMULATE;
    delete process.env.ARB_SIMULATE;
    try {
      let simCalls = 0;
      const d = deps({
        simulate: async () => {
          simCalls++;
          return simResult;
        },
      });
      const { opportunity } = await scanUnit(route, d);
      expect(simCalls).toBe(0);
      expect(opportunity!.simulation).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ARB_SIMULATE;
      else process.env.ARB_SIMULATE = prev;
    }
  });
});

describe("seedQueue (best-row hot warm-start, 4b)", () => {
  const mkOpp = (id: string, gross: number): Opportunity => ({
    id,
    debridgeId: "0xfam",
    kind: "redemption",
    buyChainId: 42161,
    sellChainId: 56,
    nativeChainId: 56,
    tierUsd: 100,
    edge: {
      grossSpreadPct: gross,
      dexImpactBuyBps: 0,
      dexImpactSellBps: 0,
      deportFeeUsd: 0,
      gasBuyUsd: 0,
      gasSellUsd: 0,
      netUsd: 0,
      netEdgePct: 0,
      netUsdConservative: 0,
      profitable: false,
    },
    verification: null,
    lockPath: [],
    computedAt: Date.now(),
  });

  it("warms ONLY each token's best-spread row to the hot lane (not every proven rung)", async () => {
    const store = new MemoryStore();
    // Two proven rungs of the same token; the tier-100 rep->home row has the higher gross spread.
    await store.upsertOpportunities([
      mkOpp("0xfam:42161:56:10:redemption", 0.2),
      mkOpp("0xfam:42161:56:100:redemption", 1.5), // best row per token
    ]);
    await seedQueue(store, graphOf([fam({})]), [10, 100]);
    // The best row is the sole priority-1 (hot) unit → it's dequeued first over the priority-0 rungs.
    expect(await store.dequeue(1)).toEqual([
      { debridgeId: "0xfam", buyChainId: 42161, sellChainId: 56, tierUsd: 100, kind: "redemption" },
    ]);
  });
});

describe("routeKeyOfId (warm-start spans ladder rungs)", () => {
  it("drops the tier so every rung of a route shares one key", () => {
    expect(routeKeyOfId("0xfam:42161:56:25:redemption")).toBe("0xfam:42161:56:redemption");
    expect(routeKeyOfId("0xfam:42161:56:1000:redemption")).toBe("0xfam:42161:56:redemption");
    // a route proven at the OLD $1000 rung now matches its NEW micro-ladder rungs (the orphan-warm-start fix)
    expect(routeKeyOfId("0xfam:42161:56:1000:redemption")).toBe(routeKeyOfId("0xfam:42161:56:10:redemption"));
    // distinct routes (direction / chains) stay distinct
    expect(routeKeyOfId("0xfam:56:42161:25:redemption")).not.toBe(routeKeyOfId("0xfam:42161:56:25:redemption"));
  });
});

describe("runBatch", () => {
  it("drains the queue within budget and persists opportunities", async () => {
    const store = new MemoryStore();
    const family = fam({});
    await store.enqueue(enumerateUnits(graphOf([family]), [10000]));
    const budget = new RpmBudget(100, 0);
    const run = await runBatch(8, {
      getFamily: () => family,
      fetchQuote: async (_c, _tokenIn, tokenOut) =>
        tokenOut === "0xdeasset"
          ? quote({ amountOut: "100", amountInUsd: 10000, amountOutUsd: 10000 })
          : quote({ amountOut: "10090000000", amountInUsd: 10090, amountOutUsd: 10090 }),
      getFeeUsd: async () => 4,
      verify: async () => ({ verified: true, sourcesAgreed: ["debridge", "kyberswap"], quoteDisagreementBps: 10, liquidityUsd: 5_000_000 }),
      store,
      budget,
    });
    // both directions are enqueued; only the rep->home direction is profitable in this fixture
    expect(run.unitsProcessed).toBe(2);
    expect(run.quotesSpent).toBe(4);
    expect(run.opportunitiesFound).toBe(1);
    const { total } = await store.topOpportunities({});
    expect(total).toBe(2);
  });

  it("processes nothing when the budget is exhausted", async () => {
    const store = new MemoryStore();
    await store.enqueue(enumerateUnits(graphOf([fam({})]), [10000]));
    const budget = new RpmBudget(1, 0); // < 2 tokens, can't afford a unit
    const run = await runBatch(8, {
      getFamily: () => fam({}),
      fetchQuote: async () => quote({}),
      getFeeUsd: async () => 0,
      verify: async () => ({ verified: false, sourcesAgreed: [], quoteDisagreementBps: null, liquidityUsd: null }),
      store,
      budget,
    });
    expect(run.unitsProcessed).toBe(0);
  });

  it("refunds reserved-but-unspent budget when units cost fewer than 2 quotes", async () => {
    const store = new MemoryStore();
    await store.enqueue(enumerateUnits(graphOf([fam({})]), [10000]));
    const budget = new RpmBudget(100, 0);
    const run = await runBatch(8, {
      getFamily: () => undefined, // every unit guard-bails at the family lookup → 0 quotes spent
      fetchQuote: async () => quote({}),
      getFeeUsd: async () => 0,
      verify: async () => ({ verified: false, sourcesAgreed: [], quoteDisagreementBps: null, liquidityUsd: null }),
      store,
      budget,
    });
    expect(run.unitsProcessed).toBe(2);
    expect(run.quotesSpent).toBe(0);
    // reserved 2/unit = 4, spent 0 → all refunded (WITHOUT the refund this would read 96)
    expect(budget.available()).toBe(100);
  });
});

describe("parseNotionalLadder", () => {
  it("parses a comma list into a sorted, de-duped ladder of positive integers", () => {
    expect(parseNotionalLadder("10,25,50,100")).toEqual([10, 25, 50, 100]);
    expect(parseNotionalLadder("100, 25 , 25, 10")).toEqual([10, 25, 100]); // trims, de-dupes, sorts
    expect(parseNotionalLadder("2500")).toEqual([2500]); // single value (back-compat)
  });
  it("drops invalid rungs (0 / negative / fractional / non-numeric) and keeps the valid ones", () => {
    expect(parseNotionalLadder("100,abc,-5,0,2.5")).toEqual([100]);
  });
  it("falls back to the default micro ladder when nothing valid survives", () => {
    expect(parseNotionalLadder(undefined)).toEqual(DEFAULT_LADDER);
    expect(parseNotionalLadder("")).toEqual(DEFAULT_LADDER);
    expect(parseNotionalLadder("abc,-1,0,1.5")).toEqual(DEFAULT_LADDER);
  });
});
