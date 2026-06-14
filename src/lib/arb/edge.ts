import type { DexQuote, EdgeResult } from "../types";

/**
 * Core executable round-trip edge (PURE).
 *
 * Model (all real, no oracle): spend USDC on the buy chain to acquire a family member, move it via
 * dePort 1:1 to the sell chain (paying `deportFeeUsd` + gas), sell it back to USDC.
 *
 *  - `buyLeg`  = USDC -> buyToken on the buy chain (amountIn is the tier in USDC units).
 *  - `sellLeg` = sellToken -> USDC on the sell chain. The caller MUST have quoted it with
 *    amountIn === buyLeg.amountOut, because dePort redemption is exactly 1:1 in raw units and all
 *    members of a family share the native token's decimals.
 *
 * Net is computed in USDC terms (≈ USD), so a deAsset trading off its peg shows up directly.
 */
export function computeEdge(buyLeg: DexQuote, sellLeg: DexQuote, deportFeeUsd: number): EdgeResult {
  const buyValueUsd = buyLeg.amountInUsd; // actual USDC spent
  const sellValueUsd = sellLeg.amountOutUsd; // USDC received on the sell chain
  const gasBuyUsd = buyLeg.gasUsd;
  const gasSellUsd = sellLeg.gasUsd;
  const costsUsd = deportFeeUsd + gasBuyUsd + gasSellUsd;

  const netUsd = sellValueUsd - buyValueUsd - costsUsd;
  const grossSpreadPct = buyValueUsd > 0 ? ((sellValueUsd - buyValueUsd) / buyValueUsd) * 100 : 0;
  const netEdgePct = buyValueUsd > 0 ? (netUsd / buyValueUsd) * 100 : 0;

  // Conservative: haircut the sell proceeds by the recommended slippage on both legs.
  const slipFrac = (buyLeg.recommendedSlippageBps + sellLeg.recommendedSlippageBps) / 10_000;
  const sellValueConservative = sellValueUsd * (1 - slipFrac);
  const netUsdConservative = sellValueConservative - buyValueUsd - costsUsd;

  return {
    grossSpreadPct,
    dexImpactBuyBps: buyLeg.priceImpactBps,
    dexImpactSellBps: sellLeg.priceImpactBps,
    deportFeeUsd,
    gasBuyUsd,
    gasSellUsd,
    netUsd,
    netEdgePct,
    netUsdConservative,
    profitable: netUsd > 0,
  };
}

/**
 * Redemption arbitrage: buy a deAsset on chainX, redeem 1:1 to the native root on its home chain,
 * sell the native for USDC. One dePort op → `deportFeeUsd` is a single chain's fixed fee.
 */
export function redemptionEdge(buyLeg: DexQuote, sellLeg: DexQuote, deportFeeUsd: number): EdgeResult {
  return computeEdge(buyLeg, sellLeg, deportFeeUsd);
}

/**
 * Cross-representation arbitrage: buy repX on chainX, route via the native hub to repY on chainY,
 * sell repY for USDC. The path crosses dePort twice → pass the summed `deportFeeUsd`.
 */
export function crossRepEdge(buyLeg: DexQuote, sellLeg: DexQuote, deportFeeUsdSum: number): EdgeResult {
  return computeEdge(buyLeg, sellLeg, deportFeeUsdSum);
}
