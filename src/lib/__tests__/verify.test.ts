import { describe, it, expect } from "vitest";
import { verifyCandidate, type VerifyArgs, type VerifyDeps } from "../quotes/verify";
import { parseKyberRoute } from "../quotes/kyberswap";
import { parseLiquidityUsd } from "../liquidity/geckoterminal";
import type { DexQuote } from "../types";

const baseArgs: VerifyArgs = {
  buyChainId: 42161,
  usdcAddress: "0xusdc",
  buyTokenAddress: "0xdeasset",
  amountInUsdcUnits: "10000000000",
  debridgeBuyAmountOutUsd: 10000,
  tierUsd: 10000,
};

function kyberQuote(amountOutUsd: number): DexQuote {
  return {
    internalChainId: 42161,
    tokenIn: "0xusdc",
    tokenOut: "0xdeasset",
    amountIn: "10000000000",
    amountOut: "0",
    amountInUsd: 10000,
    amountOutUsd,
    priceImpactBps: 0,
    gasUsd: 0,
    recommendedSlippageBps: 0,
    source: "kyberswap",
  };
}

describe("verifyCandidate", () => {
  it("verifies when liquidity is deep and Kyber agrees", async () => {
    const deps: VerifyDeps = {
      getLiquidityUsd: async () => 5_000_000,
      fetchKyber: async () => kyberQuote(10010), // 10 bps off -> within tolerance
    };
    const v = await verifyCandidate(baseArgs, deps);
    expect(v.verified).toBe(true);
    expect(v.sourcesAgreed).toEqual(["debridge", "kyberswap"]);
    expect(v.liquidityUsd).toBe(5_000_000);
  });

  it("rejects when pool liquidity is below the tier (phantom fill)", async () => {
    const deps: VerifyDeps = {
      getLiquidityUsd: async () => 2_000, // < $10k tier
      fetchKyber: async () => kyberQuote(10010),
    };
    const v = await verifyCandidate(baseArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.rejectReason).toMatch(/liquidity/);
  });

  it("rejects when the two sources disagree beyond tolerance", async () => {
    const deps: VerifyDeps = {
      getLiquidityUsd: async () => 5_000_000,
      fetchKyber: async () => kyberQuote(9000), // 1000 bps off
    };
    const v = await verifyCandidate(baseArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.quoteDisagreementBps).toBeGreaterThan(200);
    expect(v.rejectReason).toMatch(/disagree/);
  });

  it("stays unverified (not rejected) when no cross-check source exists", async () => {
    const deps: VerifyDeps = {
      getLiquidityUsd: async () => null, // unknown liquidity -> not a rejection
      fetchKyber: async () => null, // e.g. HyperEVM unsupported by Kyber
    };
    const v = await verifyCandidate(baseArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.sourcesAgreed).toEqual(["debridge"]);
    expect(v.rejectReason).toMatch(/no independent/);
  });
});

describe("quote/liquidity parsers", () => {
  it("parseKyberRoute extracts amounts and derives impact", () => {
    const q = parseKyberRoute(
      { data: { routeSummary: { amountIn: "10000000000", amountInUsd: "10005", amountOut: "6", amountOutUsd: "10003", gasUsd: "0.05" } } },
      { internalChainId: 42161, tokenIn: "0xusdc", tokenOut: "0xweth" }
    );
    expect(q.amountOutUsd).toBe(10003);
    expect(q.gasUsd).toBe(0.05);
    expect(q.source).toBe("kyberswap");
  });

  it("parseLiquidityUsd reads total_reserve_in_usd, null when absent", () => {
    expect(parseLiquidityUsd({ data: { attributes: { total_reserve_in_usd: "88197044.89" } } })).toBeCloseTo(88197044.89, 2);
    expect(parseLiquidityUsd({})).toBeNull();
  });
});
