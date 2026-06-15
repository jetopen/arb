import { NextRequest, NextResponse } from "next/server";
import { fetchWithRetry } from "@/lib/api-client";
import { parseLiquidityUsd } from "@/lib/liquidity/geckoterminal";
import { lzGtSlug } from "@/lib/layerzero/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL = 300_000; // 5 min
const MAX_ITEMS = 60;
const MAX_CACHE = 5000;
type LiqEntry = { value: number | null; expiry: number };
const cache = new Map<string, LiqEntry>();

/**
 * PURE: bound a Map's size in place. First sweep expired entries; if still at/over `max`, evict the
 * OLDEST entries (a Map preserves insertion order, so the front keys are oldest) until size drops
 * below the bound — dropping at least ~10% so this amortizes instead of running every insert.
 *
 * Fix #11: the previous code did `cache.clear()` here, wiping all ~5000 fresh entries and triggering a
 * re-fetch storm against rate-limited GeckoTerminal. Evicting only the oldest slice keeps the cache warm.
 */
export function evictToBound(map: Map<string, LiqEntry>, max: number, now: number = Date.now()): void {
  if (map.size < max) return;
  for (const [k, v] of map) if (v.expiry <= now) map.delete(k);
  if (map.size < max) return;
  // Still full of fresh entries: drop the oldest ~10% (at least 1) by insertion order.
  const target = max - Math.max(1, Math.ceil(max * 0.1));
  for (const k of map.keys()) {
    if (map.size <= target) break;
    map.delete(k);
  }
}

/** Store a liquidity result, bounding the cache to MAX_CACHE via oldest-first eviction. */
function rememberLiq(key: string, value: number | null) {
  evictToBound(cache, MAX_CACHE);
  cache.set(key, { value, expiry: Date.now() + CACHE_TTL });
}

/** Pool liquidity (USD) for one `${chainKey}:${address}`; null when slug unknown or no data. */
async function liquidityFor(chainKey: string, address: string): Promise<number | null> {
  const slug = lzGtSlug(chainKey);
  if (!slug || !address) return null;
  const url = `https://api.geckoterminal.com/api/v2/networks/${slug}/tokens/${address}`;
  try {
    const res = await fetchWithRetry(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      { maxRetries: 1 }
    );
    if (!res.ok) return null;
    return parseLiquidityUsd(await res.json());
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const keys = (searchParams.get("items") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_ITEMS);

    const now = Date.now();
    const out: Record<string, number | null> = {};
    const misses: string[] = [];
    for (const key of keys) {
      const hit = cache.get(key);
      if (hit && now < hit.expiry) out[key] = hit.value;
      else misses.push(key);
    }

    await mapWithConcurrency(misses, 4, async (key) => {
      const sep = key.indexOf(":");
      if (sep < 0) {
        out[key] = null;
        return;
      }
      const chainKey = key.slice(0, sep);
      const address = key.slice(sep + 1);
      const value = await liquidityFor(chainKey, address);
      rememberLiq(key, value);
      out[key] = value;
    });

    return NextResponse.json(out);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
