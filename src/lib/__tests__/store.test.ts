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
});
