import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Per-IP rate limiter for /api/*. (Next 16 renamed Middleware → Proxy; this is the project-root proxy file.)
//
// Defense-in-depth: the mutating routes are auth-gated (api-auth) and /api/arb/optimize has its own in-flight
// cap, but nothing bounded per-IP request VOLUME against the paid-upstream proxy routes (search / lz / messages)
// or a naive flood. This is a FLOOR, not a global limiter: Proxy runs on the Edge runtime, so this in-memory
// bucket is per-edge-instance and resets on cold start — it caps a single client hammering a single instance
// (the realistic abuse shape) without shared infrastructure. A stronger global cap would need a shared store.
//
// FAILS OPEN: if the client IP can't be resolved, or on any doubt, the request is allowed — a rate limiter must
// never wall off legitimate traffic. The limit is deliberately generous (a dashboard polls ~8 req/min) and
// tunable via API_RATE_LIMIT_PER_MIN.

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.API_RATE_LIMIT_PER_MIN) || 240;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function clientKey(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip");
}

export function proxy(req: NextRequest) {
  const key = clientKey(req);
  if (!key) return NextResponse.next(); // unidentifiable → fail open

  const now = Date.now();
  const b = buckets.get(key);

  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    // Opportunistic sweep so the per-instance map can't grow unbounded under an IP-rotating flood.
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    return NextResponse.next();
  }

  if (b.count >= MAX_PER_WINDOW) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "retry-after": String(Math.ceil((b.resetAt - now) / 1000)) } }
    );
  }

  b.count++;
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
