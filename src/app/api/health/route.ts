import { NextResponse } from "next/server";
import { getStore, DEFAULT_OPP_MAX_AGE_MS, parsePenaltyMs } from "@/lib/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness of the SCAN PIPELINE (not just the web server): 200 while the last scan finished within the
// read-freshness gate, else 503. Point a free external pinger (UptimeRobot / cron-job.org, ~5-min) at it so
// a stalled scanner is caught even when the PC is off AND GitHub has dropped every schedule tick — the one
// outage nothing in-process can notice. Without this the public dashboard just silently empties at the gate.
// Also returns the deployed commit (NEXT_PUBLIC_GIT_SHA) so repo-vs-deployed drift is visible with one curl.
export async function GET() {
  const gitSha = process.env.NEXT_PUBLIC_GIT_SHA ?? "unknown";
  // Match the dashboard's actual staleness gate so health flips exactly when the UI would empty.
  const gateMs = parsePenaltyMs(process.env.ARB_OPP_MAX_AGE_MS, DEFAULT_OPP_MAX_AGE_MS);
  try {
    const last = await getStore().lastScanRun();
    const lastScanAgeMs = last ? Date.now() - last.finishedAt : null;
    const ok = lastScanAgeMs != null && lastScanAgeMs < gateMs;
    return NextResponse.json({ ok, lastScanAgeMs, gateMs, gitSha }, { status: ok ? 200 : 503 });
  } catch {
    return NextResponse.json({ ok: false, error: "store unavailable", gitSha }, { status: 503 });
  }
}
