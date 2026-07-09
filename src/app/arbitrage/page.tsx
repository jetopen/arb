"use client";

import { useMemo, useState } from "react";
import { useArbOpportunities, useArbScanner, useLockGraphSummary } from "@/lib/hooks";
import { OpportunityTable, type SortKey } from "@/components/arb/opportunity-table";
import { OpportunityDetail } from "@/components/arb/opportunity-detail";
import { ScanStatus } from "@/components/arb/scan-status";
import { TrackedFamilies } from "@/components/arb/tracked-families";
import { LastUpdated } from "@/components/last-updated";
import { chainName } from "@/lib/deport/registry";
import type { Opportunity } from "@/lib/types";

type View = "opportunities" | "tracked";

const PAGE_SIZE = 200;
// Fallback capital ladder for first paint / older API responses. The live list comes from the API
// (`data.tiers`, which mirrors the actually-scanned ARB_SCAN_NOTIONAL_USD ladder) so the selector never
// offers a rung that wasn't scanned. "Best size" (undefined) keeps each token's highest-spread rung.
const CAPITAL_TIERS_FALLBACK = [10, 25, 50, 100];

export default function ArbitragePage() {
  const [view, setView] = useState<View>("opportunities");
  const [minSpreadPct, setMinSpreadPct] = useState<number | undefined>(undefined);
  const [tierUsd, setTierUsd] = useState<number | undefined>(undefined);
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [executableOnly, setExecutableOnly] = useState(false);
  const [netPositiveOnly, setNetPositiveOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("gross");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Opportunity | null>(null);

  const { data: graph } = useLockGraphSummary();
  const scan = useArbScanner(24);
  const { data, error, isLoading, mutate } = useArbOpportunities({
    minSpreadPct,
    chainId,
    tierUsd,
    verifiedOnly,
    executableOnly,
    // Show every token that EVER produced a two-sided quote (all-time), not just the fresh window —
    // staleness is surfaced per-row (amber pill + dimming past gateMs) instead of by hiding rows.
    maxAgeMs: 0,
    take: PAGE_SIZE,
    page,
  });

  const opportunities = data?.opportunities ?? [];
  const total = data?.total ?? 0;
  const gateMs = data?.gateMs;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Offer exactly the rungs the scanner actually probed (from the API), falling back before first load.
  const capitalTiers = data?.tiers ?? CAPITAL_TIERS_FALLBACK;

  // Sort key + net-positive filter are CLIENT-SIDE: groupByToken returns ~1 row/token (all on one page), so we
  // reorder/trim the returned rows directly rather than round-tripping. (Chain filter IS server-side via the hook.)
  const displayed = useMemo(() => {
    let list = netPositiveOnly ? opportunities.filter((o) => o.edge.netUsdConservative > 0) : opportunities;
    const val = sortKey === "net" ? (o: Opportunity) => o.edge.netUsdConservative : (o: Opportunity) => o.edge.grossSpreadPct;
    return [...list].sort((a, b) => val(b) - val(a));
  }, [opportunities, netPositiveOnly, sortKey]);
  // Fresh-vs-all-time context chip: how many of the SHOWN tokens are inside the freshness gate. Must be
  // derived from `displayed` (post the client Net-positive/sort filters), not the raw page — otherwise the
  // count can exceed the tokens on screen (e.g. "3 tokens · 40 fresh") once Net-positive is toggled.
  const freshCount = useMemo(
    () => (gateMs && gateMs > 0 ? displayed.filter((o) => o.computedAt && Date.now() - o.computedAt <= gateMs).length : displayed.length),
    [displayed, gateMs]
  );
  // Chain selector options: the scanned-chain set (stable regardless of the active chain filter).
  const chainOptions = useMemo(
    () => (graph?.chainsScanned ?? []).map((id) => ({ id, name: chainName(id) })).sort((a, b) => a.name.localeCompare(b.name)),
    [graph?.chainsScanned]
  );

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
        <span className="font-medium text-foreground">dePort cross-chain redemption spreads.</span>{" "}
        Real executable round-trip quotes (deBridge aggregator + Jupiter on Solana) probed across a small
        capital ladder ($10–$100) over EVM <span className="font-medium text-foreground">and non-EVM</span>{" "}
        chains (Solana, Sei, Tron, HyperEVM, …), grouped by lock origin (debridgeId) — never by symbol —
        one row per token showing its <span className="font-medium text-foreground">best size</span> (or
        pin one with the Capital filter). Spread is the gross price gap before fees &amp; gas: open a row
        for the $10–$5k optimizer (net profit, break-even, gross-positive window). Net-profitable
        candidates are cross-checked against KyberSwap (or a GeckoTerminal spot price where Kyber has no
        coverage) + a liquidity gate. Note: some chains carry heavy gas (e.g. Tron ≈ $27/trade), so their
        rows list but rarely net out. Screener only — not an auto-executor.
      </div>

      <ScanStatus graph={graph} scan={scan.data} lastScan={data?.lastScan} gateMs={data?.gateMs} />

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
              <label className="text-xs font-medium text-muted uppercase tracking-wider">Capital</label>
              <select
                value={tierUsd ?? ""}
                onChange={(e) => {
                  setTierUsd(e.target.value === "" ? undefined : Number(e.target.value));
                  setPage(1);
                }}
                className="px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
              >
                <option value="">Best size</option>
                {capitalTiers.map((t) => (
                  <option key={t} value={t}>
                    ${t}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted uppercase tracking-wider">Min spread %</label>
              <select
                value={minSpreadPct ?? ""}
                onChange={(e) => {
                  setMinSpreadPct(e.target.value === "" ? undefined : Number(e.target.value));
                  setPage(1);
                }}
                className="px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
              >
                <option value="">Any</option>
                <option value="0">≥ 0% (positive)</option>
                <option value="0.1">≥ 0.1%</option>
                <option value="0.5">≥ 0.5%</option>
                <option value="1">≥ 1%</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted uppercase tracking-wider">Chain</label>
              <select
                value={chainId ?? ""}
                onChange={(e) => {
                  setChainId(e.target.value === "" ? undefined : Number(e.target.value));
                  setPage(1);
                }}
                title="Show only routes whose buy or sell leg is on this chain"
                className="px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
              >
                <option value="">All chains</option>
                {chainOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={() => {
                setVerifiedOnly((v) => !v);
                setPage(1);
              }}
              className={`px-3 py-2 text-sm rounded-md border transition-colors self-end ${verifiedOnly ? "bg-accent text-white border-accent" : "border-border hover:bg-muted/50"}`}
            >
              {verifiedOnly ? "✓ Verified only" : "Verified only"}
            </button>
            <button
              onClick={() => {
                setExecutableOnly((v) => !v);
                setPage(1);
              }}
              title="Only routes whose tx simulation proved the executable path (requires ARB_SIMULATE on the scanner)"
              className={`px-3 py-2 text-sm rounded-md border transition-colors self-end ${executableOnly ? "bg-accent text-white border-accent" : "border-border hover:bg-muted/50"}`}
            >
              {executableOnly ? "✓ Executable only" : "Executable only"}
            </button>
            <button
              onClick={() => setNetPositiveOnly((v) => !v)}
              title="Show only rows whose net (after fees, gas, slippage) is positive at the probe size"
              className={`px-3 py-2 text-sm rounded-md border transition-colors self-end ${netPositiveOnly ? "bg-accent text-white border-accent" : "border-border hover:bg-muted/50"}`}
            >
              {netPositiveOnly ? "✓ Net-positive" : "Net-positive"}
            </button>
            <div className="self-end text-sm text-muted" title="Fresh = quoted inside the freshness gate; the rest are shown dimmed with a stale badge">
              {displayed.length} tokens · <span className="text-foreground">{freshCount} fresh</span>
            </div>
          </div>

          <OpportunityTable
            opportunities={displayed}
            loading={isLoading}
            error={error?.message ?? null}
            onSelect={setSelected}
            onRetry={() => mutate()}
            sortKey={sortKey}
            onSort={setSortKey}
            gateMs={gateMs}
          />

          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-4 text-sm">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 rounded-md border border-border hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ← Prev
              </button>
              <span className="text-muted">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1.5 rounded-md border border-border hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            </div>
          )}
        </>
      ) : (
        <TrackedFamilies />
      )}

      {selected && <OpportunityDetail opp={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
