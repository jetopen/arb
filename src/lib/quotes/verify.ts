import type { DexQuote, Verification } from "../types";

export interface VerifyArgs {
  buyChainId: number;
  usdcAddress: string;
  /** the family member being bought on the buy chain. */
  buyTokenAddress: string;
  amountInUsdcUnits: string;
  /** deBridge's buy-leg output value in USD (what we cross-check against). */
  debridgeBuyAmountOutUsd: number;
  tierUsd: number;
  /** Buy-leg token output in raw units + its decimals (Solana verify computes effective price from these). */
  buyAmountOut?: string;
  buyTokenDecimals?: number;
  /** The SELL leg (the family member sold for USDC after the dePort move). Gated for fill-feasibility too:
   *  a round-trip is only real if BOTH pools can absorb the tier, and the thin leg can be either side
   *  (a deAsset rep, or a Solana-native pool). */
  sellChainId: number;
  sellTokenAddress: string;
}

/** One leg's observed liquidity (null = unknown — not a rejection). */
interface LegLiquidity {
  chainId: number;
  liquidityUsd: number | null;
}

/** Look up a leg's pool reserve, swallowing transport errors to null (unknown, never a hard failure). */
async function legLiquidity(
  get: (chainId: number, tokenAddr: string) => Promise<number | null>,
  chainId: number,
  tokenAddr: string
): Promise<number | null> {
  try {
    return await get(chainId, tokenAddr);
  } catch {
    return null;
  }
}

/**
 * PURE: liquidity-gate a round-trip over BOTH legs. A redemption is only fillable if EACH leg's pool can
 * absorb the tier, so the thin leg can be either side (the deAsset rep, or a Solana-native pool). An
 * unknown (null) leg liquidity is NOT a rejection — left UNVERIFIED, mirroring the prior buy-leg-only
 * behavior. The binding constraint is the THINNEST known leg, so both the reported liquidity and the
 * rejected-leg attribution refer to that same (minimum) leg — including when BOTH legs are below tier.
 */
function gateRoundTripLiquidity(
  legs: LegLiquidity[],
  tierUsd: number,
  minMult: number
): { liquidityUsd: number | null; thinLeg: { chainId: number; liquidityUsd: number } | null } {
  let minLeg: { chainId: number; liquidityUsd: number } | null = null;
  for (const leg of legs) {
    if (leg.liquidityUsd == null) continue;
    if (minLeg == null || leg.liquidityUsd < minLeg.liquidityUsd) {
      minLeg = { chainId: leg.chainId, liquidityUsd: leg.liquidityUsd };
    }
  }
  const thinLeg = minLeg != null && minLeg.liquidityUsd < tierUsd * minMult ? minLeg : null;
  return { liquidityUsd: minLeg?.liquidityUsd ?? null, thinLeg };
}

/** Shared reject shape for a too-thin leg, naming the offending chain. */
function thinLegRejection(
  thin: { chainId: number; liquidityUsd: number },
  tierUsd: number,
  source: string
): Verification {
  return {
    verified: false,
    sourcesAgreed: [source],
    quoteDisagreementBps: null,
    liquidityUsd: thin.liquidityUsd,
    rejectReason: `liquidity $${Math.round(thin.liquidityUsd)} on chain ${thin.chainId} < tier $${tierUsd}`,
  };
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
 *  1. Liquidity gate — reject when EITHER leg's pool reserve < tier (the dominant false positive: a quote
 *     that can't actually be filled at that size). Both legs are gated because the realizable proceeds
 *     depend on the sell side too, and the thin leg can be either direction.
 *  2. Cross-check — require a second source (KyberSwap) to agree with the buy quote within tolerance.
 * A null liquidity / unavailable cross-check leaves it UNVERIFIED (shown, but not badged), never
 * silently treated as verified.
 */
export async function verifyCandidate(args: VerifyArgs, deps: VerifyDeps): Promise<Verification> {
  const tolerance = deps.toleranceBps ?? 200;
  const minMult = deps.minLiquidityMultiple ?? 1;

  const [buyLiq, sellLiq] = await Promise.all([
    legLiquidity(deps.getLiquidityUsd, args.buyChainId, args.buyTokenAddress),
    legLiquidity(deps.getLiquidityUsd, args.sellChainId, args.sellTokenAddress),
  ]);
  const gate = gateRoundTripLiquidity(
    [
      { chainId: args.buyChainId, liquidityUsd: buyLiq },
      { chainId: args.sellChainId, liquidityUsd: sellLiq },
    ],
    args.tierUsd,
    minMult
  );
  if (gate.thinLeg) return thinLegRejection(gate.thinLeg, args.tierUsd, "debridge");
  const liquidityUsd = gate.liquidityUsd;

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
   *  (cross-check) for the BUY leg. Combined so each candidate makes ONE GT request, not two identical ones. */
  getTokenStats: (chainId: number, tokenAddr: string) => Promise<{ liquidityUsd: number | null; priceUsd: number | null } | null>;
  /** Pool reserve for the SELL leg (its chain may be EVM or Solana — GeckoTerminal covers both). Gated so
   *  an illiquid sell side can't be badged verified on the strength of a deep buy leg. */
  getLiquidityUsd: (chainId: number, tokenAddr: string) => Promise<number | null>;
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
 *  1. Liquidity gate — BOTH legs' pools must be ≥ tier (buy leg from GeckoTerminal getTokenStats, sell leg
 *     from getLiquidityUsd; the sell side may be EVM or Solana). The thin leg can be either direction.
 *  2. Cross-check — Jupiter's effective buy price (USDC paid / tokens received) must agree with
 *     GeckoTerminal's market spot price within tolerance.
 * Missing liquidity/price or a mismatch leaves it UNVERIFIED (shown, not badged), never silently verified.
 */
export async function verifySolanaCandidate(args: VerifyArgs, deps: SolanaVerifyDeps): Promise<Verification> {
  const tolerance = deps.toleranceBps ?? 1500;
  const minMult = deps.minLiquidityMultiple ?? 1;

  // Single GeckoTerminal fetch supplies the buy leg's reserve AND spot price; the sell leg needs a reserve.
  const [stats, sellLiq] = await Promise.all([
    deps.getTokenStats(args.buyChainId, args.buyTokenAddress).catch(() => null),
    legLiquidity(deps.getLiquidityUsd, args.sellChainId, args.sellTokenAddress),
  ]);
  const gate = gateRoundTripLiquidity(
    [
      { chainId: args.buyChainId, liquidityUsd: stats?.liquidityUsd ?? null },
      { chainId: args.sellChainId, liquidityUsd: sellLiq },
    ],
    args.tierUsd,
    minMult
  );
  if (gate.thinLeg) return thinLegRejection(gate.thinLeg, args.tierUsd, "jupiter");
  const liquidityUsd = gate.liquidityUsd;

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
