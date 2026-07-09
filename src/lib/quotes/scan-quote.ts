import type { DexQuote } from "../types";
import { SOLANA_INTERNAL_ID } from "../deport/address-codec";
import { baseToken } from "../arb/base-tokens";
import { fetchJupiterQuote } from "./jupiter";
import { fetchDexQuote } from "./debridge";
import { fetchKyberScanQuote, kyberSlug } from "./kyberswap";
import { fetchOneInchQuote, oneInchSupported } from "./oneinch";
import { isTransientQuoteError } from "./quote-error";

/**
 * Per-chain SCAN quote routing — the single chooser behind ScanDeps.fetchQuote / OptimizeDeps.fetchQuote
 * (previously a Solana/deBridge ternary copy-pasted at three call sites).
 *
 * Post-incident (2026-07-08, unauthenticated deBridge 429 storm) source order:
 *  - Solana → Jupiter (unchanged)
 *  - Kyber-slugged chains (the 10 high-volume ones) → KyberSwap, key-free — the PRIMARY source now
 *  - everything else (HyperEVM/Sei/Flow/Monad/MegaETH/Tron) → deBridge estimation, whose residual volume
 *    is tiny enough for the unauthenticated tier
 *  - optional last-resort rung: a Kyber TRANSIENT failure retries once through 1inch (needs
 *    ONEINCH_API_KEY; its ~1 RPS free tier rescues isolated blips, NOT storms — during a storm the
 *    transient-retry path remains the real handler)
 *
 * Kill-switches (read PER CALL so a mid-run env flip takes effect immediately, like scannableChain):
 *  ARB_SCAN_KYBER=false → deBridge for all EVM chains (full rollback, no redeploy)
 *  ARB_SCAN_1INCH_FALLBACK=false → disable the 1inch rung (also inert without ONEINCH_API_KEY)
 */

/** True when Kyber is the scan-quote source for this chain. */
export function kyberScanEnabled(internalChainId: number): boolean {
  return process.env.ARB_SCAN_KYBER !== "false" && !!kyberSlug(internalChainId);
}

function oneInchFallbackEnabled(internalChainId: number): boolean {
  return process.env.ARB_SCAN_1INCH_FALLBACK !== "false" && oneInchSupported(internalChainId);
}

/** Conservative-haircut FLOOR for sources that return no slippage recommendation (Kyber/1inch return 0,
 *  which would silently make netUsdConservative === netUsd). Clamped; default 50bps ≈ deBridge's typical
 *  recommendation for LIQUID pairs. Thin pairs get more via the route's own price impact (see below). */
function slippageFloorBps(): number {
  const raw = Number(process.env.ARB_SCAN_SLIPPAGE_FLOOR_BPS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 50;
}

/** Upper clamp so a near-dead pool's runaway impact can't produce an absurd haircut (a genuinely dead
 *  route is already filtered by amountOut "0"; this bounds the merely-very-thin ones). */
const MAX_DERIVED_SLIPPAGE_BPS = 1000;

/**
 * PURE-ish (reads env + registry): normalize a non-deBridge scan quote so the edge math sees the same
 * contract deBridge provided.
 *  (a) USD guard — every scan leg is USDC-anchored, so when a source omits USD values they're derivable
 *      oracle-free: the USDC side's USD value is just its raw amount over the chain's base decimals
 *      (PER-CHAIN: BSC's base USDC is 18-dec, most others 6). Fixes 1inch (never returns USD) and the
 *      rare Kyber response with a missing/zero routeSummary USD.
 *  (b) slippage haircut — a source that returns no recommendation gets a ROUTE-SPECIFIC one:
 *      max(floor, its own price impact), capped. deBridge (displaced primary) gave a per-route slippage;
 *      a flat floor alone was strictly LESS conservative on thin pairs, so netUsdConservative could read
 *      positive on a trade a proper haircut shows negative (the net-positive filter would wrongly pass it).
 *      Impact scales with pool thinness, so it's a sound proxy for adverse movement between quote and fill.
 */
export function normalizeScanQuote(q: DexQuote, internalChainId: number): DexQuote {
  const base = baseToken(internalChainId);
  const out = { ...q };
  if (base) {
    const baseAddr = base.address.toLowerCase();
    if (out.amountInUsd <= 0 && out.tokenIn.toLowerCase() === baseAddr) {
      out.amountInUsd = Number(out.amountIn) / 10 ** base.decimals;
    }
    if (out.amountOutUsd <= 0 && out.tokenOut.toLowerCase() === baseAddr && out.amountOut !== "0") {
      out.amountOutUsd = Number(out.amountOut) / 10 ** base.decimals;
    }
  }
  if (out.recommendedSlippageBps === 0) {
    const impact = Number.isFinite(out.priceImpactBps) ? Math.max(0, out.priceImpactBps) : 0;
    out.recommendedSlippageBps = Math.min(MAX_DERIVED_SLIPPAGE_BPS, Math.max(slippageFloorBps(), Math.round(impact)));
  }
  return out;
}

/** Build the ScanDeps/OptimizeDeps fetchQuote — one function, per-chain routing inside. */
export function makeScanQuoteFetcher(
  debridgeApiKey?: string
): (chainId: number, tokenIn: string, tokenOut: string, amountIn: string) => Promise<DexQuote> {
  return async (chainId, tokenIn, tokenOut, amountIn) => {
    if (chainId === SOLANA_INTERNAL_ID) return fetchJupiterQuote(tokenIn, tokenOut, amountIn);
    if (kyberScanEnabled(chainId)) {
      try {
        return normalizeScanQuote(await fetchKyberScanQuote(chainId, tokenIn, tokenOut, amountIn), chainId);
      } catch (e) {
        // Last-resort 1inch rung (user-opted): rescue an ISOLATED Kyber blip. Best-effort — if 1inch is
        // off/null/throws, the ORIGINAL Kyber error propagates so transient classification stays correct.
        if (isTransientQuoteError(e) && oneInchFallbackEnabled(chainId)) {
          try {
            const q = await fetchOneInchQuote(chainId, tokenIn, tokenOut, amountIn);
            if (q) return normalizeScanQuote(q, chainId);
          } catch {
            /* fall through to the original error */
          }
        }
        throw e;
      }
    }
    return fetchDexQuote(chainId, tokenIn, tokenOut, amountIn, debridgeApiKey);
  };
}
