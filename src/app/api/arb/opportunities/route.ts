import { NextRequest, NextResponse } from "next/server";
import { getStore, DEFAULT_OPP_MAX_AGE_MS, parsePenaltyMs } from "@/lib/db/store";
import { DEFAULT_TIERS } from "@/lib/arb/scanner";
import { errorResponse } from "@/lib/api-error";
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
    // Freshness gate so stale persistent rows (a route no longer being scanned) can't rank forever.
    // DECOUPLED from the dead-route penalty (this gates what the UI shows; the penalty gates re-scan timing).
    // Default is DEFAULT_OPP_MAX_AGE_MS = 3h (the continuous loop keeps the proven set fresh well inside it);
    // override via ?maxAgeMs= or ARB_OPP_MAX_AGE_MS; maxAgeMs<=0 disables the gate. The env is parsed
    // defensively (falls back to the default on a non-numeric value). /api/health flips 503 on this same window.
    const maxAgeParam = finite("maxAgeMs");
    const configuredGateMs = parsePenaltyMs(process.env.ARB_OPP_MAX_AGE_MS, DEFAULT_OPP_MAX_AGE_MS);
    const maxAgeMs = maxAgeParam ?? configuredGateMs;
    const filter: OpportunityFilter = {
      minSpreadPct: finite("minSpreadPct"),
      chainId: finite("chainId"),
      // Pin the table to one ladder rung (the capital selector); unset = best size per token.
      tierUsd: finite("tierUsd"),
      verifiedOnly: searchParams.get("verifiedOnly") === "true",
      // Keep only rows whose tx simulation proved the executable path (sim is opt-in via ARB_SIMULATE).
      executableOnly: searchParams.get("executableOnly") === "true",
      maxAgeMs: maxAgeMs > 0 ? maxAgeMs : undefined,
      // Spread screener collapses to one row per token (highest spread per debridgeId).
      groupByToken: true,
      page: Math.max(1, finite("page") ?? 1),
      take: Math.min(Math.max(1, finite("take") ?? 50), 500),
    };
    const result = await getStore().topOpportunities(filter);
    const lastScan = await getStore().lastScanRun();
    // The actual scanned ladder (reflects ARB_SCAN_NOTIONAL_USD) so the UI capital selector offers the
    // rungs that were really scanned — never a hardcoded list that goes stale under an env override.
    // gateMs = the CONFIGURED freshness gate (NOT the per-request maxAgeMs override): the dashboard
    // fetches with maxAgeMs=0 to show all-time rows, but still needs the real gate for the per-row
    // stale styling and the ScanStatus alarm banner (which must not be disabled by that override).
    return NextResponse.json({ ...result, lastScan, tiers: DEFAULT_TIERS, gateMs: configuredGateMs });
  } catch (error) {
    return errorResponse(error, "arb/opportunities");
  }
}
