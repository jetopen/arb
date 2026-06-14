import { NextRequest, NextResponse } from "next/server";
import { getGraphSummary } from "@/lib/arb/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "1";
    const summary = await getGraphSummary(force);
    return NextResponse.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
