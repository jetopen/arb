import type { DexQuote } from "../types";
import { fetchWithRetry } from "../api-client";
import { internalToEvmChainId } from "../deport/registry";

/**
 * 0x Swap API (v2) routability quote — used ONLY as the verify fallback when KyberSwap/GeckoTerminal can't
 * corroborate a leg. 0x aggregates far more pools/sources (incl. RFQ/PMM) than GeckoTerminal indexes or
 * KyberSwap routes, so it confirms routability for thin deAsset reps (e.g. deMGLD) that the other
 * cross-checks miss — the MGLD false-negative class. Like deBridge's estimation, 0x aggregates 1inch/0x/etc,
 * so this confirms EXECUTABILITY (is the leg fillable at ~the quoted price), not fully-independent pricing.
 *
 * 0x v2 needs an API key (`ZEROX_API_KEY`); absent it we return null and the caller degrades to the
 * `aggregatorRoutable` badge. Supported EVM chains only.
 */
const ZEROX_CHAINS = new Set<number>([
  1, // Ethereum
  10, // Optimism
  56, // BNB Chain
  137, // Polygon
  8453, // Base
  42161, // Arbitrum
  43114, // Avalanche
  59144, // Linea
  5000, // Mantle
  534352, // Scroll
  81457, // Blast
  34443, // Mode
  130, // Unichain
]);

/** True when 0x can quote this internal chain (key present + 0x supports its EVM chain id). */
export function zeroExSupported(internalChainId: number): boolean {
  return !!process.env.ZEROX_API_KEY && ZEROX_CHAINS.has(internalToEvmChainId(internalChainId));
}

interface ZeroExPriceResponse {
  buyAmount?: string;
  sellAmount?: string;
  liquidityAvailable?: boolean;
}

/** PURE: 0x v2 price response -> DexQuote. USD fields aren't returned by the price endpoint, so callers
 *  compare the raw `amountOut` (base units of tokenOut) against the expected output instead. */
export function parseZeroExPrice(
  raw: ZeroExPriceResponse,
  ctx: { internalChainId: number; tokenIn: string; tokenOut: string; amountIn: string }
): DexQuote | null {
  if (raw.liquidityAvailable === false) return null;
  const amountOut = raw.buyAmount ?? "0";
  if (!amountOut || amountOut === "0") return null;
  return {
    internalChainId: ctx.internalChainId,
    tokenIn: ctx.tokenIn.toLowerCase(),
    tokenOut: ctx.tokenOut.toLowerCase(),
    amountIn: ctx.amountIn,
    amountOut,
    amountInUsd: 0, // not returned by the v2 price endpoint
    amountOutUsd: 0,
    priceImpactBps: 0,
    gasUsd: 0,
    recommendedSlippageBps: 0,
    source: "0x",
  };
}

/** Fetch an independent 0x (v2) quote. Returns null on: no API key, unsupported chain, no route, or error. */
export async function fetchZeroExQuote(
  internalChainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string
): Promise<DexQuote | null> {
  const key = process.env.ZEROX_API_KEY;
  if (!key) return null;
  const chainId = internalToEvmChainId(internalChainId);
  if (!ZEROX_CHAINS.has(chainId)) return null;
  const url =
    `https://api.0x.org/swap/permit2/price` +
    `?chainId=${chainId}&sellToken=${tokenIn}&buyToken=${tokenOut}&sellAmount=${amountIn}`;
  try {
    const res = await fetchWithRetry(
      url,
      { method: "GET", headers: { "0x-api-key": key, "0x-version": "v2" } },
      { maxRetries: 1 }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as ZeroExPriceResponse;
    return parseZeroExPrice(json, { internalChainId, tokenIn, tokenOut, amountIn });
  } catch {
    return null;
  }
}
