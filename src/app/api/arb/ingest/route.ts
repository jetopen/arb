import { NextResponse } from "next/server";
import { tailDeportEvents } from "@/lib/deport/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Tails the deBridge dePort submission log into the event index (idempotent). Cron this (or hit manually)
// to keep deAsset discovery current. The one-time historical backfill is scripts/backfill-deport-events.cjs.
export const maxDuration = 60;

export async function GET() {
  try {
    const result = await tailDeportEvents();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
