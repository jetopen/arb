import type { DexQuote } from "../types";
import { SOLANA_INTERNAL_ID, SOLANA_USDC_MINT } from "../deport/address-codec";
import { QuoteHttpError } from "./quote-error";

// Re-exported so existing importers (and tests) can keep `import { SOLANA_USDC_MINT } from ".../jupiter"`,
// while the single source of truth lives in address-codec alongside SOLANA_INTERNAL_ID.
export { SOLANA_USDC_MINT };

const LITE_BASE = "https://lite-api.jup.ag/swap/v1";
const PRO_BASE = "https://api.jup.ag/swap/v1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const API_KEY = process.env.JUPITER_API_KEY || undefined;
/** Conservative request rate for the free lite tier; raise via env (or a paid key) if you have headroom.
 *  Clamp to a positive finite value: a stray 0 / negative / non-numeric ARB_JUPITER_RPS must NOT collapse
 *  the throttle to ~1ms (which would burst Jupiter and defeat the kill-switch this module exists to give). */
const RPS_RAW = Number(process.env.ARB_JUPITER_RPS);
const RPS = Number.isFinite(RPS_RAW) && RPS_RAW > 0 ? RPS_RAW : 2;
const MIN_INTERVAL_MS = Math.max(1, Math.round(1000 / RPS));

// Timestamp-based throttle: each call waits until MIN_INTERVAL_MS after the last one resolved.
// Unlike a chained-promise throttle this doesn't accumulate list nodes for the process lifetime.
let lastResolve = 0;
function throttle(): Promise<void> {
  const now = Date.now();
  const delay = Math.max(0, lastResolve + MIN_INTERVAL_MS - now);
  lastResolve = now + delay;
  return new Promise<void>((res) => setTimeout(res, delay));
}

interface JupiterQuoteRaw {
  inAmount?: string;
  outAmount?: string;
  priceImpactPct?: string | number;
  slippageBps?: number;
  swapUsdValue?: string | number;
}

/**
 * PURE: map a Jupiter quote to a DexQuote. The edge only consumes the USDC side's USD value
 * (`buyLeg.amountInUsd` / `sellLeg.amountOutUsd`), so the USDC leg's USD is computed EXACTLY from its raw
 * amount (6 decimals); the token side falls back to Jupiter's `swapUsdValue`. `priceImpactPct` is a
 * FRACTION (e.g. 0.4157 = 41.57%) — verified live — so bps = pct × 10_000.
 */
export function parseJupiter(raw: JupiterQuoteRaw, ctx: { tokenIn: string; tokenOut: string }): DexQuote {
  const amountIn = raw.inAmount ?? "0";
  const amountOut = raw.outAmount ?? "0";
  const swapUsd = Number(raw.swapUsdValue ?? 0) || 0;
  const inIsUsdc = ctx.tokenIn === SOLANA_USDC_MINT;
  const outIsUsdc = ctx.tokenOut === SOLANA_USDC_MINT;
  return {
    internalChainId: SOLANA_INTERNAL_ID,
    tokenIn: ctx.tokenIn, // base58, case-preserved (NOT lowercased)
    tokenOut: ctx.tokenOut,
    amountIn,
    amountOut,
    amountInUsd: inIsUsdc ? Number(amountIn) / 1e6 : swapUsd,
    amountOutUsd: outIsUsdc ? Number(amountOut) / 1e6 : swapUsd,
    priceImpactBps: Math.max(0, Number(raw.priceImpactPct ?? 0) * 10_000),
    gasUsd: 0.01, // Solana base + priority fee is ~sub-cent; a small flat estimate
    recommendedSlippageBps: raw.slippageBps ?? 100,
    source: "jupiter",
  };
}

/**
 * Fetch a real, executable Solana DEX quote from Jupiter (a multi-AMM aggregator). Throttled for the free
 * tier; uses a paid key (api.jup.ag) when JUPITER_API_KEY is set. Throws on transport/HTTP failure (the
 * caller treats that as a dead route); a routeless quote returns amountOut "0" like the EVM path.
 */
export async function fetchJupiterQuote(tokenIn: string, tokenOut: string, amountIn: string): Promise<DexQuote> {
  await throttle();
  const base = API_KEY ? PRO_BASE : LITE_BASE;
  const url = `${base}/quote?inputMint=${tokenIn}&outputMint=${tokenOut}&amount=${amountIn}&slippageBps=100`;
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": UA };
  if (API_KEY) headers["x-api-key"] = API_KEY;
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) throw new QuoteHttpError(res.status, `jupiter ${res.status} for ${tokenIn}->${tokenOut}`);
  const json = (await res.json()) as JupiterQuoteRaw;
  return parseJupiter(json, { tokenIn, tokenOut });
}
