import { NextRequest, NextResponse } from "next/server";

/**
 * Shared guard for mutating / expensive endpoints (scan, ingest, graph?force=1).
 *
 * FAIL CLOSED in production. These routes mutate the work queue and burn paid third-party quotes, and
 * NOTHING legitimate calls them on the deployed app: the scan loop invokes runScan() in-process (not over
 * HTTP), and NEXT_PUBLIC_ARB_DRIVER=1 stops the browser from polling them. So a missing/absent secret must
 * DENY on the public deployment — a forgotten `CRON_SECRET` fails SAFE, not open (the old behavior left the
 * scanner anonymously triggerable if the env var was ever dropped).
 *
 * - `CRON_SECRET` SET: require `Authorization: Bearer <secret>` (the header, never the query string).
 * - `CRON_SECRET` UNSET + production: deny (401).
 * - `CRON_SECRET` UNSET + dev (`npm run dev`, no NODE_ENV=production): allow, so the browser + local dev
 *   keep working with zero config.
 */
export function requireCron(request: NextRequest): NextResponse | null {
  const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV === "production" ? unauthorized() : null;
  if (request.headers.get("authorization") === `Bearer ${secret}`) return null;
  return unauthorized();
}
