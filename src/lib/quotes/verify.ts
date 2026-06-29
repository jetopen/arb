import type { DexQuote, Verification } from "../types";
import { zeroExSupported } from "./zerox";

/** A 0x routability fallback type — used when the primary independent source (Kyber/GeckoTerminal) can't
 *  corroborate a leg (no pool indexed / no route), the MGLD false-negative class. */
type FetchAggregator = (chainId: number, tokenIn: string, tokenOut: string, amountIn: string) => Promise<DexQuote | null>;
type LegConfirm = "confirmed" | "disagrees" | "no-route" | "unsupported";

/**
 * Ask 0x to route a leg and compare its raw token output against the expected (deBridge) output. 0x aggregates
 * far more pools than GeckoTerminal indexes or KyberSwap routes, so it confirms thin deAsset reps the others
 * miss. Returns:
 *  - "confirmed"   — 0x routes it and its output is within `tolBps` (a better 0x route is fine — only a
 *                    SHORTFALL beyond tolerance counts against the quote).
 *  - "disagrees"   — 0x routes it but its output is materially below the quote (the quote is optimistic/phantom).
 *  - "no-route"    — 0x is available for this chain but found no route.
 *  - "unsupported" — no 0x key, chain not 0x-supported, or no expected output to compare against.
 */
async function confirmLegVia0x(
  fetch0x: FetchAggregator | undefined,
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  expectedAmountOut: number,
  tolBps: number
): Promise<LegConfirm> {
  if (!fetch0x || !(expectedAmountOut > 0) || !zeroExSupported(chainId)) return "unsupported";
  let q: DexQuote | null = null;
  try {
    q = await fetch0x(chainId, tokenIn, tokenOut, amountIn);
  } catch {
    q = null;
  }
  const out = q ? Number(q.amountOut) : 0;
  if (!(out > 0)) return "no-route";
  const shortfallBps = ((expectedAmountOut - out) / expectedAmountOut) * 10_000;
  return shortfallBps > tolBps ? "disagrees" : "confirmed";
}

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

/**
 * The liquidity gate's thinnest leg is below tier — the primary phantom guard. But pool indexers
 * (GeckoTerminal reserves / KyberSwap liquidity) undercount the depth 1inch/0x actually route: a token can
 * fill the full tier through a pool/hop the indexer doesn't see (the SWYCH `$3 pool` class, where deBridge's
 * 1inch-aggregated quote routes $10 that GeckoTerminal scores as a $3 reserve). Before rejecting, if the thin
 * leg is the BUY leg AND the SELL leg already cleared the tier gate, ask 0x to route the FULL TIER through the
 * buy swap (USDC→token). ONLY an affirmative full-tier route within tolerance overrides the observed thinness
 * → verified[source, 0x]. 0x unavailable / no route / shortfall (incl. no key) → return null so the caller
 * keeps the hard thin reject: observed thinness is positive evidence, so unlike the no-pool-indexed case we do
 * NOT give the benefit of the doubt — that would resurrect the very phantoms this gate exists to kill.
 *
 * A thin SELL leg is not rehab-able here: VerifyArgs carries only the buy-chain USDC, so we can't 0x-route the
 * sell swap, and a one-leg fill isn't a round-trip. Both-legs-thin likewise keeps the reject (sell uncleared).
 */
async function rehabThinBuyLegVia0x(
  args: VerifyArgs,
  fetch0x: FetchAggregator | undefined,
  zeroExTolBps: number,
  thin: { chainId: number; liquidityUsd: number },
  sellLiquidityUsd: number | null,
  tierUsd: number,
  minMult: number,
  source: string
): Promise<Verification | null> {
  const sellCleared = sellLiquidityUsd != null && sellLiquidityUsd >= tierUsd * minMult;
  if (thin.chainId !== args.buyChainId || !sellCleared) return null;
  const expectedBuyOut = args.buyAmountOut != null ? Number(args.buyAmountOut) : 0;
  const conf = await confirmLegVia0x(
    fetch0x, args.buyChainId, args.usdcAddress, args.buyTokenAddress, args.amountInUsdcUnits,
    expectedBuyOut, zeroExTolBps
  );
  if (conf === "confirmed") {
    // 0x found a full-tier route within tolerance → the indexer undercounted the real depth. Report the
    // OBSERVED-thin reserve (honest about what the pool indexer saw) while badging it verified via 0x.
    return { verified: true, sourcesAgreed: [source, "0x"], quoteDisagreementBps: null, liquidityUsd: thin.liquidityUsd };
  }
  return null;
}

export interface VerifyDeps {
  fetchKyber: (
    chainId: number,
    tokenIn: string,
    tokenOut: string,
    amountIn: string
  ) => Promise<DexQuote | null>;
  getLiquidityUsd: (chainId: number, tokenAddr: string) => Promise<number | null>;
  /** 0x aggregator quote — fallback when Kyber can't corroborate a leg (no route on a pool 1inch/0x covers
   *  but Kyber doesn't). Absent → that leg degrades to `aggregatorRoutable` instead of a hard reject. */
  fetchZeroEx?: FetchAggregator;
  /** Max allowed disagreement between deBridge and Kyber, in bps (default 200). */
  toleranceBps?: number;
  /** Max 0x-vs-quote output shortfall, in bps, before it counts as a phantom (default 500 — looser than the
   *  Kyber USD check because it's an aggregator-route vs aggregator-route token comparison). */
  zeroExToleranceBps?: number;
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
  if (gate.thinLeg) {
    // Thin BUY leg whose sell side cleared the gate: 0x-route the full tier before rejecting (SWYCH class).
    const rehab = await rehabThinBuyLegVia0x(
      args, deps.fetchZeroEx, deps.zeroExToleranceBps ?? 500, gate.thinLeg, sellLiq, args.tierUsd, minMult, "debridge"
    );
    return rehab ?? thinLegRejection(gate.thinLeg, args.tierUsd, "debridge");
  }
  const liquidityUsd = gate.liquidityUsd;

  let kyber: DexQuote | null = null;
  try {
    kyber = await deps.fetchKyber(args.buyChainId, args.usdcAddress, args.buyTokenAddress, args.amountInUsdcUnits);
  } catch {
    kyber = null;
  }

  const db = args.debridgeBuyAmountOutUsd;
  // Independent USD cross-check via Kyber — only meaningful when BOTH deBridge and Kyber priced the output.
  let kyberDisagreementBps: number | null = null;
  if (kyber && kyber.amountOutUsd > 0 && db > 0) {
    kyberDisagreementBps = (Math.abs(kyber.amountOutUsd - db) / db) * 10_000;
    if (kyberDisagreementBps <= tolerance) {
      return { verified: true, sourcesAgreed: ["debridge", "kyberswap"], quoteDisagreementBps: kyberDisagreementBps, liquidityUsd };
    }
    // Kyber disagrees — but it routes fewer pools than 1inch/0x; fall through to a 0x token-level check to tell
    // a real phantom (0x also can't match the quote) from a Kyber coverage gap, rather than reject outright.
  }

  // 0x fallback (token-level). Covers: Kyber returned no route, deBridge couldn't USD-price the output
  // (db <= 0 → the old "sources disagree Infinitybps", the MGLD case), or Kyber disagreed. Compares 0x's
  // routed output against deBridge's buy-leg output in the same (buy-token) base units.
  const expectedBuyOut = args.buyAmountOut != null ? Number(args.buyAmountOut) : 0;
  const conf = await confirmLegVia0x(
    deps.fetchZeroEx, args.buyChainId, args.usdcAddress, args.buyTokenAddress, args.amountInUsdcUnits,
    expectedBuyOut, deps.zeroExToleranceBps ?? 500
  );
  if (conf === "confirmed") {
    return { verified: true, sourcesAgreed: ["debridge", "0x"], quoteDisagreementBps: kyberDisagreementBps, liquidityUsd };
  }
  if (conf === "disagrees") {
    return { verified: false, sourcesAgreed: ["debridge", "0x"], quoteDisagreementBps: null, liquidityUsd, rejectReason: "0x output below quote" };
  }
  // 0x couldn't confirm. If Kyber ACTIVELY disagreed (routed but well off the quote), keep that as a phantom
  // reject. If Kyber merely had no route (no opinion), deBridge (=1inch) still routes it → surface as routable.
  if (kyberDisagreementBps != null) {
    return { verified: false, sourcesAgreed: ["debridge"], quoteDisagreementBps: kyberDisagreementBps, liquidityUsd, rejectReason: `sources disagree ${Math.round(kyberDisagreementBps)}bps` };
  }
  return { verified: false, aggregatorRoutable: true, sourcesAgreed: ["debridge"], quoteDisagreementBps: null, liquidityUsd };
}

export interface GeckoTerminalVerifyDeps {
  /** One GeckoTerminal token fetch → both the pool reserve (liquidity gate) and the spot price
   *  (cross-check). Called for BOTH legs so each candidate makes exactly TWO GT requests total — one per
   *  leg — rather than the previous three (buy stats + sell liquidity + sell stats). */
  getTokenStats: (chainId: number, tokenAddr: string) => Promise<{ liquidityUsd: number | null; priceUsd: number | null } | null>;
  /** 0x aggregator quote — fallback when GeckoTerminal has no pool/spot for a leg (a token 1inch/0x route
   *  but GT doesn't index). Absent or chain-unsupported → that leg degrades to `aggregatorRoutable`. */
  fetchZeroEx?: FetchAggregator;
  /** Max 0x-vs-quote output shortfall, in bps, before counting as a phantom (default 500). */
  zeroExToleranceBps?: number;
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
  if (gate.thinLeg) {
    // Thin BUY leg whose sell side cleared the gate: 0x-route the full tier before rejecting (SWYCH class).
    const rehab = await rehabThinBuyLegVia0x(
      args, deps.fetchZeroEx, deps.zeroExToleranceBps ?? 500, gate.thinLeg, sellStats?.liquidityUsd ?? null,
      args.tierUsd, minMult, source
    );
    return rehab ?? thinLegRejection(gate.thinLeg, args.tierUsd, source);
  }
  const liquidityUsd = gate.liquidityUsd;

  // When GeckoTerminal can't corroborate (no pool indexed on either leg, or no spot price), fall back to a 0x
  // token-level routability check on the buy leg before giving up: a token 1inch/0x route but GT doesn't index
  // is real-but-uncorroborated (the MGLD class), not a phantom. 0x-confirmed → verified; 0x finds it materially
  // worse → reject; 0x unavailable (non-EVM / no key) → surface as routable (hand-check), never a hard reject.
  const aggFallback = async (qdb: number | null): Promise<Verification> => {
    const expectedBuyOut =
      args.buyAmountOut != null && args.buyTokenDecimals != null ? Number(args.buyAmountOut) : 0;
    const conf = await confirmLegVia0x(
      deps.fetchZeroEx, args.buyChainId, args.usdcAddress, args.buyTokenAddress, args.amountInUsdcUnits,
      expectedBuyOut, deps.zeroExToleranceBps ?? 500
    );
    if (conf === "confirmed") return { verified: true, sourcesAgreed: [source, "0x"], quoteDisagreementBps: qdb, liquidityUsd };
    if (conf === "disagrees") return { verified: false, sourcesAgreed: [source, "0x"], quoteDisagreementBps: qdb, liquidityUsd, rejectReason: "0x output below quote" };
    return { verified: false, aggregatorRoutable: true, sourcesAgreed: [source], quoteDisagreementBps: qdb, liquidityUsd };
  };

  // A "verified" badge asserts fill-feasibility, so require at least one OBSERVED pool reserve that cleared
  // the tier gate. With no reserve known on either leg (a chain GeckoTerminal can't price — e.g. a missing
  // network slug — or a token whose response has price_usd but null total_reserve_in_usd) we have zero
  // liquidity evidence; leave it UNVERIFIED rather than badge it on a spot price alone. This closes the
  // gate-bypass where both legs' liquidity were null yet the price agreed.
  if (liquidityUsd == null) {
    // GeckoTerminal indexes no pool on either leg — try 0x before rejecting (the MGLD/deMGLD class).
    return aggFallback(null);
  }

  const gtPrice = stats?.priceUsd ?? null;
  const tokensOut =
    args.buyAmountOut != null && args.buyTokenDecimals != null
      ? Number(args.buyAmountOut) / 10 ** args.buyTokenDecimals
      : 0;
  const paidUsd = args.tierUsd;
  if (gtPrice == null || gtPrice <= 0 || tokensOut <= 0 || paidUsd <= 0) {
    // GeckoTerminal has a reserve but no usable spot price — try 0x routability before rejecting.
    return aggFallback(null);
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
