import { NextRequest, NextResponse } from "next/server";
import { getGraphSummary, getGraphDetail } from "@/lib/arb/scan-service";
import { requireCron } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "1";
    // A forced rebuild is the expensive (~15-25s on-chain) path — guard it when CRON_SECRET is set; the
    // plain summary/detail reads the browser uses stay open.
    if (force) {
      const denied = requireCron(request);
      if (denied) return denied;
    }

    // ?detail=1 → the browsable tracked-asset list (families + per-chain reps); default → the summary.
    if (searchParams.get("detail") === "1") {
      const detail = await getGraphDetail({
        page: Number(searchParams.get("page") ?? "1"),
        take: Number(searchParams.get("take") ?? "100"),
        multiChainOnly: searchParams.get("multiChainOnly") === "1",
        force,
      });
      return NextResponse.json(detail);
    }

    const summary = await getGraphSummary(force);
    return NextResponse.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
