import { NextRequest, NextResponse } from "next/server";
import { fetchOftList } from "@/lib/layerzero/ofts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL = 600_000; // 10 min
let cached: { key: string; data: unknown; expiry: number } | null = null;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbols = searchParams.get("symbols") ?? undefined;
    const chainNames = searchParams.get("chainNames") ?? undefined;
    const key = `${symbols ?? ""}|${chainNames ?? ""}`;

    if (cached && cached.key === key && Date.now() < cached.expiry) {
      return NextResponse.json(cached.data);
    }

    const tokens = await fetchOftList({ symbols, chainNames });
    const data = { tokens };
    cached = { key, data, expiry: Date.now() + CACHE_TTL };
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
