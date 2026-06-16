import { NextRequest, NextResponse } from "next/server";

/**
 * Optional shared guard for mutating / expensive endpoints (scan, ingest, graph?force=1).
 *
 * - When `CRON_SECRET` is UNSET: returns null (allow) — preserves today's open behavior, so the browser
 *   and local dev keep working with no config.
 * - When `CRON_SECRET` is SET: require `Authorization: Bearer <secret>`; otherwise return a 401 the caller
 *   returns early. The scan driver sends this header; set NEXT_PUBLIC_ARB_DRIVER=1 so the browser stops
 *   polling /api/arb/scan (it can't hold the secret) once a driver owns scanning.
 *
 * The secret travels in the Authorization header, never the query string.
 */
export function requireCron(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  if (request.headers.get("authorization") === `Bearer ${secret}`) return null;
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
