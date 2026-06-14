"use client";

import { useCallback, useMemo, useState } from "react";
import { useLzOfts } from "@/lib/hooks";
import type { LzOftToken } from "@/lib/layerzero/types";
import { StatsHeader, type LzStats } from "@/components/lz/stats";
import {
  FilterBar,
  DEFAULT_LZ_FILTERS,
  type LzFilterState,
  type ChainOption,
} from "@/components/lz/filters";
import { TokenCard, itemKey } from "@/components/lz/token-card";
import { TokenDetail, type LzDetailContext } from "@/components/lz/token-detail";
import { ExportButton, type LzExportRow } from "@/components/lz/export-button";

const MAX_CARDS = 48;

/** True when the token's deployments include an EVM chain. */
function hasEvm(t: LzOftToken): boolean {
  return t.deployments.some((d) => d.evmChainId != null);
}

/** Match the endpoint filter against a token's (free-form) endpointVersion string. */
function matchEndpoint(t: LzOftToken, ep: LzFilterState["endpoint"]): boolean {
  if (ep === "all") return true;
  const v = t.endpointVersion.toLowerCase();
  if (ep === "v2") return v.includes("2");
  return v.includes("1") && !v.includes("2");
}

/** Merge a partial map into prev, returning prev unchanged when nothing differs (stable refs). */
function mergeMap(
  prev: Record<string, number | null>,
  partial: Record<string, number | null>
): Record<string, number | null> {
  let changed = false;
  const next = { ...prev };
  for (const [k, v] of Object.entries(partial)) {
    if (next[k] !== v) {
      next[k] = v;
      changed = true;
    }
  }
  return changed ? next : prev;
}

/** Sum of known (loaded) liquidity for a token, from the accumulated liquidity map. */
function tokenLiquidity(t: LzOftToken, liq: Record<string, number | null>): number {
  let sum = 0;
  for (const d of t.deployments) {
    const v = liq[itemKey(d)];
    if (typeof v === "number") sum += v;
  }
  return sum;
}

interface OpenDetail {
  token: LzOftToken;
  ctx: LzDetailContext;
}

export default function LayerZeroPage() {
  const { data, isLoading, error } = useLzOfts();
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<LzFilterState>(DEFAULT_LZ_FILTERS);
  const [detail, setDetail] = useState<OpenDetail | null>(null);

  // Liquidity accumulates as cards scroll into view and resolve; powers stats + liq sort/filter.
  const [liqMap, setLiqMap] = useState<Record<string, number | null>>({});
  // Prices accumulate the same way; powers the priceUsd column in export.
  const [priceMap, setPriceMap] = useState<Record<string, number | null>>({});

  const onLiquidity = useCallback((partial: Record<string, number | null>) => {
    setLiqMap((prev) => mergeMap(prev, partial));
  }, []);
  const onPrice = useCallback((partial: Record<string, number | null>) => {
    setPriceMap((prev) => mergeMap(prev, partial));
  }, []);

  const allTokens = useMemo(() => data?.tokens ?? [], [data]);

  // Distinct chains across the whole dataset, for the chain dropdown.
  const chainOptions = useMemo<ChainOption[]>(() => {
    const map = new Map<string, string>();
    for (const t of allTokens) {
      for (const d of t.deployments) {
        if (!map.has(d.chainKey)) map.set(d.chainKey, d.chainName);
      }
    }
    return Array.from(map, ([chainKey, chainName]) => ({ chainKey, chainName })).sort((a, b) =>
      a.chainName.localeCompare(b.chainName)
    );
  }, [allTokens]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = allTokens.filter((t) => {
      if (q) {
        const hit =
          t.symbol.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.deployments.some(
            (d) =>
              d.address.toLowerCase().includes(q) ||
              d.tradeAddress.toLowerCase().includes(q)
          );
        if (!hit) return false;
      }
      if (filters.chain && !t.deployments.some((d) => d.chainKey === filters.chain)) return false;
      if (filters.evmOnly && !hasEvm(t)) return false;
      if (!matchEndpoint(t, filters.endpoint)) return false;
      if (filters.hasLiquidityOnly && tokenLiquidity(t, liqMap) <= 0) return false;
      return true;
    });

    return [...list].sort((a, b) => {
      if (filters.sort === "symbol") return a.symbol.localeCompare(b.symbol);
      if (filters.sort === "chains") return b.deployments.length - a.deployments.length;
      // default: liquidity desc (uses whatever has loaded; ties fall back to chain count)
      const la = tokenLiquidity(a, liqMap);
      const lb = tokenLiquidity(b, liqMap);
      if (lb !== la) return lb - la;
      return b.deployments.length - a.deployments.length;
    });
  }, [allTokens, search, filters, liqMap]);

  const shown = filtered.slice(0, MAX_CARDS);

  // Stats over the shown tokens.
  const stats = useMemo<LzStats>(() => {
    const chains = new Set<string>();
    let known = 0;
    let pending = 0;
    for (const t of shown) {
      for (const d of t.deployments) {
        chains.add(d.chainKey);
        const v = liqMap[itemKey(d)];
        if (typeof v === "number") known += v;
        else pending += 1;
      }
    }
    return {
      tokensShown: shown.length,
      distinctChains: chains.size,
      knownLiquidityUsd: known,
      liquidityPending: pending,
    };
  }, [shown, liqMap]);

  // Export rows: token×chain matrix for the shown tokens (price filled in the detail context).
  const exportRows = useMemo<LzExportRow[]>(() => {
    const rows: LzExportRow[] = [];
    for (const t of shown) {
      for (const d of t.deployments) {
        const liq = liqMap[itemKey(d)];
        const price = priceMap[itemKey(d)];
        rows.push({
          symbol: t.symbol,
          chainName: d.chainName,
          address: d.address,
          tradeAddress: d.tradeAddress,
          liquidityUsd: typeof liq === "number" ? liq : null,
          priceUsd: typeof price === "number" ? price : null,
        });
      }
    }
    return rows;
  }, [shown, liqMap, priceMap]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-foreground">LayerZero OFT Liquidity</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted">{filtered.length} tokens</span>
          <ExportButton rows={exportRows} />
        </div>
      </div>

      <p className="text-sm text-muted">
        Every chain a LayerZero OFT is deployed on — copy any address and see its DEX pool
        liquidity, spot price and cross-chain spread. For OFT <em>adapters</em>, the primary address
        is the inner ERC-20 (the token that actually has pools); the adapter contract is shown
        beside it. Click a card for the full per-chain breakdown.
      </p>

      <StatsHeader stats={stats} />

      <div className="space-y-3">
        <input
          type="text"
          placeholder="Search by symbol, name, or address…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <FilterBar value={filters} onChange={setFilters} chains={chainOptions} />
      </div>

      {error ? (
        <div className="text-sm text-red-600">Failed to load OFT list: {error.message}</div>
      ) : isLoading ? (
        <div className="text-sm text-muted">Loading LayerZero OFTs…</div>
      ) : shown.length === 0 ? (
        <div className="text-sm text-muted">No tokens match these filters.</div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {shown.map((t, i) => (
              <TokenCard
                key={`${t.symbol}-${i}`}
                token={t}
                onLiquidity={onLiquidity}
                onPrice={onPrice}
                onOpen={(ctx) => setDetail({ token: t, ctx })}
              />
            ))}
          </div>
          {filtered.length > shown.length && (
            <div className="text-xs text-muted">
              Showing {shown.length} of {filtered.length} — search or filter to narrow.
            </div>
          )}
        </>
      )}

      {detail && (
        <TokenDetail token={detail.token} ctx={detail.ctx} onClose={() => setDetail(null)} />
      )}
    </div>
  );
}
