import { describe, it, expect } from "vitest";
import { rowToOpp, oppToItem, rowToUnit } from "../db/supabase-store";
import { MemoryStore } from "../db/store";
import type { Opportunity, Family } from "../types";

function opp(id: string, profitable: boolean, netEdgePct = 1): Opportunity {
  return {
    id,
    debridgeId: "0x" + id,
    kind: "redemption",
    symbol: "TKN",
    buyChainId: 42161,
    sellChainId: 56,
    nativeChainId: 56,
    tierUsd: 10000,
    edge: {
      grossSpreadPct: netEdgePct + 0.1,
      dexImpactBuyBps: 1,
      dexImpactSellBps: 2,
      deportFeeUsd: 4,
      gasBuyUsd: 0.5,
      gasSellUsd: 0.5,
      netUsd: netEdgePct * 100,
      netEdgePct,
      netUsdConservative: 0,
      profitable,
    },
    verification: profitable
      ? { verified: true, sourcesAgreed: ["debridge", "kyberswap"], quoteDisagreementBps: 5, liquidityUsd: 1e6 }
      : null,
    lockPath: [{ chainId: 42161, address: "0xdead", role: "buy" }],
    computedAt: 1000,
  };
}

describe("supabase row mappers", () => {
  it("oppToItem flattens the ranking columns and keeps the full edge jsonb", () => {
    const item = oppToItem(opp("a", true, 1.5));
    expect(item.id).toBe("a");
    expect(item.net_edge_pct).toBe(1.5);
    expect(item.gross_spread_pct).toBeCloseTo(1.6, 6);
    expect(item.buy_chain_id).toBe(42161);
    expect(item.edge.profitable).toBe(true);
    expect(item.verification).not.toBeNull();
  });

  it("oppToItem.verified reflects verification.verified, NOT edge.profitable (C1)", () => {
    // profitable but NOT verified (e.g. liquidity gate tripped) -> verified must be false
    const o = opp("b", true, 2);
    o.verification = { verified: false, sourcesAgreed: ["debridge"], quoteDisagreementBps: null, liquidityUsd: 1000, rejectReason: "liquidity $1000 < tier $10000" };
    expect(oppToItem(o).verified).toBe(false);
    expect(o.edge.profitable).toBe(true); // ...even though it's profitable
    // verified candidate -> true
    const o2 = opp("c", true, 2);
    expect(oppToItem(o2).verified).toBe(true);
  });

  it("rowToOpp reconstructs an Opportunity (snake_case + timestamps + counters)", () => {
    const o = rowToOpp({
      id: "a",
      debridge_id: "0xa",
      kind: "redemption",
      symbol: "TKN",
      buy_chain_id: 42161,
      sell_chain_id: 56,
      native_chain_id: 56,
      tier_usd: 10000,
      edge: { netEdgePct: 1.5, netUsd: 150, grossSpreadPct: 1.6, profitable: true },
      verification: null,
      lock_path: [{ chainId: 42161, address: "0xdead", role: "buy" }],
      computed_at: "2026-06-14T00:00:00.000Z",
      times_seen: 3,
      times_profitable: 2,
      first_seen_at: "2026-06-13T00:00:00.000Z",
    });
    expect(o.buyChainId).toBe(42161);
    expect(o.edge.netEdgePct).toBe(1.5);
    expect(o.timesSeen).toBe(3);
    expect(o.timesProfitable).toBe(2);
    expect(o.computedAt).toBe(Date.parse("2026-06-14T00:00:00.000Z"));
  });

  it("rowToUnit maps a work_queue row to a ScanUnit", () => {
    expect(rowToUnit({ debridge_id: "0xa", buy_chain_id: 1, sell_chain_id: 56, tier_usd: 1000, kind: "redemption" })).toEqual({
      debridgeId: "0xa",
      buyChainId: 1,
      sellChainId: 56,
      tierUsd: 1000,
      kind: "redemption",
    });
  });
});

describe("MemoryStore times tracking + families (Supabase parity)", () => {
  it("increments times_seen every upsert and times_profitable only when profitable", async () => {
    const s = new MemoryStore();
    await s.upsertOpportunities([opp("a", false)]); // seen 1, profitable 0
    await s.upsertOpportunities([opp("a", true)]); // seen 2, profitable 1
    await s.upsertOpportunities([opp("a", true)]); // seen 3, profitable 2
    const { opportunities } = await s.topOpportunities({});
    const a = opportunities.find((o) => o.id === "a")!;
    expect(a.timesSeen).toBe(3);
    expect(a.timesProfitable).toBe(2);
    expect(a.firstSeenAt).toBe(1000); // preserved from first upsert
  });

  it("round-trips families through save/load", async () => {
    const s = new MemoryStore();
    expect(await s.loadFamilies()).toBeNull();
    const fams: Family[] = [
      { debridgeId: "0x1", nativeChainId: 56, nativeAddress: "0xn", nativeOnHomeChain: true, reps: [] },
    ];
    await s.saveFamilies(fams);
    expect(await s.loadFamilies()).toEqual(fams);
  });
});
