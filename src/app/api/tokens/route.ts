import { NextResponse } from "next/server";
import { fetchPopularTokens } from "@/lib/api-client";

let cached: { data: unknown; expiry: number } | null = null;
const CACHE_TTL = 300_000;

export async function GET() {
  try {
    if (cached && Date.now() < cached.expiry) {
      return NextResponse.json(cached.data);
    }

    const tokens = await fetchPopularTokens(200);
    cached = { data: { tokens }, expiry: Date.now() + CACHE_TTL };

    return NextResponse.json({ tokens });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
