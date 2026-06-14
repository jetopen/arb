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
