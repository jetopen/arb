import { describe, it, expect } from "vitest";
import { MemoryStore } from "../db/store";
import type { Opportunity, ScanUnit } from "../types";

function opp(id: string, netEdgePct: number, over: Partial<Opportunity> = {}): Opportunity {
  return {
    id,
    debridgeId: "0x" + id,
    kind: "redemption",
    buyChainId: 42161,
    sellChainId: 56,
    nativeChainId: 56,
    tierUsd: 10000,
    edge: {
      grossSpreadPct: 0,
      dexImpactBuyBps: 0,
      dexImpactSellBps: 0,
      deportFeeUsd: 0,
      gasBuyUsd: 0,
      gasSellUsd: 0,
      netUsd: netEdgePct * 100,
      netEdgePct,
      netUsdConservative: 0,
      profitable: netEdgePct > 0,
    },
    verification: null,
    lockPath: [],
    computedAt: 0,
    ...over,
  };
}

describe("MemoryStore opportunities", () => {
  it("upserts by id and ranks by net edge desc", async () => {
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

  it("filters by minNetPct, tier, chain, verifiedOnly", async () => {
    const s = new MemoryStore();
    await s.upsertOpportunities([
      opp("a", 0.1),
      opp("b", 1.0, { verification: { verified: true, sourcesAgreed: ["debridge", "kyberswap"], quoteDisagreementBps: 5, liquidityUsd: 1e6 } }),
      opp("c", 2.0, { buyChainId: 8453 }),
    ]);
    expect((await s.topOpportunities({ minNetPct: 0.5 })).total).toBe(2);
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
    expect(p1.opportunities[0].edge.netEdgePct).toBe(24); // highest first
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

  it("requeueFresh moves a route to the front of the time-ordered queue", async () => {
    const s = new MemoryStore();
    await s.enqueue([u("a"), u("b")]);
    await s.dequeue(2); // both get lastScannedAt = now
    await s.requeueFresh(["b:1:56:1000:redemption"]); // b reset to null → sorts first
    expect((await s.dequeue(1))[0].debridgeId).toBe("b");
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
