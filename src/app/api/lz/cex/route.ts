import { NextRequest, NextResponse } from "next/server";
import { fetchCexListing, type CexListing } from "@/lib/layerzero/cex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL = 600_000; // 10 min
const MAX_SYMBOLS = 40;
const CONCURRENCY = 4;
const cache = new Map<string, { value: CexListing; expiry: number }>();

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
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
    const symbols = Array.from(
      new Set(
        (searchParams.get("symbols") ?? "")
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      )
    ).slice(0, MAX_SYMBOLS);

    const now = Date.now();
    const out: Record<string, CexListing> = {};
    const misses: string[] = [];
    for (const symbol of symbols) {
      const hit = cache.get(symbol);
      if (hit && now < hit.expiry) out[symbol] = hit.value;
      else misses.push(symbol);
    }

    await mapWithConcurrency(misses, CONCURRENCY, async (symbol) => {
      const value = await fetchCexListing(symbol);
      cache.set(symbol, { value, expiry: Date.now() + CACHE_TTL });
      out[symbol] = value;
    });

    return NextResponse.json(out);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
