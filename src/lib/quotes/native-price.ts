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

const cache = new Map<number, { usd: number; expiry: number }>();
const TTL = 5 * 60 * 1000;

/** Native gas-token USD price (for converting dePort fixed fees to USD). Cached 5m; 0 if unavailable. */
export async function getNativeUsd(internalChainId: number): Promise<number> {
  const hit = cache.get(internalChainId);
  if (hit && Date.now() < hit.expiry) return hit.usd;

  const slug = LLAMA_SLUG[internalChainId];
  if (!slug) return 0;
  const key = `${slug}:0x0000000000000000000000000000000000000000`;
  try {
    const res = await fetchWithRetry(
      `https://coins.llama.fi/prices/current/${key}`,
      { method: "GET" },
      { maxRetries: 1 }
    );
    if (!res.ok) return 0;
    const json = (await res.json()) as { coins?: Record<string, { price?: number }> };
    const usd = json.coins?.[key]?.price ?? 0;
    if (usd > 0) cache.set(internalChainId, { usd, expiry: Date.now() + TTL });
    return usd;
  } catch {
    return 0;
  }
}
