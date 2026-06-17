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
  /** Buy-leg token output in raw units + its decimals (the GeckoTerminal verify computes effective price
   *  from these). */
  buyAmountOut?: string;
  buyTokenDecimals?: number;
  /** The buy leg's quote source label ("jupiter" for Solana, "debridge" otherwise) — used for the
   *  GeckoTerminal cross-check's sourcesAgreed. Defaults to "quote" when absent. */
  buyQuoteSource?: string;
  /** The SELL leg (the family member sold for USDC after the dePort move). Gated for fill-feasibility too:
   *  a round-trip is only real if BOTH pools can absorb the tier, and the thin leg can be either side
   *  (a deAsset rep, or a Solana-native pool). */
  sellChainId: number;
  sellTokenAddress: string;
  /** Sell-leg quote (optional): raw tokens sold + their decimals + the USDC value received. When present,
   *  the GeckoTerminal verify also cross-checks the SELL leg's effective price against market spot — the
   *  deAsset being sold is often the thin/depegged leg, and the buy-leg-only cross-check would miss it. */
  sellAmountIn?: string;
  sellTokenDecimals?: number;
  sellAmountOutUsd?: number;
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

export interface GeckoTerminalVerifyDeps {
  /** One GeckoTerminal token fetch → both the pool reserve (liquidity gate) and the spot price
   *  (cross-check). Called for BOTH legs so each candidate makes exactly TWO GT requests total — one per
   *  leg — rather than the previous three (buy stats + sell liquidity + sell stats). */
  getTokenStats: (chainId: number, tokenAddr: string) => Promise<{ liquidityUsd: number | null; priceUsd: number | null } | null>;
  /**
   * Max |effective price − GeckoTerminal spot| / spot, in bps. Looser than the Kyber path (200) on purpose:
   * this cross-check is a routed quote (Jupiter / deBridge aggregator) vs a SPOT price (GeckoTerminal), so
   * genuine size impact on thin pools can't be netted out — we tolerate it but still reject grossly
   * mispriced/phantom routes. Default 1500 (15%).
   */
  toleranceBps?: number;
  minLiquidityMultiple?: number;
}

/**
 * Corroborate a profitable candidate against GeckoTerminal — the cross-check for any chain KyberSwap can't
 * quote (Solana, Sei, Tron, HyperEVM, …). Mirrors verifyCandidate with GT sources:
 *  1. Liquidity gate — BOTH legs' pools must be ≥ tier (buy leg from GeckoTerminal getTokenStats, sell leg
 *     from getLiquidityUsd; either side may be EVM or non-EVM). The thin leg can be either direction.
 *  2. Cross-check — the buy quote's effective price (USD paid / tokens received) must agree with
 *     GeckoTerminal's market spot price within tolerance.
 * Missing liquidity/price or a mismatch leaves it UNVERIFIED (shown, not badged), never silently verified.
 * `paidUsd` uses the nominal tier (the buy base is a stablecoin), so this is decimals-base-agnostic.
 */
export async function verifyViaGeckoTerminal(args: VerifyArgs, deps: GeckoTerminalVerifyDeps): Promise<Verification> {
  const tolerance = deps.toleranceBps ?? 1500;
  const minMult = deps.minLiquidityMultiple ?? 1;
  const source = args.buyQuoteSource ?? "quote";

  // Fetch both legs via getTokenStats: each call returns reserve AND spot price in a single GT request,
  // so the pair needs exactly TWO requests instead of the previous three (buy stats + sell liquidity +
  // conditional sell stats). The sell reserve (liquidityUsd) is now sourced from the same response used
  // for the sell-leg price cross-check, eliminating the duplicate getLiquidityUsd call.
  const wantSellPrice =
    args.sellAmountIn != null && args.sellTokenDecimals != null && args.sellAmountOutUsd != null;
  const [stats, sellStats] = await Promise.all([
    deps.getTokenStats(args.buyChainId, args.buyTokenAddress).catch(() => null),
    deps.getTokenStats(args.sellChainId, args.sellTokenAddress).catch(() => null),
  ]);
  const gate = gateRoundTripLiquidity(
    [
      { chainId: args.buyChainId, liquidityUsd: stats?.liquidityUsd ?? null },
      { chainId: args.sellChainId, liquidityUsd: sellStats?.liquidityUsd ?? null },
    ],
    args.tierUsd,
    minMult
  );
  if (gate.thinLeg) return thinLegRejection(gate.thinLeg, args.tierUsd, source);
  const liquidityUsd = gate.liquidityUsd;

  // A "verified" badge asserts fill-feasibility, so require at least one OBSERVED pool reserve that cleared
  // the tier gate. With no reserve known on either leg (a chain GeckoTerminal can't price — e.g. a missing
  // network slug — or a token whose response has price_usd but null total_reserve_in_usd) we have zero
  // liquidity evidence; leave it UNVERIFIED rather than badge it on a spot price alone. This closes the
  // gate-bypass where both legs' liquidity were null yet the price agreed.
  if (liquidityUsd == null) {
    return {
      verified: false,
      sourcesAgreed: [source],
      quoteDisagreementBps: null,
      liquidityUsd: null,
      rejectReason: "no liquidity evidence on either leg",
    };
  }

  const gtPrice = stats?.priceUsd ?? null;
  const tokensOut =
    args.buyAmountOut != null && args.buyTokenDecimals != null
      ? Number(args.buyAmountOut) / 10 ** args.buyTokenDecimals
      : 0;
  const paidUsd = args.tierUsd;
  if (gtPrice == null || gtPrice <= 0 || tokensOut <= 0 || paidUsd <= 0) {
    return {
      verified: false,
      sourcesAgreed: [source],
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
      sourcesAgreed: [source],
      quoteDisagreementBps: disagreementBps,
      liquidityUsd,
      rejectReason: `price vs market off ${Math.round(disagreementBps)}bps`,
    };
  }

  // Sell-leg cross-check: the deAsset being SOLD is often the thin/depegged leg (the home->rep direction),
  // and the buy-leg cross-check above can't catch it. When a sell quote + a sell-leg GT spot are available,
  // require the sell effective price (USDC received / tokens sold) to agree with market within tolerance.
  if (wantSellPrice && sellStats?.priceUsd != null && sellStats.priceUsd > 0) {
    const tokensSold = Number(args.sellAmountIn) / 10 ** (args.sellTokenDecimals as number);
    if (tokensSold > 0) {
      const sellEffective = (args.sellAmountOutUsd as number) / tokensSold;
      const sellBps = (Math.abs(sellEffective - sellStats.priceUsd) / sellStats.priceUsd) * 10_000;
      if (sellBps > tolerance) {
        return {
          verified: false,
          sourcesAgreed: [source],
          quoteDisagreementBps: sellBps,
          liquidityUsd,
          rejectReason: `sell price vs market off ${Math.round(sellBps)}bps`,
        };
      }
    }
  }

  return {
    verified: true,
    sourcesAgreed: [source, "geckoterminal"],
    quoteDisagreementBps: disagreementBps,
    liquidityUsd,
  };
}
