"use client";

import { useState } from "react";
import { useSymbiosis } from "@/lib/hooks";
import { SymTable } from "@/components/symbiosis/sym-table";
import { SymDetail } from "@/components/symbiosis/sym-detail";
import { LastUpdated } from "@/components/last-updated";
import type { SymOpportunity } from "@/lib/symbiosis/types";

export default function SymbiosisPage() {
  const { data, error, isLoading, mutate } = useSymbiosis();
  const [selected, setSelected] = useState<SymOpportunity | null>(null);
  const [btcOnly, setBtcOnly] = useState(false);

  const all = data?.opportunities ?? [];
  const opportunities = btcOnly ? all.filter((o) => o.btcFamily) : all;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Symbiosis Octopools</h1>
        <div className="flex items-center gap-3">
          <LastUpdated lastFetched={data?.fetchedAt} />
          <button onClick={() => mutate()} className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted/50 transition-colors">Refresh</button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted">
        <span className="font-medium text-foreground">Live positive-spread cross-chain routes.</span>{" "}
        Symbiosis Octopools mint wrapped sTokens 1:1 but price them via AMM, so same-asset wraps diverge. This is
        Symbiosis&apos;s own ranked spread feed — click a route for an executable net quote across clip sizes. Real &amp;
        executable, time-sensitive; micro-cap routes carry fill/liquidity risk. Screener, not an auto-executor.
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={() => setBtcOnly((v) => !v)}
          className={`px-3 py-2 text-sm rounded-md border transition-colors ${btcOnly ? "bg-accent text-white border-accent" : "border-border hover:bg-muted/50"}`}
        >
          {btcOnly ? "✓ BTC wraps only" : "BTC wraps only"}
        </button>
        <span className="text-sm text-muted">{opportunities.length} routes{data ? ` of ${data.total} live` : ""}</span>
      </div>

      <SymTable
        opportunities={opportunities}
        loading={isLoading}
        error={error?.message ?? null}
        onSelect={setSelected}
        onRetry={() => mutate()}
      />

      {selected && <SymDetail opp={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
