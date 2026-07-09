import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db/store";
import { errorResponse } from "@/lib/api-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Spread/net trajectory for one scan-unit id (newest first) — powers the drawer sparkline (5c), so a
// persistent real edge is distinguishable from a one-quote artifact.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const raw = Number(searchParams.get("limit"));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 500) : 100;
    const points = await getStore().opportunityHistory(id, limit);
    return NextResponse.json({ points });
  } catch (error) {
    return errorResponse(error, "arb/history");
  }
}
