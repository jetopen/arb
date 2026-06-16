// Scan driver: keeps the cross-chain scanner advancing without an open browser tab.
// Scanning only happens when something polls /api/arb/scan; this is that "something" for headless hosting.
// Host-agnostic — it just HTTP-fetches the route (no app-code import), like backfill-deport-events.cjs.
//
// Usage:
//   node scripts/scan-driver.mjs            # loop forever (run as a Heroku `worker:` dyno)
//   node scripts/scan-driver.mjs --once     # single batch then exit (run under any scheduler)
//
// Env (loaded from .env.local in dev via @next/env; real config vars in prod):
//   SCAN_DRIVER_URL          base URL of the app          (default http://localhost:3000)
//   SCAN_DRIVER_N            units per batch, 1..32        (default 24)
//   SCAN_DRIVER_INTERVAL_MS  loop interval                 (default 12000)
//   CRON_SECRET              if set, sent as Bearer auth   (must match the app's CRON_SECRET)

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

const BASE = (process.env.SCAN_DRIVER_URL || "http://localhost:3000").replace(/\/+$/, "");
const N = Math.min(Math.max(Number(process.env.SCAN_DRIVER_N) || 24, 1), 32);
const INTERVAL = Math.max(Number(process.env.SCAN_DRIVER_INTERVAL_MS) || 12_000, 1_000);
const SECRET = process.env.CRON_SECRET;
const ONCE = process.argv.includes("--once");

const headers = SECRET ? { authorization: `Bearer ${SECRET}` } : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tick() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/arb/scan?n=${N}`, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[scan-driver] ${res.status} ${res.statusText}: ${body?.error ?? "(no body)"}`);
      return;
    }
    console.log(
      `[scan-driver] units=${body.unitsProcessed ?? "?"} remaining=${body.remaining ?? "?"} ` +
        `rpmFree=${body.rpmAvailable ?? "?"} (${Date.now() - t0}ms)`
    );
  } catch (err) {
    console.error("[scan-driver] fetch failed:", err?.message ?? err);
  }
}

if (ONCE) {
  await tick();
} else {
  console.log(`[scan-driver] looping ${BASE}/api/arb/scan?n=${N} every ${INTERVAL}ms (auth=${SECRET ? "on" : "off"})`);
  for (;;) {
    await tick();
    await sleep(INTERVAL);
  }
}
