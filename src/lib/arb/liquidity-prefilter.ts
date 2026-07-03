import { getTokenStats, type GtTokenStats } from "../liquidity/geckoterminal";

/**
 * GeckoTerminal liquidity PRE-filter for the cold-discovery sweep. Most of the ~8.7k dead reps have no
 * indexed DEX pool at all — one cached GT token read detects that for ~free, instead of spending 1-2
 * aggregator quotes per rung × direction on every cycle. The probe targets the deAsset REP side (the
 * thin side; a real family's native root always has pools).
 *
 * FAIL-OPEN by design: a GT outage / 429 / unindexed-but-real pool must never hide a route, so any
 * unsuccessful probe returns true WITHOUT caching (an outage result must not poison the cache). Only a
 * successful GT response caches — `false` when it shows no reserve, `true` otherwise.
 */

type PrefilterEntry = { hasLiquidity: boolean; expiry: number };

/** Negative results live longer: a dead rep stays dead; a live one re-checks with the graph cadence. */
export const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
export const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_CACHE = 4000;

const cache = new Map<string, PrefilterEntry>();

/**
 * PURE: bound a Map's size in place — sweep expired entries first; if still at/over `max`, evict the
 * oldest ~10% by insertion order (never clear(): that triggers a re-fetch storm against rate-limited
 * GeckoTerminal). Same pattern as the LZ liquidity cache (fix #11).
 */
export function evictToBound(map: Map<string, PrefilterEntry>, max: number, now: number = Date.now()): void {
  if (map.size < max) return;
  for (const [k, v] of map) if (v.expiry <= now) map.delete(k);
  if (map.size < max) return;
  const target = max - Math.max(1, Math.ceil(max * 0.1));
  for (const k of map.keys()) {
    if (map.size <= target) break;
    map.delete(k);
  }
}

/** Kill-switch: ARB_PREFILTER=false bypasses the gate entirely (same pattern as ARB_SCAN_SOLANA). */
function prefilterEnabled(): boolean {
  return process.env.ARB_PREFILTER !== "false";
}

export type TokenStatsFn = (chainId: number, address: string) => Promise<GtTokenStats | null>;

/**
 * true → proceed to quotes; false → the rep has NO indexed liquidity, skip the unit (0 quotes spent).
 * `statsFn` is injectable for tests; production uses the real GeckoTerminal read.
 */
export async function passesLiquidityPrefilter(
  chainId: number,
  address: string,
  statsFn: TokenStatsFn = getTokenStats,
  now: number = Date.now()
): Promise<boolean> {
  if (!prefilterEnabled()) return true;
  const key = `${chainId}:${address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && now < hit.expiry) return hit.hasLiquidity;

  let stats: GtTokenStats | null = null;
  try {
    stats = await statsFn(chainId, address);
  } catch {
    stats = null;
  }
  // Unsuccessful probe (outage / 429 / unknown network) → fail open, do NOT cache.
  if (stats === null) return true;

  const hasLiquidity = (stats.liquidityUsd ?? 0) > 0;
  evictToBound(cache, MAX_CACHE, now);
  cache.set(key, { hasLiquidity, expiry: now + (hasLiquidity ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  return hasLiquidity;
}

/** Test seam. */
export function __clearPrefilterCache(): void {
  cache.clear();
}
