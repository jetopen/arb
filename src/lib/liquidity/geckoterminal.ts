import { fetchWithRetry } from "../api-client";
import { getChainByInternalId } from "../deport/registry";

/** deBridge internal chain id -> GeckoTerminal network slug (from the chain registry). Missing => gate skipped. */
export function gtNetwork(internalChainId: number): string | undefined {
  return getChainByInternalId(internalChainId)?.gtSlug;
}

interface GtTokenResponse {
  data?: { attributes?: { total_reserve_in_usd?: string; price_usd?: string } };
}

/** PURE: pull total pool reserve (USD) from a GeckoTerminal token response. */
export function parseLiquidityUsd(raw: GtTokenResponse): number | null {
  const v = raw.data?.attributes?.total_reserve_in_usd;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** PURE: pull spot USD price from a GeckoTerminal token response (positive, else null). */
export function parsePriceUsd(raw: GtTokenResponse): number | null {
  const v = raw.data?.attributes?.price_usd;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface GtTokenStats {
  liquidityUsd: number | null;
  priceUsd: number | null;
}

/**
 * One GeckoTerminal token fetch yielding BOTH the liquidity-gate reserve and the spot price. The token
 * endpoint returns total_reserve_in_usd and price_usd in the same response, so Solana verification reads
 * them with a SINGLE request instead of two identical ones — halving GT load (its free tier is ~30 rpm,
 * and a 429 silently returns null → an UNVERIFIED real route). Null when the network/token is unknown or
 * the request fails. */
export async function getTokenStats(internalChainId: number, tokenAddress: string): Promise<GtTokenStats | null> {
  const net = gtNetwork(internalChainId);
  if (!net) return null;
  const url = `https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${tokenAddress}`;
  try {
    const res = await fetchWithRetry(url, { method: "GET", headers: { Accept: "application/json" } }, { maxRetries: 1 });
    if (!res.ok) return null;
    const json = (await res.json()) as GtTokenResponse;
    return { liquidityUsd: parseLiquidityUsd(json), priceUsd: parsePriceUsd(json) };
  } catch {
    return null;
  }
}

/** Total DEX pool liquidity (USD) backing a token, used as the fill-feasibility gate. Null if unknown. */
export async function getPoolLiquidityUsd(
  internalChainId: number,
  tokenAddress: string
): Promise<number | null> {
  const net = gtNetwork(internalChainId);
  if (!net) return null;
  const url = `https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${tokenAddress}`;
  try {
    const res = await fetchWithRetry(url, { method: "GET", headers: { Accept: "application/json" } }, { maxRetries: 1 });
    if (!res.ok) return null;
    return parseLiquidityUsd((await res.json()) as GtTokenResponse);
  } catch {
    return null;
  }
}
