import { fetchWithRetry } from "../api-client";

/** deBridge internal chain id -> GeckoTerminal network slug. Missing => liquidity gate skipped. */
const GT_NETWORK: Record<number, string> = {
  1: "eth",
  10: "optimism",
  56: "bsc",
  137: "polygon_pos",
  8453: "base",
  42161: "arbitrum",
  43114: "avax",
  59144: "linea",
  100000019: "cro",
  100000023: "mantle",
  100000022: "hyperevm",
};

export function gtNetwork(internalChainId: number): string | undefined {
  return GT_NETWORK[internalChainId];
}

interface GtTokenResponse {
  data?: { attributes?: { total_reserve_in_usd?: string } };
}

/** PURE: pull total pool reserve (USD) from a GeckoTerminal token response. */
export function parseLiquidityUsd(raw: GtTokenResponse): number | null {
  const v = raw.data?.attributes?.total_reserve_in_usd;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
