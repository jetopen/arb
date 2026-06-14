import { NextRequest, NextResponse } from "next/server";
import { fetchTokenMetrics, type TokenMetrics } from "@/lib/layerzero/price";
import { lzGtSlug } from "@/lib/layerzero/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL = 300_000; // 5 min
const MAX_ITEMS = 60;
const cache = new Map<string, { value: TokenMetrics | null; expiry: number }>();

/** Token metrics for one `${chainKey}:${address}`; null when the chain has no GeckoTerminal slug. */
async function metricsFor(chainKey: string, address: string): Promise<TokenMetrics | null> {
  const slug = lzGtSlug(chainKey);
  if (!slug || !address) return null;
  return fetchTokenMetrics(slug, address);
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
    const out: Record<string, TokenMetrics | null> = {};
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
      const value = await metricsFor(chainKey, address);
      cache.set(key, { value, expiry: Date.now() + CACHE_TTL });
      out[key] = value;
    });

    return NextResponse.json(out);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
