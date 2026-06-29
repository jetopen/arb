// Decoupled one-off scan: build/load the lock-graph from the Supabase snapshot, scan one batch, write
// results, exit. Replaces the always-on `worker` dyno (scripts/scan-driver.mjs) — run by Heroku Scheduler
// every ~10 min via `npm run scan:once`. Imports runScan directly (no HTTP), so it does NOT depend on the
// web dyno; the graph rebuild (~15-25s, only at the 6h snapshot boundary) happens here in a one-off dyno,
// off the web request path (no H12). Discord alerts still fire inside runScan.
//
// .mts (ESM) so top-level await works under tsx. Usage:
//   npm run scan:once          # one batch (ARB_SCAN_N units, default 24), then exit
//   ARB_SCAN_N=64 npm run scan:once
//
// Env (loaded from .env.local in dev via @next/env; real config vars already in process.env on Heroku):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (required — selects the Supabase store)
//   ARB_SCAN_N                                 units per batch, 1..64 (default 24)
//   DISCORD_WEBHOOK_URL, ARB_* knobs           optional, same as the web/worker path

// @next/env is CommonJS — default-import the module object and call loadEnvConfig off it (named ESM import
// fails its CJS interop). Same pattern as scripts/scan-driver.mjs.
import nextEnv from "@next/env";

// Load env BEFORE importing the app module chain (dynamic import below) so any module-level env read sees it.
nextEnv.loadEnvConfig(process.cwd(), true);

const n = Math.min(Math.max(Number(process.env.ARB_SCAN_N) || 24, 1), 64);

const { runScan } = await import("@/lib/arb/scan-service");

try {
  const t0 = Date.now();
  const r = await runScan(n);
  console.log(
    `[scan-once] units=${r.unitsProcessed ?? "?"} remaining=${r.remaining ?? "?"} ` +
      `rpmFree=${r.rpmAvailable ?? "?"} (${Date.now() - t0}ms)`
  );
  process.exit(0);
} catch (err) {
  console.error("[scan-once] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
