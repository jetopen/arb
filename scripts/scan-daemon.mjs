// Unattended cycling scanner. Polls the scan endpoint in a loop so the work_queue keeps draining
// even when no browser is open. Reuses the API (and therefore the SupabaseStore) — no DB code here.
//
// Usage:  node scripts/scan-daemon.mjs
// Env:    ARB_BASE (default http://localhost:3000), ARB_N (units/tick, default 16),
//         ARB_INTERVAL_MS (default 7000)

const BASE = process.env.ARB_BASE ?? "http://localhost:3000";
const N = Number(process.env.ARB_N ?? 16);
const INTERVAL = Number(process.env.ARB_INTERVAL_MS ?? 7000);

console.log(`[arb-daemon] -> ${BASE}/api/arb/scan?n=${N} every ${INTERVAL}ms`);

// Build the lock-graph once up front (first call can take ~20s).
try {
  const g = await (await fetch(`${BASE}/api/arb/graph`)).json();
  console.log(`[arb-daemon] graph: ${g.families} families, ${g.multiChainFamilies} multi-chain, ${g.chainsScanned?.length} chains`);
} catch (e) {
  console.error("[arb-daemon] graph warmup failed:", e.message);
}

let consecutiveErrors = 0;
for (;;) {
  try {
    const res = await fetch(`${BASE}/api/arb/scan?n=${N}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    consecutiveErrors = 0;
    console.log(
      `[arb-daemon] ${new Date().toISOString()} units=${d.unitsProcessed} found=${d.opportunitiesFound} remaining=${d.remaining} rpm=${d.rpmAvailable}`
    );
  } catch (e) {
    consecutiveErrors++;
    console.error(`[arb-daemon] scan error (${consecutiveErrors}):`, e.message);
  }
  // back off when the server is unhealthy so we don't hammer it
  const wait = consecutiveErrors > 0 ? Math.min(INTERVAL * 2 ** consecutiveErrors, 60_000) : INTERVAL;
  await new Promise((r) => setTimeout(r, wait));
}
