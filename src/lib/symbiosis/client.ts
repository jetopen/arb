import { fetchWithRetry } from "../api-client";
import type { SymRouteRaw, SymQuote } from "./types";

const BASE = "https://api.symbiosis.finance/crosschain";
const UA = { "User-Agent": "Mozilla/5.0 (arb-scanner)" };
const DEAD = "0x000000000000000000000000000000000000dEaD";

/** Live ranked positive-spread arb feed (Symbiosis computes + ranks these for us). */
export async function fetchPositiveSpreadRoutes(): Promise<SymRouteRaw[]> {
  const res = await fetchWithRetry(`${BASE}/v1/positive-spread-routes`, { method: "GET", headers: UA }, { maxRetries: 2 });
  if (!res.ok) throw new Error(`symbiosis routes ${res.status}`);
  const data = (await res.json()) as { routes?: SymRouteRaw[] };
  return data.routes ?? [];
}

interface RawTokenAmount {
  amount?: string;
  decimals?: number;
  priceUsd?: number;
}
interface RawQuote {
  tokenAmountOut?: RawTokenAmount;
  amountInUsd?: RawTokenAmount;
  fee?: RawTokenAmount;
  priceImpact?: number | string;
  estimatedTime?: number | string;
}

function usdOf(t: RawTokenAmount | undefined): number {
  if (!t?.amount) return 0;
  return (Number(t.amount) / 10 ** (t.decimals ?? 18)) * (t.priceUsd ?? 0);
}

/** Executable quote for a specific clip (POST /v2/quote) using a placeholder address — read-only. */
export async function fetchSymQuote(
  tokenIn: { address: string; chainId: number; decimals: number; symbol: string },
  tokenOut: { address: string; chainId: number; decimals: number; symbol: string },
  amountBaseUnits: string,
  slippageBps = 200
): Promise<SymQuote | null> {
  const body = {
    tokenAmountIn: { ...tokenIn, amount: amountBaseUnits },
    tokenOut,
    from: DEAD,
    to: DEAD,
    slippage: slippageBps,
  };
  const res = await fetchWithRetry(`${BASE}/v2/quote`, { method: "POST", headers: UA, body: JSON.stringify(body) }, { maxRetries: 1 });
  if (!res.ok) return null;
  const r = (await res.json()) as RawQuote;
  if (!r.tokenAmountOut || !r.amountInUsd) return null;
  const inUsd = usdOf(r.amountInUsd); // the API names the input tokenAmount `amountInUsd`
  const outUsd = usdOf(r.tokenAmountOut);
  return {
    inUsd,
    outUsd,
    netBps: inUsd > 0 ? ((outUsd - inUsd) / inUsd) * 10_000 : 0,
    priceImpactPct: Number(r.priceImpact ?? 0),
    estimatedTimeSec: Number(r.estimatedTime ?? 0),
    feeUsd: r.fee ? usdOf(r.fee) : null,
  };
}
