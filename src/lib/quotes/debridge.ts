import type { DexQuote } from "../types";
import { fetchWithRetry } from "../api-client";

const DLN_BASE = "https://dln.debridge.finance";

interface AggregatorRoute {
  name: string;
  amount: string;
  priceDrop: number;
  approximateUsdValue: number;
}

interface EstimationResponse {
  estimation?: {
    tokenIn?: { amount?: string; approximateUsdValue?: number };
    tokenOut?: { amount?: string; approximateUsdValue?: number };
    slippage?: number;
    recommendedSlippage?: number;
    estimatedTransactionFee?: { approximateUsdValue?: number };
    comparedAggregators?: AggregatorRoute[];
  };
}

/**
 * PURE: turn a /v1.0/chain/estimation response into a DexQuote.
 * priceImpactBps is taken from the best route's `priceDrop` (percent → bps).
 */
export function parseEstimation(
  raw: EstimationResponse,
  ctx: { internalChainId: number; tokenIn: string; tokenOut: string }
): DexQuote {
  const e = raw.estimation ?? {};
  const amountIn = e.tokenIn?.amount ?? "0";
  const amountOut = e.tokenOut?.amount ?? "0";
  const aggs = e.comparedAggregators ?? [];
  // Aggregator amounts are normally integer wei strings; guard so a malformed value (decimal,
  // scientific, empty) can't throw out of this pure helper and kill the whole quote.
  const toBig = (s: string): bigint => {
    try {
      return BigInt(s);
    } catch {
      return -1n;
    }
  };
  const best = aggs.reduce<AggregatorRoute | null>(
    (acc, a) => (acc === null || toBig(a.amount) > toBig(acc.amount) ? a : acc),
    null
  );
  const slippagePct = e.recommendedSlippage ?? e.slippage ?? 0;
  return {
    internalChainId: ctx.internalChainId,
    tokenIn: ctx.tokenIn.toLowerCase(),
    tokenOut: ctx.tokenOut.toLowerCase(),
    amountIn,
    amountOut,
    amountInUsd: e.tokenIn?.approximateUsdValue ?? 0,
    amountOutUsd: e.tokenOut?.approximateUsdValue ?? 0,
    priceImpactBps: Math.max(0, (best?.priceDrop ?? 0) * 100),
    gasUsd: e.estimatedTransactionFee?.approximateUsdValue ?? 0,
    recommendedSlippageBps: slippagePct * 100,
    source: "debridge",
  };
}

/** Fetch a real, executable single-chain DEX quote from deBridge (aggregates 1inch/0x/Kyber/...). */
export async function fetchDexQuote(
  internalChainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  apiKey?: string
): Promise<DexQuote> {
  const url =
    `${DLN_BASE}/v1.0/chain/estimation?chainId=${internalChainId}` +
    `&tokenIn=${tokenIn}&tokenInAmount=${amountIn}&tokenOut=${tokenOut}`;
  const res = await fetchWithRetry(url, { method: "GET" }, { apiKey });
  if (!res.ok) throw new Error(`estimation ${res.status} for chain ${internalChainId}`);
  const json = (await res.json()) as EstimationResponse;
  return parseEstimation(json, { internalChainId, tokenIn, tokenOut });
}
