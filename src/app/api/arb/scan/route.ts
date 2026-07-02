import { NextRequest, NextResponse } from "next/server";
import { runScan } from "@/lib/arb/scan-service";
import { requireCron } from "@/lib/api-auth";
import { errorResponse } from "@/lib/api-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// First call builds the lock-graph (concurrent across chains, ~15-25s) then scans; cached 6h after.
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const denied = requireCron(request);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(request.url);
    const n = Math.min(Math.max(Number(searchParams.get("n") ?? "12"), 1), 64);
    const result = await runScan(n);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "arb/scan");
  }
}
