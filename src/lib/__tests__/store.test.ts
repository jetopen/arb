import { describe, it, expect } from "vitest";
import { MemoryStore, parsePenaltyMs, parseHotRatio, DEAD_ROUTE_PENALTY_MS, DEFAULT_OPP_MAX_AGE_MS, HOT_RATIO } from "../db/store";
import type { EdgeResult, Opportunity, ScanUnit } from "../types";

function opp(
  id: string,
  spreadPct: number,
  over: Partial<Omit<Opportunity, "edge">> & { edge?: Partial<EdgeResult> } = {}
): Opportunity {
  // `over` may carry a partial `edge` (e.g. a net value distinct from the gross spread); merge it onto
  // the default edge instead of letting `...over` replace the whole edge object.
  const { edge: edgeOver, ...rest } = over;
  return {
    id,
    debridgeId: "0x" + id,
    kind: "redemption",
    buyChainId: 42161,
    sellChainId: 56,
    nativeChainId: 56,
    tierUsd: 10000,
    edge: {
      grossSpreadPct: spreadPct,
      dexImpactBuyBps: 0,
      dexImpactSellBps: 0,
      deportFeeUsd: 0,
      gasBuyUsd: 0,
      gasSellUsd: 0,
      netUsd: spreadPct * 100,
      netEdgePct: spreadPct,
      netUsdConservative: 0,
      profitable: spreadPct > 0,
      ...edgeOver,
    },
    verification: null,
    lockPath: [],
    computedAt: 0,
    ...rest,
  };
}

describe("MemoryStore opportunities", () => {
  it("upserts by id and ranks by spread desc", async () => {
    const s = new MemoryStore();
    await s.upsertOpportunities([opp("a", 0.2), opp("b", 1.5), opp("c", 0.8)]);
    const { opportunities, total } = await s.topOpportunities({});
    expect(total).toBe(3);
    expect(opportunities.map((o) => o.id)).toEqual(["b", "c", "a"]);
    // upsert same id replaces
    await s.upsertOpportunities([opp("a", 2.0)]);
    const after = await s.topOpportunities({});
    expect(after.total).toBe(3);
    expect(after.opportunities[0].id).toBe("a");
  });

  it("filters by minSpreadPct, chain, verifiedOnly", async () => {
    const s = new MemoryStore();
    await s.upsertOpportunities([
      opp("a", 0.1),
      opp("b", 1.0, { verification: { verified: true, sourcesAgreed: ["debridge", "kyberswap"], quoteDisagreementBps: 5, liquidityUsd: 1e6 } }),
      opp("c", 2.0, { buyChainId: 8453 }),
    ]);
    expect((await s.topOpportunities({ minSpreadPct: 0.5 })).total).toBe(2);
    expect((await s.topOpportunities({ verifiedOnly: true })).total).toBe(1);
    expect((await s.topOpportunities({ chainId: 8453 })).total).toBe(1);
  });

  it("paginates", async () => {
    const s = new MemoryStore();
    await s.upsertOpportunities(Array.from({ length: 25 }, (_, i) => opp(`o${i}`, i)));
    const p1 = await s.topOpportunities({ page: 1, take: 10 });
    const p2 = await s.topOpportunities({ page: 2, take: 10 });
    expect(p1.opportunities).toHaveLength(10);
    expect(p2.opportunities).toHaveLength(10);
    expect(p1.total).toBe(25);
    expect(p1.opportunities[0].edge.grossSpreadPct).toBe(24); // highest spread first
  });

  it("groupByToken keeps the highest-spread row per debridgeId (one row per token)", async () => {
    const s = new MemoryStore();
    // two routes for the SAME token (same debridgeId) + a second token
    await s.upsertOpportunities([
      opp("t1-a", 0.5, { debridgeId: "0xtoken1" }),
      opp("t1-b", 1.2, { debridgeId: "0xtoken1" }),
      opp("t2", 0.8, { debridgeId: "0xtoken2" }),
    ]);
    const grouped = await s.topOpportunities({ groupByToken: true });
    expect(grouped.total).toBe(2); // two distinct tokens
    expect(grouped.opportunities.map((o) => o.id)).toEqual(["t1-b", "t2"]); // best of token1, then token2
    expect((await s.topOpportunities({})).total).toBe(3); // ungrouped returns every row
  });

  it("ranks and filters by gross spread, not net edge", async () => {
    const s = new MemoryStore();
    // x: high gross spread but deeply net-negative; y: lower spread but net-positive.
    await s.upsertOpportunities([
      opp("x", 2.0, { edge: { netEdgePct: -5, netUsd: -500, profitable: false } }),
      opp("y", 1.0, { edge: { netEdgePct: 1.0, netUsd: 100, profitable: true } }),
    ]);
    // Sorted by gross spread → x (2.0) before y (1.0) despite x's worse net.
    expect((await s.topOpportunities({})).opportunities.map((o) => o.id)).toEqual(["x", "y"]);
    // minSpreadPct filters on gross spread: x passes ≥1.5 even though its net is -5.
    const filtered = await s.topOpportunities({ minSpreadPct: 1.5 });
    expect(filtered.total).toBe(1);
    expect(filtered.opportunities[0].id).toBe("x");
  });

  it("breaks equal-spread ties by id (deterministic per-token winner)", async () => {
    const s = new MemoryStore();
    // Same token + same gross spread, different ids → lowest id wins the group.
    await s.upsertOpportunities([
      opp("z-b", 1.0, { debridgeId: "0xtok" }),
      opp("z-a", 1.0, { debridgeId: "0xtok" }),
    ]);
    const grouped = await s.topOpportunities({ groupByToken: true });
    expect(grouped.total).toBe(1);
    expect(grouped.opportunities[0].id).toBe("z-a");
  });
});

describe("MemoryStore work queue", () => {
  const unit: ScanUnit = { debridgeId: "0x1", buyChainId: 42161, sellChainId: 56, tierUsd: 10000, kind: "redemption" };

  it("dedupes enqueues and cycles dequeued units back to the tail", async () => {
    const s = new MemoryStore();
    await s.enqueue([unit, unit]); // dedup
    expect(await s.queueSize()).toBe(1);
    const batch = await s.dequeue(1);
    expect(batch).toHaveLength(1);
    // cycled back, not lost
    expect(await s.queueSize()).toBe(1);
  });

  it("records and returns the last scan run", async () => {
    const s = new MemoryStore();
    expect(await s.lastScanRun()).toBeNull();
    await s.recordScanRun({ startedAt: 1, finishedAt: 2, unitsProcessed: 3, quotesSpent: 6, opportunitiesFound: 1, partial: false });
    expect((await s.lastScanRun())?.opportunitiesFound).toBe(1);
  });

  it("honors priorityOf and dequeues least-recently-scanned first, priority breaks ties", async () => {
    const s = new MemoryStore();
    const u = (id: string): ScanUnit => ({ debridgeId: id, buyChainId: 1, sellChainId: 56, tierUsd: 1000, kind: "redemption" });
    const prio: Record<string, number> = { a: 1, b: 3, c: 2 };
    await s.enqueue([u("a"), u("b"), u("c")], (x) => prio[x.debridgeId]);
    // all unscanned → highest priority first
    expect((await s.dequeue(1))[0].debridgeId).toBe("b"); // 3
    expect((await s.dequeue(1))[0].debridgeId).toBe("c"); // 2 (b already scanned)
    expect((await s.dequeue(1))[0].debridgeId).toBe("a"); // 1
    // all scanned now → least-recently (b was first) cycles back
    expect((await s.dequeue(1))[0].debridgeId).toBe("b");
  });

  it("enqueue updates priority on conflict (parity with ON CONFLICT DO UPDATE)", async () => {
    const s = new MemoryStore();
    const u = (id: string): ScanUnit => ({ debridgeId: id, buyChainId: 1, sellChainId: 56, tierUsd: 1000, kind: "redemption" });
    await s.enqueue([u("a"), u("b")], () => 1);
    await s.enqueue([u("a")], () => 5); // raise a's priority, no duplicate
    expect(await s.queueSize()).toBe(2);
    expect((await s.dequeue(1))[0].debridgeId).toBe("a"); // 5 > 1
  });
});

describe("MemoryStore adaptive demotion + realized quotability", () => {
  const u = (id: string): ScanUnit => ({ debridgeId: id, buyChainId: 1, sellChainId: 56, tierUsd: 1000, kind: "redemption" });

  it("markScanned demotes dead routes so live routes are dequeued first next cycle", async () => {
    const s = new MemoryStore();
    await s.enqueue([u("live"), u("dead")]);
    await s.dequeue(2); // both unscanned -> both returned, lastScannedAt set
    await s.markScanned([
      { unit: u("live"), live: true },
      { unit: u("dead"), live: false }, // pushed ~6h into the future
    ]);
    // live route (lastScannedAt = now) sorts before the demoted dead route (now + penalty)
    expect((await s.dequeue(1))[0].debridgeId).toBe("live");
    expect((await s.dequeue(1))[0].debridgeId).toBe("live"); // dead route still skipped
  });

  it("does NOT demote a proven route on a single failure (transient-blip protection)", async () => {
    const s = new MemoryStore();
    await s.enqueue([u("proven"), u("deadx")]);
    await s.upsertOpportunities([opp("proven:1:56:1000:redemption", 0.3)]); // proven route
    await s.dequeue(2);
    await s.markScanned([
      { unit: u("proven"), live: false }, // failed this scan, but proven before → kept
      { unit: u("deadx"), live: false }, // never proven → demoted
    ]);
    expect((await s.dequeue(1))[0].debridgeId).toBe("proven"); // proven cycles, deadx is in the future
  });

  it("requeueFresh bumps priority so a proven route wins the tie-break among equally-stale peers", async () => {
    const s = new MemoryStore();
    await s.enqueue([u("a"), u("b")]);
    await s.dequeue(2); // both get the SAME lastScannedAt = now
    await s.requeueFresh(["b:1:56:1000:redemption"]); // b → priority 1; a stays 0
    expect((await s.dequeue(1))[0].debridgeId).toBe("b"); // equal staleness, higher priority wins
  });

  it("requeueFresh only bumps priority (never resets lastScannedAt); the cold lane still serves never-scanned routes (fix #2)", async () => {
    const s = new MemoryStore();
    await s.enqueue([u("proven")]);
    await s.dequeue(1); // proven scanned: lastScannedAt = now
    await s.enqueue([u("fresh")]); // a newly-discovered, never-scanned route (lastScannedAt = null)
    await s.requeueFresh(["proven:1:56:1000:redemption"]); // warm-start the proven route → priority 1
    // A realistic batch reserves the hot lane for the proven route AND the cold lane for the never-scanned
    // one — so warming a proven route does NOT starve discovery. The fix-#2 guarantee now holds via the
    // cold-lane reservation rather than pure time-ordering (and requeueFresh still never nulls the stamp).
    const batch = await s.dequeue(2);
    expect(batch.map((b) => b.debridgeId).sort()).toEqual(["fresh", "proven"]);
  });

  it("dequeue freshness gate holds the penalty even when the live set is smaller than the batch (fix #3)", async () => {
    const s = new MemoryStore();
    await s.enqueue([u("live"), u("dead")]);
    await s.dequeue(2);
    await s.markScanned([
      { unit: u("live"), live: true },
      { unit: u("dead"), live: false }, // demoted to now + 6h
    ]);
    // Ask for a batch BIGGER than the eligible set: the demoted route must NOT be re-dequeued to fill
    // it. Only "live" (and not "dead", which is in the future) comes back.
    const batch = await s.dequeue(5);
    expect(batch.map((b) => b.debridgeId)).toEqual(["live"]);
  });

  it("knownUnitIds returns the ids of routes that have produced a quote", async () => {
    const s = new MemoryStore();
    expect((await s.knownUnitIds()).size).toBe(0);
    await s.upsertOpportunities([opp("0xabc:1:56:1000:redemption", 0.5)]);
    const known = await s.knownUnitIds();
    expect(known.has("0xabc:1:56:1000:redemption")).toBe(true);
    expect(known.size).toBe(1);
  });
});

describe("DEAD_ROUTE_PENALTY_MS env parsing (fix #5)", () => {
  it("falls back to the default for a non-numeric / empty / negative override (never NaN)", () => {
    const DEFAULT = 6 * 60 * 60 * 1000;
    expect(parsePenaltyMs(undefined, DEFAULT)).toBe(DEFAULT); // unset
    expect(parsePenaltyMs("6h", DEFAULT)).toBe(DEFAULT); // non-numeric -> would be NaN -> RangeError
    expect(parsePenaltyMs("abc", DEFAULT)).toBe(DEFAULT);
    expect(parsePenaltyMs("-1000", DEFAULT)).toBe(DEFAULT); // negative rejected
    expect(parsePenaltyMs("", DEFAULT)).toBe(0); // empty string parses to 0 (preserves prior semantics)
    expect(parsePenaltyMs("1800000", DEFAULT)).toBe(1_800_000); // valid override honored
  });

  it("the exported constant is always a finite, non-negative number", () => {
    expect(Number.isFinite(DEAD_ROUTE_PENALTY_MS)).toBe(true);
    expect(DEAD_ROUTE_PENALTY_MS).toBeGreaterThanOrEqual(0);
    // The whole point: new Date(now + penalty).toISOString() must never throw RangeError.
    expect(() => new Date(Date.now() + DEAD_ROUTE_PENALTY_MS).toISOString()).not.toThrow();
  });
});

describe("MemoryStore freshness gate (maxAgeMs)", () => {
  it("excludes opportunities older than the cutoff", async () => {
    const s = new MemoryStore();
    const fresh = opp("fresh", 1);
    fresh.computedAt = Date.now();
    const stale = opp("stale", 9); // higher edge, but old
    stale.computedAt = Date.now() - 2 * 3_600_000; // 2h
    await s.upsertOpportunities([fresh, stale]);
    expect((await s.topOpportunities({})).total).toBe(2); // no gate → both
    const recent = await s.topOpportunities({ maxAgeMs: 3_600_000 }); // 1h
    expect(recent.total).toBe(1);
    expect(recent.opportunities[0].id).toBe("fresh"); // stale dropped despite higher edge
  });
});

describe("MemoryStore alert dedup (filterNewAlerts)", () => {
  it("returns only ids not previously recorded", async () => {
    const s = new MemoryStore();
    expect(await s.filterNewAlerts(["a", "b"])).toEqual(["a", "b"]); // both new
    expect(await s.filterNewAlerts(["a", "b"])).toEqual([]); // already alerted
    expect(await s.filterNewAlerts(["b", "c"])).toEqual(["c"]); // only the new one
    expect(await s.filterNewAlerts([])).toEqual([]);
  });
});

describe("read-freshness default decoupled from dead-route penalty (Fix 1)", () => {
  it("DEFAULT_OPP_MAX_AGE_MS is 24h and wider than the 6h dead-route penalty", () => {
    expect(DEFAULT_OPP_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_OPP_MAX_AGE_MS).toBeGreaterThan(DEAD_ROUTE_PENALTY_MS);
    expect(parsePenaltyMs(undefined, DEFAULT_OPP_MAX_AGE_MS)).toBe(24 * 60 * 60 * 1000); // unset env → 24h
  });
});

describe("hot-lane dequeue (Fix 3)", () => {
  const u = (id: string): ScanUnit => ({ debridgeId: id, buyChainId: 1, sellChainId: 56, tierUsd: 1000, kind: "redemption" });

  it("parseHotRatio clamps to 0..1 and defaults to 0.5; HOT_RATIO is the parsed env", () => {
    expect(parseHotRatio(undefined)).toBe(0.5);
    expect(parseHotRatio("abc")).toBe(0.5);
    expect(parseHotRatio("2")).toBe(0.5); // out of range → default
    expect(parseHotRatio("-0.1")).toBe(0.5);
    expect(parseHotRatio("0.25")).toBe(0.25);
    expect(parseHotRatio("0")).toBe(0);
    expect(HOT_RATIO).toBeGreaterThanOrEqual(0);
    expect(HOT_RATIO).toBeLessThanOrEqual(1);
  });

  it("reserves the hot lane for proven (priority>=1) routes, refreshing them alongside cold discovery", async () => {
    const s = new MemoryStore();
    await s.enqueue([u("p")], () => 1); // proven (priority 1)
    await s.enqueue([u("c1"), u("c2"), u("c3")]); // never-scanned cold (priority 0)
    // n=2 → hotN=ceil(2*0.5)=1: the proven route takes the hot slot; one cold route fills the rest.
    const batch = await s.dequeue(2);
    expect(batch).toHaveLength(2);
    expect(batch.map((b) => b.debridgeId)).toContain("p");
    expect(batch.filter((b) => b.debridgeId === "p")).toHaveLength(1); // taken once, not by both lanes
  });

  it("the hot lane still respects the freshness gate — a demoted proven route is skipped", async () => {
    const s = new MemoryStore();
    await s.enqueue([u("p")], () => 1); // priority 1 but no opportunity row → unproven on failure
    await s.dequeue(2);
    await s.markScanned([{ unit: u("p"), live: false }]); // demoted to now + 6h
    expect(await s.dequeue(2)).toHaveLength(0); // past the freshness gate, even though priority>=1
  });

  it("never returns the same proven row in both lanes within one dequeue", async () => {
    const s = new MemoryStore();
    await s.enqueue([u("p1"), u("p2")], () => 1); // both proven
    const ids = (await s.dequeue(2)).map((b) => b.debridgeId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2); // no duplicate across hot + cold
  });
});
