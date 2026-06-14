import { NextResponse } from "next/server";
import { fetchPositiveSpreadRoutes } from "@/lib/symbiosis/client";
import { mapRoutes } from "@/lib/symbiosis/scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Symbiosis already computes + ranks these; we proxy the live feed with a short cache.
let cache: { data: unknown; expiry: number } | null = null;
const TTL = 15_000;

export async function GET() {
  try {
    if (cache && Date.now() < cache.expiry) return NextResponse.json(cache.data);
    const routes = await fetchPositiveSpreadRoutes();
    const opportunities = mapRoutes(routes);
    const data = { opportunities, total: opportunities.length, fetchedAt: Date.now() };
    cache = { data, expiry: Date.now() + TTL };
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
