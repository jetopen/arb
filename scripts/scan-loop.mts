// Continuous in-process scan loop — the driver for the PUBLIC-repo GitHub Actions job (unlimited free
// minutes). Replaces the one-batch-per-dispatch model (scripts/scan-once.mts): instead of a fresh process
// per trigger, ONE job runs this loop for ~5.5h (under GitHub's 6h hard job cap), calling runScan() back to
// back. That matters because the RPM limiter and the lock-graph cache are MODULE-LEVEL singletons in
// scan-service.ts — a single long-lived process keeps ONE 120-RPM budget (so it can't overrun the DEX APIs)
// and a warm graph (rebuilt only at the 6h TTL boundary). Re-spawning scan:once would reset both every tick.
//
// Sustained ~120 RPM ≈ ~60 units/min cycles the ~9.5k queue in ~2.6h (just under the 3h freshness gate) and
// the hot proven set every ~30 min, so the dashboard stays full instead of showing the last-scanned sliver.
//
// SELF-RESTART: the job self-exits(0) at MAX_MS. The workflow's `concurrency` guard means the next scheduled
// (*/10) or Windows-task trigger is already queued as `pending` and starts the instant this job ends — a
// seamless, PAT-free restart. When the PC is off, the GitHub schedule restarts it.
//
// .mts (ESM) so top-level await works under tsx. Usage:
//   npm run scan:loop                                   # loop ~5.5h then exit 0 (CI default)
//   ARB_LOOP_MAX_MS=90000 ARB_SCAN_N=24 npm run scan:loop   # short local smoke test
//
// Env (loaded from .env.local in dev via @next/env; real config already in process.env in CI):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required — selects the Supabase store
//   ARB_SCAN_N            units per batch, 1..64 (default 48)
//   ARB_LOOP_INTERVAL_MS  pause between ticks (default 3000; the RPM budget is the real throttle)
//   ARB_LOOP_MAX_MS       self-exit deadline (default 5.5h; kept < GitHub's 6h cap so shutdown is graceful)
//   ARB_SCAN_RPM, DISCORD_WEBHOOK_URL, ZEROX_API_KEY, …   optional, same as the scan:once path

// @next/env is CommonJS — default-import the module object (named ESM import fails its CJS interop).
import nextEnv from "@next/env";

// Load env BEFORE importing the app module chain (dynamic import below) so module-level env reads see it.
nextEnv.loadEnvConfig(process.cwd(), true);

const N = Math.min(Math.max(Number(process.env.ARB_SCAN_N) || 48, 1), 64);
const INTERVAL_MS = Math.max(Number(process.env.ARB_LOOP_INTERVAL_MS) || 3000, 0);
const MAX_MS = Math.max(Number(process.env.ARB_LOOP_MAX_MS) || 5.5 * 60 * 60 * 1000, 60_000);

const { runScan } = await import("@/lib/arb/scan-service");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const start = Date.now();
let tick = 0;
let errStreak = 0;

console.log(`[scan-loop] start N=${N} interval=${INTERVAL_MS}ms maxRuntime=${Math.round(MAX_MS / 60000)}min`);

// Loop until the deadline. The check is between ticks, so we exit only AFTER a runScan() has fully returned
// (its markScanned has already cleared the batch's leases) — a batch is never left half-marked.
while (Date.now() - start < MAX_MS) {
  tick++;
  try {
    const r = await runScan(N);
    errStreak = 0;
    console.log(
      `[scan-loop] tick=${tick} units=${r.unitsProcessed ?? "?"} remaining=${r.remaining ?? "?"} ` +
        `rpmFree=${r.rpmAvailable ?? "?"} elapsed=${((Date.now() - start) / 60000).toFixed(1)}min`
    );
    // Empty batch (queue momentarily drained / everything leased) → back off longer than a busy-poll.
    await sleep((r.unitsProcessed ?? 0) > 0 ? INTERVAL_MS : 15_000);
  } catch (err) {
    // A transient upstream failure (deBridge/DEX 5xx/429, a DB blip) must NOT kill the long job. Log, back
    // off exponentially (cap 60s), keep going. Everything is inside this try, so even a startup blip retries.
    errStreak++;
    const backoff = Math.min(60_000, (INTERVAL_MS || 1000) * 2 ** errStreak);
    console.error(
      `[scan-loop] tick=${tick} failed (streak=${errStreak}):`,
      err instanceof Error ? err.message : err,
      `— backoff ${backoff}ms`
    );
    await sleep(backoff);
  }
}

console.log(
  `[scan-loop] reached max runtime after ${tick} ticks (${((Date.now() - start) / 60000).toFixed(1)}min) — ` +
    `exiting 0 for a clean restart`
);
process.exit(0);
