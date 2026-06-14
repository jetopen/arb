import { NextRequest, NextResponse } from "next/server";
import { runScan } from "@/lib/arb/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// First call builds the lock-graph (concurrent across chains, ~15-25s) then scans; cached 6h after.
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const n = Math.min(Math.max(Number(searchParams.get("n") ?? "12"), 1), 32);
    const result = await runScan(n);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
