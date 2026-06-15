import { fetchWithRetry } from "../api-client";

/** deBridge internal chain id -> DefiLlama chain slug (for native gas-token USD price). */
const LLAMA_SLUG: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
  43114: "avax",
  59144: "linea",
  100000019: "cronos",
  100000023: "mantle",
  100000022: "hyperliquid",
};

/** Direct DefiLlama coin keys for chains whose native price isn't the EVM zero-address (e.g. Solana). */
const LLAMA_KEY: Record<number, string> = {
  7565164: "coingecko:solana", // SOL
};

const cache = new Map<number, { usd: number; expiry: number }>();
const TTL = 5 * 60 * 1000;

// Cache ONLY successful, positive prices (fix #9). A transient DefiLlama failure used to be cached as
// usd:0 for a short TTL; downstream getFixedFeeUsd then returned fee=0 for that whole window, inflating
// netUsd and flipping borderline routes to "profitable". Caching only positive results means a failure
// returns 0 once (the caller's own fee fallback handles it) and the very next call retries — no sticky
// $0 window. The retry burst within a single batch is far cheaper than a window of phantom-profit rows.
function remember(internalChainId: number, usd: number): number {
  if (usd > 0) cache.set(internalChainId, { usd, expiry: Date.now() + TTL });
  return usd;
}

/** Native gas-token USD price (for converting dePort fixed fees to USD). Successful prices cached 5m;
 * returns 0 (uncached) when unavailable so the next call retries. */
export async function getNativeUsd(internalChainId: number): Promise<number> {
  const hit = cache.get(internalChainId);
  if (hit && Date.now() < hit.expiry) return hit.usd;

  const slug = LLAMA_SLUG[internalChainId];
  const key = LLAMA_KEY[internalChainId] ?? (slug ? `${slug}:0x0000000000000000000000000000000000000000` : undefined);
  if (!key) return 0; // statically unknown chain — nothing to cache, cheap to re-check
  try {
    const res = await fetchWithRetry(
      `https://coins.llama.fi/prices/current/${key}`,
      { method: "GET" },
      { maxRetries: 1 }
    );
    if (!res.ok) return 0; // transient failure: do NOT cache, let the next call retry
    const json = (await res.json()) as { coins?: Record<string, { price?: number }> };
    // remember() only writes the cache when price > 0, so a missing/zero price is also not cached.
    return remember(internalChainId, json.coins?.[key]?.price ?? 0);
  } catch {
    return 0; // transient failure: do NOT cache, let the next call retry
  }
}
