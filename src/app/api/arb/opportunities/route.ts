import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db/store";
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
    const filter: OpportunityFilter = {
      minNetPct: finite("minNetPct"),
      tierUsd: finite("tier"),
      chainId: finite("chainId"),
      verifiedOnly: searchParams.get("verifiedOnly") === "true",
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
