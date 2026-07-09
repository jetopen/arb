import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OpportunityRow } from "../opportunity-row";
import type { Opportunity } from "@/lib/types";

const GATE_MS = 4 * 60 * 60 * 1000;

function opp(ageMs: number): Opportunity {
  return {
    id: "0xabc:8453:56:10:redemption",
    debridgeId: "0xabc",
    kind: "redemption",
    symbol: "TKN",
    buyChainId: 8453,
    sellChainId: 56,
    nativeChainId: 56,
    tierUsd: 10,
    edge: {
      grossSpreadPct: 2.4,
      dexImpactBuyBps: 1,
      dexImpactSellBps: 2,
      deportFeeUsd: 1,
      gasBuyUsd: 0.1,
      gasSellUsd: 0.1,
      netUsd: 0.5,
      netEdgePct: 0.5,
      netUsdConservative: 0.4,
      profitable: true,
    },
    verification: null,
    lockPath: [{ chainId: 8453, address: "0xdead", role: "buy" }],
    computedAt: Date.now() - ageMs,
  };
}

function renderRow(o: Opportunity, gateMs?: number) {
  return render(
    <table>
      <tbody>
        <OpportunityRow opp={o} index={0} colSpan={11} onSelect={() => {}} gateMs={gateMs} />
      </tbody>
    </table>
  );
}

describe("OpportunityRow two-tier staleness", () => {
  it("fresh row: no stale badge, no dimming", () => {
    const { container } = renderRow(opp(5 * 60_000), GATE_MS);
    expect(screen.queryByText(/stale ·/)).toBeNull();
    expect(container.querySelector("tr")?.className).not.toContain("opacity-55");
  });

  it("past the gate: dimmed row + amber stale badge with the age", () => {
    const { container } = renderRow(opp(GATE_MS + 60 * 60_000), GATE_MS);
    const badge = screen.getByText(/stale ·/);
    expect(badge.className).toContain("bg-amber-100");
    expect(container.querySelector("tr")?.className).toContain("opacity-55");
  });

  it("aging-but-inside-gate row gets the amber age text only (tier 1), not the badge", () => {
    const { container } = renderRow(opp(60 * 60_000), GATE_MS); // 1h: > 35min tier-1, < 4h gate
    expect(screen.queryByText(/stale ·/)).toBeNull();
    expect(container.querySelector(".text-amber-600")).toBeTruthy(); // tier-1 age text
    expect(container.querySelector("tr")?.className).not.toContain("opacity-55");
  });

  it("tier-2 styling is off when gateMs is absent or 0 (back-compat)", () => {
    renderRow(opp(3 * 24 * 60 * 60_000)); // 3 days old, no gate
    expect(screen.queryByText(/stale ·/)).toBeNull();
    renderRow(opp(3 * 24 * 60 * 60_000), 0);
    expect(screen.queryByText(/stale ·/)).toBeNull();
  });
});
