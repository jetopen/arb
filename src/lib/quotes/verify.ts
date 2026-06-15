import type { DexQuote, Verification } from "../types";

export interface VerifyArgs {
  buyChainId: number;
  usdcAddress: string;
  /** the family member being bought (the less-liquid leg we gate on). */
  buyTokenAddress: string;
  amountInUsdcUnits: string;
  /** deBridge's buy-leg output value in USD (what we cross-check against). */
  debridgeBuyAmountOutUsd: number;
  tierUsd: number;
  /** Buy-leg token output in raw units + its decimals (Solana verify computes effective price from these). */
  buyAmountOut?: string;
  buyTokenDecimals?: number;
}

export interface VerifyDeps {
  fetchKyber: (
    chainId: number,
    tokenIn: string,
    tokenOut: string,
    amountIn: string
  ) => Promise<DexQuote | null>;
  getLiquidityUsd: (chainId: number, tokenAddr: string) => Promise<number | null>;
  /** Max allowed disagreement between deBridge and Kyber, in bps (default 200). */
  toleranceBps?: number;
  /** Pool reserve must be ≥ tier × this multiple (default 1). */
  minLiquidityMultiple?: number;
}

/**
 * Independently corroborate a profitable candidate before listing it:
 *  1. Liquidity gate — reject when pool reserve < tier (the dominant false positive: a quote that
 *     can't actually be filled at that size).
 *  2. Cross-check — require a second source (KyberSwap) to agree within tolerance.
 * A null liquidity / unavailable cross-check leaves it UNVERIFIED (shown, but not badged), never
 * silently treated as verified.
 */
export async function verifyCandidate(args: VerifyArgs, deps: VerifyDeps): Promise<Verification> {
  const tolerance = deps.toleranceBps ?? 200;
  const minMult = deps.minLiquidityMultiple ?? 1;

  let liquidityUsd: number | null = null;
  try {
    liquidityUsd = await deps.getLiquidityUsd(args.buyChainId, args.buyTokenAddress);
  } catch {
    liquidityUsd = null;
  }
  if (liquidityUsd != null && liquidityUsd < args.tierUsd * minMult) {
    return {
      verified: false,
      sourcesAgreed: ["debridge"],
      quoteDisagreementBps: null,
      liquidityUsd,
      rejectReason: `liquidity $${Math.round(liquidityUsd)} < tier $${args.tierUsd}`,
    };
  }

  let kyber: DexQuote | null = null;
  try {
    kyber = await deps.fetchKyber(args.buyChainId, args.usdcAddress, args.buyTokenAddress, args.amountInUsdcUnits);
  } catch {
    kyber = null;
  }
  if (!kyber || kyber.amountOutUsd <= 0) {
    return {
      verified: false,
      sourcesAgreed: ["debridge"],
      quoteDisagreementBps: null,
      liquidityUsd,
      rejectReason: "no independent cross-check available",
    };
  }

  const db = args.debridgeBuyAmountOutUsd;
  const disagreementBps = db > 0 ? (Math.abs(kyber.amountOutUsd - db) / db) * 10_000 : Infinity;
  if (disagreementBps > tolerance) {
    return {
      verified: false,
      sourcesAgreed: ["debridge"],
      quoteDisagreementBps: disagreementBps,
      liquidityUsd,
      rejectReason: `sources disagree ${Math.round(disagreementBps)}bps`,
    };
  }

  return {
    verified: true,
    sourcesAgreed: ["debridge", "kyberswap"],
    quoteDisagreementBps: disagreementBps,
    liquidityUsd,
  };
}

export interface SolanaVerifyDeps {
  /** One GeckoTerminal token fetch → both the pool reserve (liquidity gate) and the spot price
   *  (cross-check). Combined so each candidate makes ONE GT request, not two identical ones. */
  getTokenStats: (chainId: number, tokenAddr: string) => Promise<{ liquidityUsd: number | null; priceUsd: number | null } | null>;
  /**
   * Max |effective price − GeckoTerminal spot| / spot, in bps. Looser than the EVM path (200) on purpose:
   * the Solana cross-check is a routed quote (Jupiter) vs a SPOT price (GeckoTerminal), so genuine size
   * impact on thin pools can't be netted out — we tolerate it but still reject grossly mispriced/phantom
   * routes. Default 1500 (15%).
   */
  toleranceBps?: number;
  minLiquidityMultiple?: number;
}

/**
 * Corroborate a profitable Solana-leg candidate, mirroring verifyCandidate with Solana sources:
 *  1. Liquidity gate — GeckoTerminal pool reserve must be ≥ tier.
 *  2. Cross-check — Jupiter's effective buy price (USDC paid / tokens received) must agree with
 *     GeckoTerminal's market spot price within tolerance.
 * Missing liquidity/price or a mismatch leaves it UNVERIFIED (shown, not badged), never silently verified.
 */
export async function verifySolanaCandidate(args: VerifyArgs, deps: SolanaVerifyDeps): Promise<Verification> {
  const tolerance = deps.toleranceBps ?? 1500;
  const minMult = deps.minLiquidityMultiple ?? 1;

  // Single GeckoTerminal fetch supplies both the reserve and the spot price.
  let stats: { liquidityUsd: number | null; priceUsd: number | null } | null = null;
  try {
    stats = await deps.getTokenStats(args.buyChainId, args.buyTokenAddress);
  } catch {
    stats = null;
  }
  const liquidityUsd = stats?.liquidityUsd ?? null;
  if (liquidityUsd != null && liquidityUsd < args.tierUsd * minMult) {
    return {
      verified: false,
      sourcesAgreed: ["jupiter"],
      quoteDisagreementBps: null,
      liquidityUsd,
      rejectReason: `liquidity $${Math.round(liquidityUsd)} < tier $${args.tierUsd}`,
    };
  }

  const gtPrice = stats?.priceUsd ?? null;
  const tokensOut =
    args.buyAmountOut != null && args.buyTokenDecimals != null
      ? Number(args.buyAmountOut) / 10 ** args.buyTokenDecimals
      : 0;
  const paidUsd = args.amountInUsdcUnits ? Number(args.amountInUsdcUnits) / 1e6 : args.tierUsd;
  if (gtPrice == null || gtPrice <= 0 || tokensOut <= 0 || paidUsd <= 0) {
    return {
      verified: false,
      sourcesAgreed: ["jupiter"],
      quoteDisagreementBps: null,
      liquidityUsd,
      rejectReason: "no independent cross-check available",
    };
  }
  const effectivePrice = paidUsd / tokensOut;
  const disagreementBps = (Math.abs(effectivePrice - gtPrice) / gtPrice) * 10_000;
  if (disagreementBps > tolerance) {
    return {
      verified: false,
      sourcesAgreed: ["jupiter"],
      quoteDisagreementBps: disagreementBps,
      liquidityUsd,
      rejectReason: `price vs market off ${Math.round(disagreementBps)}bps`,
    };
  }
  return {
    verified: true,
    sourcesAgreed: ["jupiter", "geckoterminal"],
    quoteDisagreementBps: disagreementBps,
    liquidityUsd,
  };
}
