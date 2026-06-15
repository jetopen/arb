import { describe, it, expect } from "vitest";
import {
  verifyCandidate,
  verifySolanaCandidate,
  type VerifyArgs,
  type VerifyDeps,
  type SolanaVerifyDeps,
} from "../quotes/verify";
import { parseKyberRoute } from "../quotes/kyberswap";
import { parseLiquidityUsd, parsePriceUsd } from "../liquidity/geckoterminal";
import { SOLANA_INTERNAL_ID } from "../deport/address-codec";
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

describe("verifySolanaCandidate", () => {
  // $1k probe buying 1000 tokens (6dp) → effective price $1.00; cross-checked against GeckoTerminal spot.
  const solArgs: VerifyArgs = {
    buyChainId: SOLANA_INTERNAL_ID,
    usdcAddress: "usdc-mint",
    buyTokenAddress: "kaka-mint",
    amountInUsdcUnits: "1000000000", // 1000 * 1e6 → paidUsd = $1000
    debridgeBuyAmountOutUsd: 1000,
    tierUsd: 1000,
    buyAmountOut: "1000000000", // 1000 tokens at 6 decimals
    buyTokenDecimals: 6,
  };

  it("verifies when liquidity is deep and effective price agrees with GeckoTerminal — one GT fetch", async () => {
    let calls = 0;
    const deps: SolanaVerifyDeps = {
      getTokenStats: async () => {
        calls++;
        return { liquidityUsd: 5_000_000, priceUsd: 1.0 };
      },
    };
    const v = await verifySolanaCandidate(solArgs, deps);
    expect(v.verified).toBe(true);
    expect(v.sourcesAgreed).toEqual(["jupiter", "geckoterminal"]);
    expect(v.liquidityUsd).toBe(5_000_000);
    expect(calls).toBe(1); // reserve + price come from a SINGLE request, not two
  });

  it("rejects when the pool reserve is below the tier", async () => {
    const deps: SolanaVerifyDeps = { getTokenStats: async () => ({ liquidityUsd: 100, priceUsd: 1.0 }) };
    const v = await verifySolanaCandidate(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.rejectReason).toMatch(/liquidity/);
  });

  it("rejects when the effective price disagrees with market beyond tolerance", async () => {
    // gt spot $2 vs effective $1 → 5000bps > 1500 default tolerance
    const deps: SolanaVerifyDeps = { getTokenStats: async () => ({ liquidityUsd: 5_000_000, priceUsd: 2.0 }) };
    const v = await verifySolanaCandidate(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.quoteDisagreementBps).toBeGreaterThan(1500);
    expect(v.rejectReason).toMatch(/off/);
  });

  it("stays unverified when no GeckoTerminal price is available", async () => {
    const deps: SolanaVerifyDeps = { getTokenStats: async () => ({ liquidityUsd: 5_000_000, priceUsd: null }) };
    const v = await verifySolanaCandidate(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.sourcesAgreed).toEqual(["jupiter"]);
    expect(v.rejectReason).toMatch(/no independent/);
  });

  it("stays unverified (no throw) when the GeckoTerminal fetch fails entirely", async () => {
    const deps: SolanaVerifyDeps = { getTokenStats: async () => null };
    const v = await verifySolanaCandidate(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.liquidityUsd).toBeNull();
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

  it("parsePriceUsd reads a positive price_usd, null when absent or non-positive", () => {
    expect(parsePriceUsd({ data: { attributes: { price_usd: "1.23" } } })).toBeCloseTo(1.23, 2);
    expect(parsePriceUsd({})).toBeNull();
    expect(parsePriceUsd({ data: { attributes: { price_usd: "0" } } })).toBeNull();
    expect(parsePriceUsd({ data: { attributes: { price_usd: "-5" } } })).toBeNull();
  });
});
