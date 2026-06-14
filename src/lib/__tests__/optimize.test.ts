import { describe, it, expect, vi } from "vitest";
import { summarizeCurve, optimizeRoute, type SizePoint, type OptimizeDeps, type OptimizeRoute } from "../arb/optimize";
import type { DexQuote } from "../types";

const pt = (sizeUsd: number, grossPct: number, netUsd: number): SizePoint => ({
  sizeUsd,
  grossPct,
  netUsd,
  netEdgePct: (netUsd / sizeUsd) * 100,
});

describe("summarizeCurve", () => {
  it("picks the max-net$ size as best (the U-curve bottom)", () => {
    const curve = [pt(50, 0.8, -2.65), pt(100, 0.6, -2.47), pt(250, 0.0, -3.05), pt(1000, -2.7, -30.3)];
    const { best } = summarizeCurve(curve);
    expect(best?.sizeUsd).toBe(100); // least-negative net$
  });

  it("interpolates the break-even size where net crosses zero", () => {
    // net goes negative -> positive between 100 ($-2) and 250 ($+1): break-even at 100 + (2/3)*150 = 200
    const curve = [pt(50, 4, -5), pt(100, 3, -2), pt(250, 1, 1), pt(1000, -2, -30)];
    const { breakEvenSizeUsd } = summarizeCurve(curve);
    expect(breakEvenSizeUsd).toBeCloseTo(200, 0);
  });

  it("reports null break-even when never profitable (fee always dominates)", () => {
    const curve = [pt(50, 0.8, -2.65), pt(100, 0.6, -2.47), pt(1000, -2.7, -30.3)];
    expect(summarizeCurve(curve).breakEvenSizeUsd).toBeNull();
  });

  it("interpolates the largest gross-positive size", () => {
    // gross positive at 100 (+0.6), negative at 250 (-0.9): crossing at 100 + (0.6/1.5)*150 = 160
    const curve = [pt(50, 0.8, -2), pt(100, 0.6, -2), pt(250, -0.9, -7), pt(1000, -2.7, -30)];
    expect(summarizeCurve(curve).grossPositiveMaxUsd).toBeCloseTo(160, 0);
  });

  it("returns nulls for an empty curve", () => {
    expect(summarizeCurve([])).toEqual({ best: null, breakEvenSizeUsd: null, grossPositiveMaxUsd: null });
  });
});

describe("optimizeRoute", () => {
  const route: OptimizeRoute = {
    debridgeId: "0xf",
    buyChainId: 42161, // Arbitrum (has USDC base, 6 decimals)
    sellChainId: 56, // BNB
    buyToken: "0xdeasset",
    sellToken: "0xnative",
    symbol: "TKN",
  };

  function quote(over: Partial<DexQuote>): DexQuote {
    return {
      internalChainId: 0, tokenIn: "0x", tokenOut: "0x", amountIn: "0", amountOut: "0",
      amountInUsd: 0, amountOutUsd: 0, priceImpactBps: 0, gasUsd: 0, recommendedSlippageBps: 0,
      source: "debridge", ...over,
    };
  }

  it("sweeps sizes, fetches the fee once, and finds the sweet spot", async () => {
    const getFeeUsd = vi.fn(async () => 3); // flat $3 dePort fee
    // gross(size): +1% small -> -3% large (SURGE-like). net = size*gross - 3.
    const grossOf = (s: number) => (s <= 100 ? 0.01 : s <= 250 ? 0.0 : -0.03);
    const deps: OptimizeDeps = {
      getFeeUsd,
      fetchQuote: async (_c, _i, tokenOut, amountIn) => {
        if (tokenOut === route.buyToken) {
          const size = Number(BigInt(amountIn) / 1_000_000n); // USDC 6 decimals
          return quote({ amountInUsd: size, amountOut: String(size) }); // carry size forward
        }
        const size = Number(amountIn);
        return quote({ amountOutUsd: size * (1 + grossOf(size)) });
      },
    };
    const r = await optimizeRoute(route, deps, [50, 100, 250, 1000]);
    expect(getFeeUsd).toHaveBeenCalledTimes(1); // fee is size-independent
    expect(r.curve).toHaveLength(4);
    // net: 50-> -2.5, 100-> -2, 250-> -3, 1000-> -33  => best is $100
    expect(r.best?.sizeUsd).toBe(100);
    expect(r.best?.netUsd).toBeCloseTo(-2, 6);
    expect(r.breakEvenSizeUsd).toBeNull(); // fee dominates, never profitable
    expect(r.feeUsd).toBe(3);
  });

  it("drops sizes with no route and returns empty when the chain has no USDC base", async () => {
    const deps: OptimizeDeps = { getFeeUsd: async () => 1, fetchQuote: async () => quote({}) };
    const noBase = await optimizeRoute({ ...route, buyChainId: 999999 }, deps, [100]);
    expect(noBase.curve).toEqual([]);
    expect(noBase.best).toBeNull();
  });
});
