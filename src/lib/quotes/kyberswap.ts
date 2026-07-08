import type { DexQuote } from "../types";
import { fetchWithRetry } from "../api-client";
import { getChainByInternalId } from "../deport/registry";
import { QuoteHttpError } from "./quote-error";

/** deBridge internal chain id -> KyberSwap aggregator chain slug (from the chain registry). Missing => no
 *  Kyber there (e.g. HyperEVM, Sei, Tron, Flow, Monad, MegaETH, Solana — those scan via deBridge and verify
 *  via GeckoTerminal). */
export function kyberSlug(internalChainId: number): string | undefined {
  return getChainByInternalId(internalChainId)?.kyberSlug;
}

/** Kyber applies a stricter (unpublished) rate limit without an x-client-id; any stable app name works —
 *  no registration. Overridable so a future whitelisted id can slot in without a code change. */
function clientId(): string {
  return process.env.ARB_KYBER_CLIENT_ID || "arb-scanner";
}

/** Burst-smoothing throttle: Kyber's real limit is unpublished, and the scan loop's concurrency can fire a
 *  dozen near-simultaneous requests into it (the exact shape that 429-stormed deBridge). Same timestamp
 *  min-interval pattern as oneinch.ts/jupiter.ts, shared by BOTH the scan adapter and the verify cross-check
 *  so all Kyber traffic draws one budget. Clamped so a garbage ARB_KYBER_RPS can't collapse the interval. */
const RPS_RAW = Number(process.env.ARB_KYBER_RPS);
const RPS = Number.isFinite(RPS_RAW) && RPS_RAW > 0 ? RPS_RAW : 5;
const MIN_INTERVAL_MS = Math.max(1, Math.round(1000 / RPS));

let lastResolve = 0;
function throttle(): Promise<void> {
  const now = Date.now();
  const delay = Math.max(0, lastResolve + MIN_INTERVAL_MS - now);
  lastResolve = now + delay;
  return new Promise<void>((res) => setTimeout(res, delay));
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

/** Shared HTTP core: throttle → GET /routes with the client-id header. Throws on network failure; returns
 *  the raw Response + parsed body (body is null when parsing fails) so each public face applies its own
 *  error semantics. */
async function fetchKyberRoute(
  slug: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: string
): Promise<{ res: Response; json: KyberRouteResponse | null }> {
  const url =
    `https://aggregator-api.kyberswap.com/${slug}/api/v1/routes` +
    `?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  await throttle();
  const res = await fetchWithRetry(
    url,
    { method: "GET", headers: { "x-client-id": clientId() } },
    { maxRetries: 1 }
  );
  let json: KyberRouteResponse | null = null;
  try {
    json = (await res.json()) as KyberRouteResponse;
  } catch {
    json = null;
  }
  return { res, json };
}

/** Fetch an independent KyberSwap quote (VERIFY face). Returns null when the chain is unsupported or the
 *  call fails for any reason — null means "no opinion", which the verify path treats as unverifiable, never
 *  as evidence a route is dead. */
export async function fetchKyberQuote(
  internalChainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string
): Promise<DexQuote | null> {
  const slug = kyberSlug(internalChainId);
  if (!slug) return null;
  try {
    const { res, json } = await fetchKyberRoute(slug, tokenIn, tokenOut, amountIn);
    if (!res.ok || !json?.data?.routeSummary) return null;
    return parseKyberRoute(json, { internalChainId, tokenIn, tokenOut });
  } catch {
    return null;
  }
}

/** Dead quote: amountOut "0" is scanUnit's no-route signal (6h dead-route demotion). */
function deadQuote(internalChainId: number, tokenIn: string, tokenOut: string, amountIn: string): DexQuote {
  return {
    internalChainId,
    tokenIn: tokenIn.toLowerCase(),
    tokenOut: tokenOut.toLowerCase(),
    amountIn,
    amountOut: "0",
    amountInUsd: 0,
    amountOutUsd: 0,
    priceImpactBps: 0,
    gasUsd: 0,
    recommendedSlippageBps: 0,
    source: "kyberswap",
  };
}

/**
 * SCAN face — matches the deBridge fetchDexQuote contract that scanUnit's transient/dead classification
 * depends on (scanner.ts catch → isTransientQuoteError):
 *  - 429/5xx → THROW QuoteHttpError (transient: 10-min retry, NOT the 6h dead-route penalty)
 *  - 4xx / ok-without-routeSummary → dead quote (amountOut "0" → genuine no-route, demote)
 *  - network/parse failure → rethrow (default-transient)
 * Never call this for a chain without a kyberSlug — that's a routing bug, so it fails loud rather than
 * silently dead-marking a scannable route.
 */
export async function fetchKyberScanQuote(
  internalChainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string
): Promise<DexQuote> {
  const slug = kyberSlug(internalChainId);
  if (!slug) throw new Error(`kyber scan quote requested for unsupported chain ${internalChainId}`);
  const { res, json } = await fetchKyberRoute(slug, tokenIn, tokenOut, amountIn);
  if (res.status === 429 || res.status >= 500) {
    throw new QuoteHttpError(res.status, `kyber ${res.status} for chain ${internalChainId}`);
  }
  if (!res.ok || !json?.data?.routeSummary) {
    return deadQuote(internalChainId, tokenIn, tokenOut, amountIn); // 4xx / no route → genuinely dead
  }
  return parseKyberRoute(json, { internalChainId, tokenIn, tokenOut });
}
