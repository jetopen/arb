import { NextRequest, NextResponse } from "next/server";
import { runOptimize } from "@/lib/arb/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
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
  }
}
