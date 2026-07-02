import { describe, it, expect } from "vitest";
import { executeLinks } from "../arb/deep-links";
import { SOLANA_INTERNAL_ID } from "../deport/address-codec";
import type { EdgeResult, Opportunity } from "../types";

const edge: EdgeResult = {
  grossSpreadPct: 1,
  dexImpactBuyBps: 0,
  dexImpactSellBps: 0,
  deportFeeUsd: 0,
  gasBuyUsd: 0,
  gasSellUsd: 0,
  netUsd: 0,
  netEdgePct: 0,
  netUsdConservative: 0,
  profitable: false,
};

const oppOf = (buyChainId: number, sellChainId: number, buyAddr: string, sellAddr: string): Opportunity => ({
  id: "x",
  debridgeId: "0xfam",
  kind: "redemption",
  buyChainId,
  sellChainId,
  nativeChainId: sellChainId,
  tierUsd: 100,
  edge,
  verification: null,
  lockPath: [
    { chainId: buyChainId, address: buyAddr, role: "buy" },
    { chainId: sellChainId, address: sellAddr, role: "sell" },
  ],
  computedAt: 0,
});

describe("executeLinks", () => {
  it("builds a prefilled deBridge bridge link for an EVM route", () => {
    const bridge = executeLinks(oppOf(42161, 56, "0xBUY", "0xSELL")).find((l) => l.url.includes("app.debridge.finance"));
    expect(bridge?.url).toContain("inputChain=42161");
    expect(bridge?.url).toContain("outputChain=56");
    expect(bridge?.url).toContain("inputCurrency=0xBUY");
    expect(bridge?.url).toContain("outputCurrency=0xSELL");
  });

  it("orders each Kyber leg correctly: buy = USDC→token, sell = token→USDC", () => {
    const links = executeLinks(oppOf(42161, 56, "0xBUY", "0xSELL"));
    const kyber = links.filter((l) => l.url.includes("kyberswap.com/swap/"));
    expect(kyber).toHaveLength(2);
    expect(kyber[0].url).toMatch(/\/[^/]+-to-0xBUY$/); // buy: usdc -> token
    expect(kyber[1].url).toMatch(/\/0xSELL-to-[^/]+$/); // sell: token -> usdc
  });

  it("uses a Jupiter link for a Solana leg", () => {
    const links = executeLinks(oppOf(SOLANA_INTERNAL_ID, 56, "SoLmint", "0xSELL"));
    expect(links.some((l) => l.url.startsWith("https://jup.ag/swap/") && l.url.includes("SoLmint"))).toBe(true);
  });
});
