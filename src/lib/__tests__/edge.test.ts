import { describe, it, expect } from "vitest";
import { computeEdge, redemptionEdge, crossRepEdge } from "../arb/edge";
import type { DexQuote } from "../types";

function quote(over: Partial<DexQuote>): DexQuote {
  return {
    internalChainId: 1,
    tokenIn: "0xusdc",
    tokenOut: "0xtoken",
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

describe("computeEdge", () => {
  it("reports a positive edge when the sell side beats buy + costs", () => {
    const buy = quote({ amountInUsd: 10000, gasUsd: 0.5, priceImpactBps: 5 });
    const sell = quote({ amountOutUsd: 10080, gasUsd: 0.5, priceImpactBps: 7 });
    const r = computeEdge(buy, sell, 4); // $4 dePort fee
    // net = 10080 - 10000 - (4 + 0.5 + 0.5) = 75
    expect(r.netUsd).toBeCloseTo(75, 6);
    expect(r.netEdgePct).toBeCloseTo(0.75, 6);
    expect(r.grossSpreadPct).toBeCloseTo(0.8, 6);
    expect(r.profitable).toBe(true);
    expect(r.dexImpactBuyBps).toBe(5);
    expect(r.dexImpactSellBps).toBe(7);
  });

  it("goes negative once fees eat the spread", () => {
    const buy = quote({ amountInUsd: 1000, gasUsd: 1 });
    const sell = quote({ amountOutUsd: 1003, gasUsd: 1 });
    const r = computeEdge(buy, sell, 4); // net = 1003 - 1000 - 6 = -3
    expect(r.netUsd).toBeCloseTo(-3, 6);
    expect(r.profitable).toBe(false);
  });

  it("is break-even at exactly zero", () => {
    const buy = quote({ amountInUsd: 10000 });
    const sell = quote({ amountOutUsd: 10005 });
    const r = computeEdge(buy, sell, 5); // 10005 - 10000 - 5 = 0
    expect(r.netUsd).toBeCloseTo(0, 6);
    expect(r.profitable).toBe(false);
  });

  it("fee dominates a small tier (1k)", () => {
    const buy = quote({ amountInUsd: 1000 });
    const sell = quote({ amountOutUsd: 1002 });
    const r = computeEdge(buy, sell, 15); // Cronos-like fee -> net negative
    expect(r.netUsd).toBeLessThan(0);
  });

  it("conservative net applies slippage haircut to the sell proceeds", () => {
    const buy = quote({ amountInUsd: 10000, recommendedSlippageBps: 30 });
    const sell = quote({ amountOutUsd: 10100, recommendedSlippageBps: 30 });
    const r = computeEdge(buy, sell, 4);
    // optimistic net = 100 - 4 = 96; conservative haircut = 10100 * 0.006 = 60.6
    expect(r.netUsd).toBeCloseTo(96, 4);
    expect(r.netUsdConservative).toBeCloseTo(96 - 60.6, 3);
    expect(r.netUsdConservative).toBeLessThan(r.netUsd);
  });

  it("redemptionEdge and crossRepEdge are computeEdge with the right fee semantics", () => {
    const buy = quote({ amountInUsd: 10000 });
    const sell = quote({ amountOutUsd: 10100 });
    expect(redemptionEdge(buy, sell, 4).netUsd).toBeCloseTo(96, 6);
    // cross-rep crosses dePort twice -> larger fee -> smaller net
    expect(crossRepEdge(buy, sell, 8).netUsd).toBeCloseTo(92, 6);
  });
});
