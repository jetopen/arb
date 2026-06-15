import { NextRequest, NextResponse } from "next/server";
import { getStore, DEAD_ROUTE_PENALTY_MS, parsePenaltyMs } from "@/lib/db/store";
import type { OpportunityFilter } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    // Only accept finite numbers — `?chainId=abc` must not reach the query layer as NaN.
    const finite = (key: string): number | undefined => {
      if (!searchParams.has(key)) return undefined;
      const v = Number(searchParams.get(key));
      return Number.isFinite(v) ? v : undefined;
    };
    // Freshness gate so stale persistent rows (a route no longer being scanned) can't rank forever.
    // Default aligned to the scan cadence / dead-route penalty (6h) — a 1h default hid still-valid
    // opportunities whenever the queue is large and scans cycle slower than 1h (the normal case, fix #8).
    // Override via ?maxAgeMs= or ARB_OPP_MAX_AGE_MS env; maxAgeMs<=0 disables the gate. The env is parsed
    // defensively (falls back to 6h on a non-numeric value rather than NaN → silently disabling the gate).
    const maxAgeParam = finite("maxAgeMs");
    const maxAgeMs = maxAgeParam ?? parsePenaltyMs(process.env.ARB_OPP_MAX_AGE_MS, DEAD_ROUTE_PENALTY_MS);
    const filter: OpportunityFilter = {
      minNetPct: finite("minNetPct"),
      tierUsd: finite("tier"),
      chainId: finite("chainId"),
      verifiedOnly: searchParams.get("verifiedOnly") === "true",
      maxAgeMs: maxAgeMs > 0 ? maxAgeMs : undefined,
      page: Math.max(1, finite("page") ?? 1),
      take: Math.min(Math.max(1, finite("take") ?? 50), 200),
    };
    const result = await getStore().topOpportunities(filter);
    const lastScan = await getStore().lastScanRun();
    return NextResponse.json({ ...result, lastScan });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
