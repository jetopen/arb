import type { DexQuote } from "../types";
import { fetchWithRetry } from "../api-client";

/** deBridge internal chain id -> KyberSwap aggregator chain slug. Missing => unsupported (skip cross-check). */
const KYBER_SLUG: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
  43114: "avalanche",
  59144: "linea",
  100000019: "cronos",
  100000023: "mantle",
  // HyperEVM (100000022) not supported by KyberSwap as of writing -> no cross-check there.
};

export function kyberSlug(internalChainId: number): string | undefined {
  return KYBER_SLUG[internalChainId];
}

interface KyberRouteResponse {
  data?: {
    routeSummary?: {
      amountIn?: string;
      amountInUsd?: string;
      amountOut?: string;
      amountOutUsd?: string;
      gasUsd?: string;
    };
  };
}

/** PURE: KyberSwap route response -> DexQuote (independent cross-check source). */
export function parseKyberRoute(
  raw: KyberRouteResponse,
  ctx: { internalChainId: number; tokenIn: string; tokenOut: string }
): DexQuote {
  const r = raw.data?.routeSummary ?? {};
  const amountInUsd = Number(r.amountInUsd ?? 0);
  const amountOutUsd = Number(r.amountOutUsd ?? 0);
  return {
    internalChainId: ctx.internalChainId,
    tokenIn: ctx.tokenIn.toLowerCase(),
    tokenOut: ctx.tokenOut.toLowerCase(),
    amountIn: r.amountIn ?? "0",
    amountOut: r.amountOut ?? "0",
    amountInUsd,
    amountOutUsd,
    priceImpactBps: amountInUsd > 0 ? Math.max(0, ((amountInUsd - amountOutUsd) / amountInUsd) * 10_000) : 0,
    gasUsd: Number(r.gasUsd ?? 0),
    recommendedSlippageBps: 0,
    source: "kyberswap",
  };
}

/** Fetch an independent KyberSwap quote. Returns null when the chain is unsupported or the call fails. */
export async function fetchKyberQuote(
  internalChainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string
): Promise<DexQuote | null> {
  const slug = kyberSlug(internalChainId);
  if (!slug) return null;
  const url =
    `https://aggregator-api.kyberswap.com/${slug}/api/v1/routes` +
    `?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  try {
    const res = await fetchWithRetry(url, { method: "GET" }, { maxRetries: 1 });
    if (!res.ok) return null;
    const json = (await res.json()) as KyberRouteResponse;
    if (!json.data?.routeSummary) return null;
    return parseKyberRoute(json, { internalChainId, tokenIn, tokenOut });
  } catch {
    return null;
  }
}
