import { describe, it, expect } from "vitest";
import {
  verifyCandidate,
  verifyViaGeckoTerminal,
  type VerifyArgs,
  type VerifyDeps,
  type GeckoTerminalVerifyDeps,
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

describe("verifyViaGeckoTerminal", () => {
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
    buyQuoteSource: "jupiter",
    sellChainId: 42161,
    sellTokenAddress: "0xdekaka",
  };

  it("verifies when both legs are deep and the effective price agrees — one GT fetch per leg", async () => {
    let statsCalls = 0;
    const deps: GeckoTerminalVerifyDeps = {
      getTokenStats: async () => {
        statsCalls++;
        return { liquidityUsd: 5_000_000, priceUsd: 1.0 };
      },
    };
    const v = await verifyViaGeckoTerminal(solArgs, deps);
    expect(v.verified).toBe(true);
    expect(v.sourcesAgreed).toEqual(["jupiter", "geckoterminal"]);
    expect(v.liquidityUsd).toBe(5_000_000);
    expect(statsCalls).toBe(2); // one request per leg (buy + sell) — sell reserve from same call as sell price
  });

  it("rejects when the Solana BUY pool is below the tier", async () => {
    const deps: GeckoTerminalVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: 100, priceUsd: 1.0 }),
    };
    const v = await verifyViaGeckoTerminal(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.rejectReason).toMatch(/liquidity/);
  });

  it("rejects when the EVM SELL leg is thin even though the Solana buy pool is deep", async () => {
    const deps: GeckoTerminalVerifyDeps = {
      // chain-routed so the assertion proves the sell-leg fetch is keyed on sellChainId (42161), not buy.
      getTokenStats: async (chainId) =>
        chainId === 42161 ? { liquidityUsd: 100, priceUsd: 1.0 } : { liquidityUsd: 5_000_000, priceUsd: 1.0 },
    };
    const v = await verifyViaGeckoTerminal(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.rejectReason).toMatch(/liquidity/);
    expect(v.rejectReason).toContain("42161"); // names the offending (sell) chain
    expect(v.liquidityUsd).toBe(100); // the binding sell leg, fetched with sellChainId
  });

  it("verifies reporting the binding (min) liquidity across the Solana buy + EVM sell legs", async () => {
    const deps: GeckoTerminalVerifyDeps = {
      getTokenStats: async (chainId) => ({
        liquidityUsd: chainId === 42161 ? 2_000_000 : 5_000_000, // EVM sell leg = min
        priceUsd: 1.0,
      }),
    };
    const v = await verifyViaGeckoTerminal(solArgs, deps);
    expect(v.verified).toBe(true);
    expect(v.liquidityUsd).toBe(2_000_000); // min(buy 5M, sell 2M)
  });

  it("rejects when the effective price disagrees with market beyond tolerance", async () => {
    // gt spot $2 vs effective $1 -> 5000bps > 1500 default tolerance
    const deps: GeckoTerminalVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: 5_000_000, priceUsd: 2.0 }),
    };
    const v = await verifyViaGeckoTerminal(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.quoteDisagreementBps).toBeGreaterThan(1500);
    expect(v.rejectReason).toMatch(/off/);
  });

  it("stays unverified when no GeckoTerminal price is available", async () => {
    const deps: GeckoTerminalVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: 5_000_000, priceUsd: null }),
    };
    const v = await verifyViaGeckoTerminal(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.sourcesAgreed).toEqual(["jupiter"]);
    expect(v.rejectReason).toMatch(/no independent/);
  });

  it("stays unverified (no throw) when the GeckoTerminal fetch fails entirely", async () => {
    const deps: GeckoTerminalVerifyDeps = {
      getTokenStats: async () => null,
    };
    const v = await verifyViaGeckoTerminal(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.liquidityUsd).toBeNull();
    expect(v.rejectReason).toMatch(/liquidity/); // no reserve on either leg → no liquidity evidence
  });

  it("does NOT badge verified on a spot price alone when no pool reserve is known on either leg", async () => {
    // The egregious gate-bypass: GeckoTerminal returns a price but null reserve (common on its /tokens
    // endpoint), and the sell leg's reserve is unknown too. Price agreement must NOT alone mint a verified
    // badge — fill-feasibility needs an observed reserve.
    const deps: GeckoTerminalVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: null, priceUsd: 1.0 }), // price but no reserve on either leg
    };
    const v = await verifyViaGeckoTerminal(solArgs, deps);
    expect(v.verified).toBe(false);
    expect(v.liquidityUsd).toBeNull();
    expect(v.rejectReason).toMatch(/liquidity/);
  });

  it("rejects when the SELL leg's effective price disagrees with market (deAsset depeg on the sell side)", async () => {
    // buy leg agrees ($1 effective vs $1 spot); the SELL leg got $2000 for 1000 tokens => $2.00 effective
    // vs a $1.00 market spot — the buy-leg-only cross-check would miss this; the sell-leg check catches it.
    const args: VerifyArgs = {
      ...solArgs,
      sellAmountIn: "1000000000", // 1000 tokens @ 6dp sold
      sellTokenDecimals: 6,
      sellAmountOutUsd: 2000, // $2.00 effective
    };
    const deps: GeckoTerminalVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: 5_000_000, priceUsd: 1.0 }), // both legs deep, spot $1
    };
    const v = await verifyViaGeckoTerminal(args, deps);
    expect(v.verified).toBe(false);
    expect(v.rejectReason).toMatch(/sell price/);
  });

  it("verifies when BOTH the buy and sell legs price-agree with market", async () => {
    const args: VerifyArgs = {
      ...solArgs,
      sellAmountIn: "1000000000",
      sellTokenDecimals: 6,
      sellAmountOutUsd: 1005, // $1.005 effective ≈ $1.00 spot → within tolerance
    };
    const deps: GeckoTerminalVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: 5_000_000, priceUsd: 1.0 }),
    };
    const v = await verifyViaGeckoTerminal(args, deps);
    expect(v.verified).toBe(true);
    expect(v.sourcesAgreed).toEqual(["jupiter", "geckoterminal"]);
  });

  it("labels sourcesAgreed with the buy quote source — e.g. a deBridge-quoted Sei/Tron leg", async () => {
    // Non-Solana, non-Kyber chain (Sei): the GT fallback should credit "debridge", not "jupiter".
    const seiArgs: VerifyArgs = {
      ...solArgs,
      buyChainId: 100000027,
      buyQuoteSource: "debridge",
      buyTokenAddress: "0xseitoken",
    };
    const deps: GeckoTerminalVerifyDeps = {
      getTokenStats: async () => ({ liquidityUsd: 5_000_000, priceUsd: 1.0 }),
    };
    const v = await verifyViaGeckoTerminal(seiArgs, deps);
    expect(v.verified).toBe(true);
    expect(v.sourcesAgreed).toEqual(["debridge", "geckoterminal"]);
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
