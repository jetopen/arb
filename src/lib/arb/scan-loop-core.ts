// Pure, testable driver for the continuous scan loop. scripts/scan-loop.mts is a thin shell that wires real
// deps (runScan, Date.now, setTimeout, Discord) into runLoop(). Extracted so the backoff / deadline / failure
// escalation logic — which runs ~24/7 in production — is unit-tested instead of living untestable at module
// top level (top-level await + process.exit made the old scan-loop.mts unimportable). Mirrors the ScanDeps
// dependency-injection pattern used by scanner.ts.

export interface RunScanResult {
  unitsProcessed?: number;
  remaining?: number;
  rpmAvailable?: number;
  transientCount?: number;
}

export interface RunLoopDeps {
  runScan: (n: number) => Promise<RunScanResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (msg: string) => void;
  /** Best-effort ops alert (Discord). Undefined when no webhook is configured. runLoop never lets it throw. */
  alert?: (msg: string) => Promise<void>;
  n: number;
  intervalMs: number;
  maxMs: number;
  /** Consecutive runScan throws before we alert + ABORT the job (exit 1 → red run → owner notified). Default 10. */
  errThreshold?: number;
  /** Consecutive ticks with >=50% of units failing transiently before a 429/quota-storm alert. Default 5. */
  transientThreshold?: number;
}

export interface LoopResult {
  ticks: number;
  /** 0 = clean deadline exit; 1 = aborted after sustained failure (job should exit non-zero). */
  exitCode: number;
}

/**
 * Run scan ticks until the deadline, then return exit code 0. The deadline is checked BETWEEN ticks (after a
 * runScan has fully returned and its markScanned has cleared leases), so a batch is never left half-marked.
 *
 * Two escalation paths that the old loop lacked:
 *  - Sustained THROWS (revoked key, dep broken, provider hard-down): alert once and return exitCode 1 so the
 *    run goes red — a permanent failure was previously an invisible green 5.5h of error logs.
 *  - Sustained TRANSIENT unit failures (provider 429 / quota): per-unit errors are swallowed into
 *    transientCount and never reach errStreak, so a fully-rate-limited loop looked healthy. Alert once when
 *    most of a non-empty batch fails transiently for several ticks (does NOT abort — it's a soft signal).
 */
export async function runLoop(deps: RunLoopDeps): Promise<LoopResult> {
  const start = deps.now();
  const errThreshold = deps.errThreshold ?? 10;
  const transientThreshold = deps.transientThreshold ?? 5;

  const safeAlert = async (msg: string) => {
    try {
      await deps.alert?.(msg);
    } catch {
      /* ops alert is best-effort; never let it break the loop */
    }
  };

  let tick = 0;
  let errStreak = 0;
  let transientStreak = 0;
  let transientAlerted = false;

  while (deps.now() - start < deps.maxMs) {
    tick++;
    try {
      const r = await deps.runScan(deps.n);
      errStreak = 0;
      const units = r.unitsProcessed ?? 0;
      const transient = r.transientCount ?? 0;
      deps.log(
        `tick=${tick} units=${units} remaining=${r.remaining ?? "?"} rpmFree=${r.rpmAvailable ?? "?"} ` +
          `transient=${transient} elapsed=${((deps.now() - start) / 60000).toFixed(1)}min`
      );

      if (units > 0 && transient / units >= 0.5) {
        transientStreak++;
        if (transientStreak >= transientThreshold && !transientAlerted) {
          await safeAlert(
            `scan loop: ${transient}/${units} units failing transiently for ${transientStreak} ticks — ` +
              `likely provider 429 / quota. Consider lowering ARB_SCAN_RPM.`
          );
          transientAlerted = true;
        }
      } else {
        transientStreak = 0;
        transientAlerted = false;
      }

      // Empty batch (queue momentarily drained / everything leased) → back off longer than a busy-poll.
      await deps.sleep(units > 0 ? deps.intervalMs : 15_000);
    } catch (err) {
      errStreak++;
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`tick=${tick} failed (streak=${errStreak}): ${msg}`);
      if (errStreak >= errThreshold) {
        await safeAlert(`scan loop: ${errStreak} consecutive failures — aborting run. Last error: ${msg}`);
        return { ticks: tick, exitCode: 1 };
      }
      const backoff = Math.min(60_000, (deps.intervalMs || 1000) * 2 ** errStreak);
      await deps.sleep(backoff);
    }
  }

  return { ticks: tick, exitCode: 0 };
}
