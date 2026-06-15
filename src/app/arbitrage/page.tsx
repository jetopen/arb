"use client";

import { useState } from "react";
import { useArbOpportunities, useArbScanner, useLockGraphSummary } from "@/lib/hooks";
import { OpportunityTable } from "@/components/arb/opportunity-table";
import { OpportunityDetail } from "@/components/arb/opportunity-detail";
import { ScanStatus } from "@/components/arb/scan-status";
import { TrackedFamilies } from "@/components/arb/tracked-families";
import { LastUpdated } from "@/components/last-updated";
import type { Opportunity } from "@/lib/types";

type View = "opportunities" | "tracked";

const TIERS = [
  { label: "All tiers", value: 0 },
  { label: "$1,000", value: 1000 },
  { label: "$10,000", value: 10000 },
  { label: "$50,000", value: 50000 },
];

export default function ArbitragePage() {
  const [view, setView] = useState<View>("opportunities");
  const [tier, setTier] = useState(0);
  const [minNetPct, setMinNetPct] = useState<number | undefined>(undefined);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [selected, setSelected] = useState<Opportunity | null>(null);

  const { data: graph } = useLockGraphSummary();
  const scan = useArbScanner(12);
  const { data, error, isLoading, mutate } = useArbOpportunities({
    tier: tier || undefined,
    minNetPct,
    verifiedOnly,
    take: 100,
  });

  const opportunities = data?.opportunities ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Arbitrage</h1>
        <div className="flex items-center gap-3">
          <LastUpdated lastFetched={data?.lastScan?.finishedAt} />
          <button
            onClick={() => mutate()}
            className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted/50 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Honesty banner */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted">
        <span className="font-medium text-foreground">dePort cross-chain redemption arbitrage.</span>{" "}
        Real executable quotes (deBridge aggregator), grouped by lock origin (debridgeId) — never by symbol.
        Profitable candidates are cross-checked against KyberSwap + a GeckoTerminal liquidity gate.
        Solana/Tron not yet scanned. Screener only — not an auto-executor.
      </div>

      <ScanStatus graph={graph} scan={scan.data} lastScan={data?.lastScan} />

      {/* View tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {([
          ["opportunities", "Opportunities"],
          ["tracked", "Tracked deAssets"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              view === key
                ? "border-accent text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "opportunities" ? (
        <>
          {/* Filters */}
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted uppercase tracking-wider">Tier</label>
              <select
                value={tier}
                onChange={(e) => setTier(Number(e.target.value))}
                className="px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
              >
                {TIERS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted uppercase tracking-wider">Min net %</label>
              <select
                value={minNetPct ?? ""}
                onChange={(e) => setMinNetPct(e.target.value === "" ? undefined : Number(e.target.value))}
                className="px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
              >
                <option value="">Any</option>
                <option value="0">≥ 0% (profitable)</option>
                <option value="0.1">≥ 0.1%</option>
                <option value="0.5">≥ 0.5%</option>
                <option value="1">≥ 1%</option>
              </select>
            </div>
            <button
              onClick={() => setVerifiedOnly((v) => !v)}
              className={`px-3 py-2 text-sm rounded-md border transition-colors self-end ${verifiedOnly ? "bg-accent text-white border-accent" : "border-border hover:bg-muted/50"}`}
            >
              {verifiedOnly ? "✓ Verified only" : "Verified only"}
            </button>
            <div className="self-end text-sm text-muted">{data?.total ?? 0} opportunities</div>
          </div>

          <OpportunityTable
            opportunities={opportunities}
            loading={isLoading}
            error={error?.message ?? null}
            onSelect={setSelected}
            onRetry={() => mutate()}
          />
        </>
      ) : (
        <TrackedFamilies />
      )}

      {selected && <OpportunityDetail opp={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
