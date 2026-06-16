import { NextRequest, NextResponse } from "next/server";
import { getStore, DEFAULT_OPP_MAX_AGE_MS, parsePenaltyMs } from "@/lib/db/store";
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
    // DECOUPLED from the dead-route penalty: the queue can take well over 6h to cycle when scanning is
    // sparse, so a 6h read gate hid most still-valid tokens (only those scanned in the last 6h showed).
    // Default 24h surfaces the full live set; override via ?maxAgeMs= or ARB_OPP_MAX_AGE_MS; maxAgeMs<=0
    // disables the gate. The env is parsed defensively (falls back to the default on a non-numeric value).
    const maxAgeParam = finite("maxAgeMs");
    const maxAgeMs = maxAgeParam ?? parsePenaltyMs(process.env.ARB_OPP_MAX_AGE_MS, DEFAULT_OPP_MAX_AGE_MS);
    const filter: OpportunityFilter = {
      minSpreadPct: finite("minSpreadPct"),
      chainId: finite("chainId"),
      verifiedOnly: searchParams.get("verifiedOnly") === "true",
      maxAgeMs: maxAgeMs > 0 ? maxAgeMs : undefined,
      // Spread screener collapses to one row per token (highest spread per debridgeId).
      groupByToken: true,
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
