"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const STEP = 24; // tokens revealed per batch (progressive infinite scroll)

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

/**
 * Liquidity status for the "Has liquidity" filter: "has" (some loaded chain > 0), "none" (all
 * loaded chains are 0), or "unknown" (nothing loaded yet). The filter hides only "none" so that
 * not-yet-loaded tokens stay visible while the background warm-up fills them in.
 */
function tokenLiqState(
  t: LzOftToken,
  liq: Record<string, number | null>
): "has" | "none" | "unknown" {
  let loadedAny = false;
  for (const d of t.deployments) {
    const k = itemKey(d);
    // A key is only absent until it's been fetched. GeckoTerminal returns `null` for "no pool"
    // (not 0), so a present-but-null value means "checked, no liquidity" — NOT unknown.
    if (!(k in liq)) continue;
    loadedAny = true;
    const v = liq[k];
    if (typeof v === "number" && v > 0) return "has";
  }
  // Some chains checked, none had liquidity → "none"; nothing checked yet → "unknown".
  return loadedAny ? "none" : "unknown";
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

  // Liquidity (and the liquidity sort/filter) need data for ALL tokens, but cards only load it
  // lazily as they scroll into view. When the user opts into a liquidity sort/filter, warm the
  // full liquidity map in the background (batched; the route is server-cached) so the filter and
  // sort become globally accurate instead of reflecting only the handful of scrolled cards.
  const wantLiquidity = filters.hasLiquidityOnly || filters.sort === "liquidity";
  const liqWarmRef = useRef<Set<string>>(new Set());
  const [liqWarming, setLiqWarming] = useState(false);
  useEffect(() => {
    if (!wantLiquidity || allTokens.length === 0) return;
    const pending: string[] = [];
    for (const t of allTokens) {
      for (const d of t.deployments) {
        const k = itemKey(d);
        if (!liqWarmRef.current.has(k)) pending.push(k);
      }
    }
    if (pending.length === 0) return;
    let cancelled = false;
    setLiqWarming(true);
    (async () => {
      try {
        for (let i = 0; i < pending.length && !cancelled; i += 50) {
          const batch = pending.slice(i, i + 50);
          try {
            const res = await fetch(`/api/lz/liquidity?items=${encodeURIComponent(batch.join(","))}`);
            if (res.ok) {
              const data = (await res.json()) as Record<string, number | null>;
              if (cancelled) return;
              onLiquidity(data);
              for (const k of batch) liqWarmRef.current.add(k);
            }
          } catch {
            /* best-effort warm-up; ignore a failed batch */
          }
        }
      } finally {
        if (!cancelled) setLiqWarming(false);
      }
    })();
    return () => {
      cancelled = true;
      setLiqWarming(false);
    };
  }, [wantLiquidity, allTokens, onLiquidity]);

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
      if (filters.hasLiquidityOnly && tokenLiqState(t, liqMap) === "none") return false;
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

  // Progressive reveal: render a growing slice; the bottom sentinel reveals the next batch as
  // you scroll, so all matching tokens are browsable. Enrichment (liquidity/price/CEX/logo) stays
  // in-view-gated per card, so showing everything never fires more than the on-screen cards' calls.
  const [visibleCount, setVisibleCount] = useState(STEP);
  // Reset to the first batch whenever the result set changes (new search / filter / sort).
  useEffect(() => {
    setVisibleCount(STEP);
  }, [search, filters]);

  const shown = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  // Auto-reveal the next batch when the sentinel scrolls near the viewport.
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hasMoreRef.current) {
          setVisibleCount((c) => c + STEP);
        }
      },
      { rootMargin: "600px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [filtered.length]);

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
        {liqWarming && (
          <p className="text-xs text-muted">
            Loading liquidity across all chains to refine the liquidity filter &amp; sort…
          </p>
        )}
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
          {hasMore ? (
            <div ref={sentinelRef} className="flex justify-center py-3">
              <button
                onClick={() => setVisibleCount((c) => c + STEP)}
                className="rounded-md border border-border px-4 py-2 text-sm text-muted hover:bg-muted/50"
              >
                Load more — showing {shown.length} of {filtered.length}
              </button>
            </div>
          ) : (
            filtered.length > 0 && (
              <div className="py-3 text-center text-xs text-muted">
                All {filtered.length} tokens shown
              </div>
            )
          )}
        </>
      )}

      {detail && (
        <TokenDetail token={detail.token} ctx={detail.ctx} onClose={() => setDetail(null)} />
      )}
    </div>
  );
}
