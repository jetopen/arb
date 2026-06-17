import { NextRequest, NextResponse } from "next/server";
import { runOptimize } from "@/lib/arb/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// This endpoint is BROWSER-triggered (the per-row optimizer drawer), so it can't require the CRON_SECRET.
// Each call fans out a grid of paid third-party quotes, so without a cap an anonymous client could loop it
// for cost-amplification. We bound concurrency two ways: per-call (ARB_OPTIMIZE_CONCURRENCY in optimize.ts)
// and process-wide here — at most MAX_INFLIGHT optimize runs at once; excess get a fast 429. The legitimate
// drawer issues one call at a time, so it's unaffected; a flood is capped to MAX_INFLIGHT concurrent runs.
const MAX_INFLIGHT = Math.max(1, Number(process.env.ARB_OPTIMIZE_MAX_INFLIGHT) || 3);
let inflight = 0;

export async function GET(request: NextRequest) {
  if (inflight >= MAX_INFLIGHT) {
    return NextResponse.json({ error: "optimizer busy, retry shortly" }, { status: 429 });
  }
  inflight++;
  try {
    const { searchParams } = new URL(request.url);
    const debridgeId = searchParams.get("debridgeId");
    const buy = Number(searchParams.get("buy"));
    const sell = Number(searchParams.get("sell"));
    if (!debridgeId || !Number.isFinite(buy) || !Number.isFinite(sell)) {
      return NextResponse.json({ error: "debridgeId, buy, sell are required" }, { status: 400 });
    }
    const result = await runOptimize(debridgeId, buy, sell);
    if ("error" in result) return NextResponse.json(result, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    inflight--;
  }
}
