import { describe, it, expect } from "vitest";
import { enumerateUnits, scanUnit, runBatch, parseNotional, type ScanDeps } from "../arb/scanner";
import { MemoryStore } from "../db/store";
import { RpmBudget } from "../arb/budget";
import type { DexQuote, Family, LockGraph } from "../types";
import type { VerifyArgs } from "../quotes/verify";

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

  it("emits a single probe size per route by default (2 units/route: both directions)", () => {
    const units = enumerateUnits(graphOf([fam({})]));
    expect(units).toHaveLength(2); // 1 rep × 1 probe size × 2 directions
  });

  it("skips families whose home chain has no USDC base (non-quotable)", () => {
    // Tron (internal id 100000026) has no USDC base in BASE_USDC → not quotable → skipped.
    const tronHome = fam({ nativeChainId: 100000026, nativeOnHomeChain: false });
    expect(enumerateUnits(graphOf([tronHome]), [1000])).toHaveLength(0);
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

  it("skips reps with unknown or mismatched decimals (the 1:1 raw move would be unsafe)", () => {
    // rep decimals differ from the native root → mis-scaled sell leg → skip
    const mismatched = fam({
      reps: [
        { internalChainId: 56, address: "0xnative", isNativeRoot: true, decimals: 18 },
        { internalChainId: 42161, address: "0xdeasset", isNativeRoot: false, decimals: 6 },
      ],
    });
    expect(enumerateUnits(graphOf([mismatched]), [1000])).toHaveLength(0);

    // rep decimals unknown (forward-found, ERC20 read failed) → skip
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
});

describe("parseNotional", () => {
  it("returns a positive integer, falling back to $1k for 0 / negative / fractional / non-numeric", () => {
    expect(parseNotional("2500")).toBe(2500);
    expect(parseNotional(undefined)).toBe(1000);
    expect(parseNotional("0")).toBe(1000);
    expect(parseNotional("-100")).toBe(1000);
    expect(parseNotional("1000.5")).toBe(1000);
    expect(parseNotional("abc")).toBe(1000);
  });
});
