"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLzOfts, useLzLiquidity } from "@/lib/hooks";
import { getExplorerAddressUrl } from "@/lib/chains";
import { CopyableAddress } from "@/components/ui/copyable-address";
import type { LzOftDeployment, LzOftToken } from "@/lib/layerzero/types";

const MAX_CARDS = 30;

function formatUsd(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function liquidityClasses(v: number | null): string {
  if (v == null) return "bg-gray-100 text-gray-500";
  if (v >= 100_000) return "bg-green-100 text-green-800";
  if (v > 0) return "bg-amber-100 text-amber-800";
  return "bg-gray-100 text-gray-500";
}

function itemKey(d: LzOftDeployment): string {
  return `${d.chainKey}:${d.tradeAddress}`;
}

/** Explorer URL for the tradeable (inner) token, when the chain is EVM + known. */
function tradeExplorer(d: LzOftDeployment): string | null {
  if (d.evmChainId == null) return null;
  return getExplorerAddressUrl(d.evmChainId, d.tradeAddress) || null;
}

/** Fires once when the element first scrolls near the viewport (then stays true). */
function useInView() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: "250px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView]);
  return { ref, inView };
}

function LiquidityCell({ value }: { value: number | null | undefined }) {
  // undefined = not fetched yet (off-screen or in flight)
  if (value === undefined) {
    return <span className="text-xs text-muted">…</span>;
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${liquidityClasses(value)}`}
      title="DEX pool liquidity (USD) via GeckoTerminal"
    >
      {formatUsd(value)}
    </span>
  );
}

function TokenCard({ token }: { token: LzOftToken }) {
  const { ref, inView } = useInView();
  const items = useMemo(() => token.deployments.map(itemKey), [token]);
  // Only fetch liquidity once the card scrolls into view (bounds GeckoTerminal load).
  const { data: liq } = useLzLiquidity(inView ? items : []);

  return (
    <div ref={ref} className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">{token.symbol}</span>
          <span className="text-sm text-muted">{token.name}</span>
          <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-muted/50 text-muted">
            {token.endpointVersion}
          </span>
        </div>
        <span className="text-xs text-muted">
          {token.deployments.length} chain{token.deployments.length > 1 ? "s" : ""}
        </span>
      </div>

      <div className="space-y-1.5">
        {token.deployments.map((d) => (
          <div
            key={`${d.chainKey}-${d.address}`}
            className="flex items-start justify-between gap-2 py-1 px-2 rounded hover:bg-muted/30"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <span className="text-sm text-foreground w-28 shrink-0">{d.chainName}</span>
                <CopyableAddress address={d.tradeAddress} explorerUrl={tradeExplorer(d)} />
              </div>
              {d.isAdapter && (
                <div
                  className="flex items-center gap-1 mt-0.5 pl-[7.75rem] text-[11px] text-muted"
                  title="OFT adapter contract — wraps the inner ERC-20 shown above"
                >
                  <span className="uppercase tracking-wide">adapter</span>
                  <CopyableAddress address={d.address} explorerUrl={d.explorerUrl} />
                </div>
              )}
            </div>
            <div className="shrink-0 pt-0.5">
              <LiquidityCell value={inView ? liq?.[itemKey(d)] : undefined} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LayerZeroPage() {
  const { data, isLoading, error } = useLzOfts();
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const all = data?.tokens ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.deployments.some(
          (d) =>
            d.address.toLowerCase().includes(q) ||
            d.tradeAddress.toLowerCase().includes(q)
        )
    );
  }, [data, search]);

  const shown = filtered.slice(0, MAX_CARDS);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">LayerZero OFT Liquidity</h1>
        <span className="text-sm text-muted">{filtered.length} tokens</span>
      </div>

      <p className="text-sm text-muted">
        Every chain a LayerZero OFT is deployed on — copy any address and see its DEX pool
        liquidity. For OFT <em>adapters</em>, the primary address is the inner ERC-20 (the token
        that actually has pools); the adapter contract is shown beside it.
      </p>

      <input
        type="text"
        placeholder="Search by symbol, name, or address…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
      />

      {error ? (
        <div className="text-sm text-red-600">Failed to load OFT list: {error.message}</div>
      ) : isLoading ? (
        <div className="text-sm text-muted">Loading LayerZero OFTs…</div>
      ) : shown.length === 0 ? (
        <div className="text-sm text-muted">No tokens found.</div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {shown.map((t, i) => (
              <TokenCard key={`${t.symbol}-${i}`} token={t} />
            ))}
          </div>
          {filtered.length > shown.length && (
            <div className="text-xs text-muted">
              Showing {shown.length} of {filtered.length} — search to narrow.
            </div>
          )}
        </>
      )}
    </div>
  );
}
