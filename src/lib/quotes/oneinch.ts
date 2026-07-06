import type { DexQuote } from "../types";
import { fetchWithRetry } from "../api-client";
import { internalToEvmChainId } from "../deport/registry";

/**
 * 1inch Swap API (v6.1) routability quote — backtest-gated: currently used ONLY by
 * scripts/backtest-1inch-liveness.mts to measure whether 1inch routes any dead dePort rep that
 * deBridge/0x cannot (the MGLD/GRASS class). NOT wired into the live scan/verify paths — the free
 * tier is ~1 RPS, unfit for the scan loop unless the backtest proves recovery (see plan).
 *
 * Needs `ONEINCH_API_KEY` (portal.1inch.dev); absent it we return null. Supported EVM chains only.
 */
const ONEINCH_CHAINS = new Set<number>([
  1, // Ethereum
  10, // Optimism
  56, // BNB Chain
  137, // Polygon
  8453, // Base
  42161, // Arbitrum
  43114, // Avalanche
  59144, // Linea
]);

/** True when 1inch can quote this internal chain (key present + 1inch supports its EVM chain id). */
export function oneInchSupported(internalChainId: number): boolean {
  return !!process.env.ONEINCH_API_KEY && ONEINCH_CHAINS.has(internalToEvmChainId(internalChainId));
}

/** Free-tier throttle (~1 RPS): timestamp-based min-interval, same shape as jupiter.ts. Clamped so a
 *  stray 0 / negative / non-numeric ONEINCH_RPS can't collapse the throttle and burst the API. */
const RPS_RAW = Number(process.env.ONEINCH_RPS);
const RPS = Number.isFinite(RPS_RAW) && RPS_RAW > 0 ? RPS_RAW : 1;
const MIN_INTERVAL_MS = Math.max(1, Math.round(1000 / RPS));

let lastResolve = 0;
function throttle(): Promise<void> {
  const now = Date.now();
  const delay = Math.max(0, lastResolve + MIN_INTERVAL_MS - now);
  lastResolve = now + delay;
  return new Promise<void>((res) => setTimeout(res, delay));
}

interface OneInchQuoteResponse {
  dstAmount?: string;
}

/** PURE: 1inch v6 quote response -> DexQuote. USD/impact/gas aren't returned by the quote endpoint, so
 *  callers compare the raw `amountOut` (base units of tokenOut) against the expected output instead. */
export function parseOneInchQuote(
  raw: OneInchQuoteResponse,
  ctx: { internalChainId: number; tokenIn: string; tokenOut: string; amountIn: string }
): DexQuote | null {
  const amountOut = raw.dstAmount ?? "0";
  if (!amountOut || amountOut === "0") return null;
  return {
    internalChainId: ctx.internalChainId,
    tokenIn: ctx.tokenIn.toLowerCase(),
    tokenOut: ctx.tokenOut.toLowerCase(),
    amountIn: ctx.amountIn,
    amountOut,
    amountInUsd: 0, // not returned by the v6 quote endpoint
    amountOutUsd: 0,
    priceImpactBps: 0,
    gasUsd: 0,
    recommendedSlippageBps: 0,
    source: "1inch",
  };
}

/** Fetch an independent 1inch (v6.1) quote. Returns null on: no API key, unsupported chain, no route
 *  (HTTP 400), or error. Throttled to ONEINCH_RPS (default 1) for the free tier. */
export async function fetchOneInchQuote(
  internalChainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string
): Promise<DexQuote | null> {
  const key = process.env.ONEINCH_API_KEY;
  if (!key) return null;
  const chainId = internalToEvmChainId(internalChainId);
  if (!ONEINCH_CHAINS.has(chainId)) return null;
  const url =
    `https://api.1inch.dev/swap/v6.1/${chainId}/quote` +
    `?src=${tokenIn}&dst=${tokenOut}&amount=${amountIn}`;
  try {
    await throttle();
    const res = await fetchWithRetry(
      url,
      { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
      { maxRetries: 1 }
    );
    if (!res.ok) return null; // 400 = no route / not-a-token; other statuses treated the same (best-effort)
    const json = (await res.json()) as OneInchQuoteResponse;
    return parseOneInchQuote(json, { internalChainId, tokenIn, tokenOut, amountIn });
  } catch {
    return null;
  }
}
