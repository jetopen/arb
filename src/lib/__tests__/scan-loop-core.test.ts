import { describe, it, expect } from "vitest";
import { runLoop, type RunLoopDeps, type RunScanResult } from "../arb/scan-loop-core";

// Harness with a virtual clock: time only advances when the loop sleeps, so we can drive the deadline
// deterministically and inspect the exact backoff/sleep sequence.
function harness(scan: (n: number) => Promise<RunScanResult>, opts: Partial<RunLoopDeps> = {}) {
  let t = 0;
  const sleeps: number[] = [];
  const alerts: string[] = [];
  const deps: RunLoopDeps = {
    runScan: scan,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    log: () => {},
    alert: async (m: string) => {
      alerts.push(m);
    },
    n: 10,
    intervalMs: 1000,
    maxMs: 10_000,
    ...opts,
  };
  return { deps, sleeps, alerts };
}

describe("runLoop", () => {
  it("runs ticks until the deadline then exits cleanly (0)", async () => {
    const h = harness(async () => ({ unitsProcessed: 5 }));
    const res = await runLoop(h.deps);
    expect(res.exitCode).toBe(0);
    expect(res.ticks).toBe(10); // maxMs 10_000 / interval 1_000
    expect(h.sleeps.every((s) => s === 1000)).toBe(true); // busy path sleeps the interval
  });

  it("backs off longer (15s) on an empty batch", async () => {
    const h = harness(async () => ({ unitsProcessed: 0 }), { maxMs: 30_000 });
    await runLoop(h.deps);
    expect(h.sleeps.every((s) => s === 15_000)).toBe(true);
  });

  it("backs off exponentially on failure, caps at 60s, and resets on success", async () => {
    let call = 0;
    const h = harness(
      async () => {
        call++;
        if (call <= 3) throw new Error("boom");
        return { unitsProcessed: 5 };
      },
      { maxMs: 100_000, errThreshold: 10 }
    );
    await runLoop(h.deps);
    // errStreak 1/2/3 → 2000, 4000, 8000; then success resets to the interval
    expect(h.sleeps.slice(0, 4)).toEqual([2000, 4000, 8000, 1000]);
  });

  it("caps the failure backoff at 60s", async () => {
    const h = harness(async () => {
      throw new Error("x");
    }, { maxMs: 1e9, errThreshold: 20 });
    const res = await runLoop(h.deps);
    expect(res.exitCode).toBe(1);
    expect(h.sleeps[5]).toBe(60_000); // errStreak 6: 1000*2^6=64000 capped to 60000
    expect(Math.max(...h.sleeps)).toBe(60_000);
  });

  it("alerts ONCE and aborts (exit 1) after errThreshold consecutive failures", async () => {
    const h = harness(async () => {
      throw new Error("dead");
    }, { maxMs: 1e9, errThreshold: 3 });
    const res = await runLoop(h.deps);
    expect(res.exitCode).toBe(1);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain("consecutive failures");
  });

  it("alerts ONCE on a sustained transient-failure storm but does NOT abort", async () => {
    const h = harness(async () => ({ unitsProcessed: 10, transientCount: 8 }), {
      maxMs: 60_000,
      transientThreshold: 3,
    });
    const res = await runLoop(h.deps);
    expect(res.exitCode).toBe(0);
    expect(h.alerts.filter((a) => a.includes("transiently"))).toHaveLength(1);
  });

  it("never throws when no alert sink is configured", async () => {
    const h = harness(async () => {
      throw new Error("x");
    }, { maxMs: 1e9, errThreshold: 2, alert: undefined });
    const res = await runLoop(h.deps);
    expect(res.exitCode).toBe(1);
  });
});
