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
  sellChainId: 56,
  sellTokenAddress: "0xnative",
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
  it("verifies when both legs are deep and Kyber agrees", async () => {
    const deps: VerifyDeps = {
      getLiquidityUsd: async () => 5_000_000, // deep on both legs
      fetchKyber: async () => kyberQuote(10010), // 10 bps off -> within tolerance
    };
    const v = await verifyCandidate(baseArgs, deps);
    expect(v.verified).toBe(true);
    expect(v.sourcesAgreed).toEqual(["debridge", "kyberswap"]);
    expect(v.liquidityUsd).toBe(5_000_000);
  });

  it("verifies an asymmetric-but-both-deep route, reporting the binding (min) liquidity", async () => {
    // Both legs clear the tier; the reported liquidity must be the thinner of the two (not buy-only/max).
    const deps: VerifyDeps = {
      getLiquidityUsd: async (chainId) => (chainId === 42161 ? 8_000_000 : 2_000_000), // sell leg is the min
      fetchKyber: async () => kyberQuote(10010),
    };
    const v = await verifyCandidate(baseArgs, deps);
    expect(v.verified).toBe(true);
    expect(v.liquidityUsd).toBe(2_000_000); // min(buy 8M, sell 2M)
  });

  it("does not reject on a lone unknown (null) sell leg; reports the known (buy) leg", async () => {
    const deps: VerifyDeps = {
      getLiquidityUsd: async (chainId) => (chainId === 42161 ? 5_000_000 : null), // sell unknown
      fetchKyber: async () => kyberQuote(10010),
    };
    const v = await verifyCandidate(baseArgs, deps);
    expect(v.verified).toBe(true); // null leg is unverified-not-rejected
    expect(v.liquidityUsd).toBe(5_000_000);
  });

  it("rejects when the BUY-leg pool is below the tier (phantom fill)", async () => {
    const deps: VerifyDeps = {
      getLiquidityUsd: async (chainId) => (chainId === 42161 ? 2_000 : 5_000_000), // buy thin
      fetchKyber: async () => kyberQuote(10010),
    };
    const v = await verifyCandidate(baseArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.rejectReason).toMatch(/liquidity/);
    expect(v.rejectReason).toContain("42161"); // names the offending (buy) chain
    expect(v.liquidityUsd).toBe(2_000);
  });

  it("rejects when the SELL-leg pool is below the tier, even though the buy leg is deep", async () => {
    // The realizable-proceeds (sell) side is thin — pre-existing home->rep blind spot. Must now reject.
    const deps: VerifyDeps = {
      getLiquidityUsd: async (chainId) => (chainId === 56 ? 1_000 : 5_000_000), // sell (chain 56) thin
      fetchKyber: async () => kyberQuote(10010),
    };
    const v = await verifyCandidate(baseArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.rejectReason).toMatch(/liquidity/);
    expect(v.rejectReason).toContain("56"); // names the offending (sell) chain
    expect(v.liquidityUsd).toBe(1_000); // reports the binding (thinnest) leg
  });

  it("reports the binding (thinnest) leg when BOTH legs are below tier", async () => {
    // Regression guard: the rejection must name the true minimum leg, not just the first one iterated.
    const deps: VerifyDeps = {
      getLiquidityUsd: async (chainId) => (chainId === 42161 ? 2_000 : 500), // buy 2k, sell (56) 500 = min
      fetchKyber: async () => kyberQuote(10010),
    };
    const v = await verifyCandidate(baseArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.rejectReason).toContain("56"); // the binding leg is the sell chain (500 < 2000)
    expect(v.liquidityUsd).toBe(500);
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
      getLiquidityUsd: async () => null, // unknown liquidity on both legs -> not a rejection
      fetchKyber: async () => null, // e.g. HyperEVM unsupported by Kyber
    };
    const v = await verifyCandidate(baseArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.sourcesAgreed).toEqual(["debridge"]);
    expect(v.rejectReason).toMatch(/no independent/);
  });
});

describe("verifySolanaCandidate", () => {
  // $1k probe buying 1000 tokens (6dp) on Solana -> effective price $1.00; sell leg is an EVM deAsset.
  const solArgs: VerifyArgs = {
    buyChainId: SOLANA_INTERNAL_ID,
    usdcAddress: "usdc-mint",
    buyTokenAddress: "kaka-mint",
    amountInUsdcUnits: "1000000000", // 1000 * 1e6 -> paidUsd = $1000
    debridgeBuyAmountOutUsd: 1000,
    tierUsd: 1000,
    buyAmountOut: "1000000000", // 1000 tokens at 6 decimals
    buyTokenDecimals: 6,
    sellChainId: 42161,
    sellTokenAddress: "0xdekaka",
  };

  it("verifies when both legs are deep and the effective price agrees — one GT fetch on the buy leg", async () => {
    let statsCalls = 0;
    const deps: SolanaVerifyDeps = {
      getTokenStats: async () => {
        statsCalls++;
        return { liquidityUsd: 5_000_000, priceUsd: 1.0 };
      },
      getLiquidityUsd: async () => 5_000_000, // EVM sell leg deep
    };
    const v = await verifySolanaCandidate(solArgs, deps);
    expect(v.verified).toBe(true);
    expect(v.sourcesAgreed).toEqual(["jupiter", "geckoterminal"]);
    expect(v.liquidityUsd).toBe(5_000_000);
    expect(statsCalls).toBe(1); // buy-leg reserve + price come from a SINGLE request, not two
  });

  it("rejects when the Solana BUY pool is below the tier", async () => {
    const deps: SolanaVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: 100, priceUsd: 1.0 }),
      getLiquidityUsd: async () => 5_000_000,
    };
    const v = await verifySolanaCandidate(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.rejectReason).toMatch(/liquidity/);
  });

  it("rejects when the EVM SELL leg is thin even though the Solana buy pool is deep", async () => {
    const deps: SolanaVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: 5_000_000, priceUsd: 1.0 }),
      // chain-routed so the assertion proves the sell-leg fetch is keyed on sellChainId (42161), not buy.
      getLiquidityUsd: async (chainId) => (chainId === 42161 ? 100 : 5_000_000),
    };
    const v = await verifySolanaCandidate(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.rejectReason).toMatch(/liquidity/);
    expect(v.rejectReason).toContain("42161"); // names the offending (sell) chain
    expect(v.liquidityUsd).toBe(100); // the binding sell leg, fetched with sellChainId
  });

  it("verifies reporting the binding (min) liquidity across the Solana buy + EVM sell legs", async () => {
    const deps: SolanaVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: 5_000_000, priceUsd: 1.0 }), // Solana buy leg deep
      getLiquidityUsd: async (chainId) => (chainId === 42161 ? 2_000_000 : 0), // EVM sell leg = min
    };
    const v = await verifySolanaCandidate(solArgs, deps);
    expect(v.verified).toBe(true);
    expect(v.liquidityUsd).toBe(2_000_000); // min(buy 5M, sell 2M)
  });

  it("rejects when the effective price disagrees with market beyond tolerance", async () => {
    // gt spot $2 vs effective $1 -> 5000bps > 1500 default tolerance
    const deps: SolanaVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: 5_000_000, priceUsd: 2.0 }),
      getLiquidityUsd: async () => 5_000_000,
    };
    const v = await verifySolanaCandidate(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.quoteDisagreementBps).toBeGreaterThan(1500);
    expect(v.rejectReason).toMatch(/off/);
  });

  it("stays unverified when no GeckoTerminal price is available", async () => {
    const deps: SolanaVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: 5_000_000, priceUsd: null }),
      getLiquidityUsd: async () => 5_000_000,
    };
    const v = await verifySolanaCandidate(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.sourcesAgreed).toEqual(["jupiter"]);
    expect(v.rejectReason).toMatch(/no independent/);
  });

  it("stays unverified (no throw) when the GeckoTerminal fetch fails entirely", async () => {
    const deps: SolanaVerifyDeps = {
      getTokenStats: async () => null,
      getLiquidityUsd: async () => null,
    };
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
