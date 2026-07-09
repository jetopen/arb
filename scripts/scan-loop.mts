// Continuous in-process scan loop — the driver for the PUBLIC-repo GitHub Actions job (unlimited free
// minutes). ONE job runs this for ~5.5h (under GitHub's 6h hard job cap), calling runScan() back to back.
// That matters because the RPM limiter and the lock-graph cache are MODULE-LEVEL singletons in
// scan-service.ts — a single long-lived process keeps ONE shared RPM budget (so it can't overrun the DEX
// APIs) and a warm graph (rebuilt only at the 6h TTL boundary). Re-spawning scan:once would reset both.
//
// Steady state is TWO-LANE, not a single full-queue sweep: the hot lane keeps the proven set fresh inside the
// 3h read gate (~28-min cycle), while the cold-discovery sweep works the ~8.7k dead reps with the remaining
// budget (~4-5h). So the dashboard stays full via the hot lane, not by cycling the whole queue every tick.
//
// SELF-RESTART: the job self-exits at MAX_MS. The workflow's `concurrency` guard means the next scheduled
// (*/10) or Windows-task trigger is already queued as `pending` and starts the instant this job ends — a
// seamless, PAT-free restart. When the PC is off, the GitHub schedule restarts it.
//
// This file is a thin shell: all loop logic (backoff, deadline, sustained-failure alert+abort, 429-storm
// detection) lives in the unit-tested src/lib/arb/scan-loop-core.ts. On sustained failure runLoop returns
// exitCode 1 so the run goes RED (GitHub emails the owner) instead of a silent green 5.5h of errors.
//
// .mts (ESM) so top-level await works under tsx. Usage:
//   npm run scan:loop                                        # loop ~5.5h then exit (CI default)
//   ARB_LOOP_MAX_MS=90000 ARB_SCAN_N=24 npm run scan:loop    # short local smoke test
//
// Env (loaded from .env.local in dev via @next/env; real config already in process.env in CI):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required — selects the Supabase store
//   DISCORD_WEBHOOK_URL                        optional — enables the ops alerts below
//   ARB_SCAN_N            units per batch, 1..64 (default 48)
//   ARB_LOOP_INTERVAL_MS  pause between ticks (default 3000; the RPM budget is the real throttle)
//   ARB_LOOP_MAX_MS       self-exit deadline (default 5.5h; kept < GitHub's 6h cap so shutdown is graceful)
//   ARB_SCAN_RPM, ZEROX_API_KEY, …            optional, same as the scan:once path

// @next/env is CommonJS — default-import the module object (named ESM import fails its CJS interop).
import nextEnv from "@next/env";

// Load env BEFORE importing the app module chain (dynamic import below) so module-level env reads see it.
nextEnv.loadEnvConfig(process.cwd(), true);

const N = Math.min(Math.max(Number(process.env.ARB_SCAN_N) || 48, 1), 64);
const INTERVAL_MS = Math.max(Number(process.env.ARB_LOOP_INTERVAL_MS) || 3000, 0);
const MAX_MS = Math.max(Number(process.env.ARB_LOOP_MAX_MS) || 5.5 * 60 * 60 * 1000, 60_000);

const { runScan } = await import("@/lib/arb/scan-service");
const { runLoop } = await import("@/lib/arb/scan-loop-core");
const { sendDiscordAlert } = await import("@/lib/alerts/providers/discord");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const webhook = process.env.DISCORD_WEBHOOK_URL || "";
const alert = webhook
  ? async (msg: string) => {
      await sendDiscordAlert(webhook, { content: `⚠️ ${msg}` });
    }
  : undefined;

console.log(`[scan-loop] start N=${N} interval=${INTERVAL_MS}ms maxRuntime=${Math.round(MAX_MS / 60000)}min alerts=${webhook ? "on" : "off"}`);

const { ticks, exitCode } = await runLoop({
  runScan,
  sleep,
  now: Date.now,
  log: (m) => console.log(`[scan-loop] ${m}`),
  alert,
  n: N,
  intervalMs: INTERVAL_MS,
  maxMs: MAX_MS,
  errThreshold: Number(process.env.ARB_LOOP_ERR_THRESHOLD) || undefined,
  transientThreshold: Number(process.env.ARB_LOOP_TRANSIENT_THRESHOLD) || undefined,
});

console.log(`[scan-loop] finished after ${ticks} ticks — exiting ${exitCode}${exitCode ? " (sustained failure)" : " (clean restart)"}`);
process.exit(exitCode);
