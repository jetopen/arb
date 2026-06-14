import { NextRequest, NextResponse } from "next/server";
import { lzChain } from "@/lib/layerzero/chains";
import { resolveLogo } from "@/lib/layerzero/logos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL = 1_800_000; // 30 min
const MAX_ITEMS = 60;
const cache = new Map<string, { value: string | null; expiry: number }>();

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

/** Logo URL for one `${chainKey}:${address}`; null when chain unknown / non-EVM / miss / error. */
async function logoFor(chainKey: string, address: string): Promise<string | null> {
  const evmChainId = lzChain(chainKey)?.evmChainId ?? null;
  return resolveLogo(evmChainId, address);
}

export async function GET(request: NextRequest) {
  try {
    const keys = (request.nextUrl.searchParams.get("items") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_ITEMS);

    const now = Date.now();
    const out: Record<string, string | null> = {};
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
      const value = await logoFor(chainKey, address);
      cache.set(key, { value, expiry: Date.now() + CACHE_TTL });
      out[key] = value;
    });

    return NextResponse.json(out);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
