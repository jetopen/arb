"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useLzLiquidity,
  useLzPrice,
  useLzCex,
  useLzLogos,
  type LzCexResponse,
  type LzLogosResponse,
  type LzPriceResponse,
} from "@/lib/hooks";
import { getExplorerAddressUrl } from "@/lib/chains";
import { CopyableAddress } from "@/components/ui/copyable-address";
import type { LzOftDeployment, LzOftToken } from "@/lib/layerzero/types";

const PILL = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

// --- shared helpers (reused by the page + detail drawer) ---

export function itemKey(d: LzOftDeployment): string {
  return `${d.chainKey}:${d.tradeAddress}`;
}

export function formatUsd(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/** Compact price formatting that keeps precision for sub-dollar tokens. */
export function formatPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (v >= 1) return `$${v.toFixed(3)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  if (v > 0) return `$${v.toPrecision(3)}`;
  return "$0";
}

export function liquidityClasses(v: number | null | undefined): string {
  if (v == null) return "bg-gray-100 text-gray-500";
  if (v >= 100_000) return "bg-green-100 text-green-800";
  if (v > 0) return "bg-amber-100 text-amber-800";
  return "bg-gray-100 text-gray-500";
}

/** Explorer URL for the tradeable (inner) token, when the chain is EVM + known. */
export function tradeExplorer(d: LzOftDeployment): string | null {
  if (d.evmChainId == null) return null;
  return getExplorerAddressUrl(d.evmChainId, d.tradeAddress) || null;
}

/** Cross-chain spread %: (max−min)/min over the chains that have a price. null if < 2 prices. */
export function computeSpreadPct(
  token: LzOftToken,
  prices: LzPriceResponse | null | undefined
): number | null {
  if (!prices) return null;
  const vals: number[] = [];
  for (const d of token.deployments) {
    const p = prices[itemKey(d)];
    if (typeof p === "number" && p > 0) vals.push(p);
  }
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (min <= 0) return null;
  return ((max - min) / min) * 100;
}

/** Known CEX venues we badge, in display order. */
const CEX_VENUES: { key: string; label: string }[] = [
  { key: "gate", label: "Gate" },
  { key: "mexc", label: "MEXC" },
  { key: "bitget", label: "Bitget" },
];

/** Tolerant lookup of a token's CEX flags, accepting a few plausible response shapes. */
export function cexFlagsFor(
  symbol: string,
  cex: LzCexResponse | null | undefined
): { key: string; label: string }[] {
  if (!cex) return [];
  const entry = cex[symbol] ?? cex[symbol.toUpperCase()] ?? cex[symbol.toLowerCase()];
  if (!entry || typeof entry !== "object") return [];
  const e = entry as Record<string, unknown>;
  // Actual route shape: { listedOn: string[], prices: { gate?, mexc?, bitget? } }.
  const listedOn = Array.isArray(e.listedOn) ? (e.listedOn as unknown[]).map(String) : [];
  const prices =
    e.prices && typeof e.prices === "object" ? (e.prices as Record<string, unknown>) : {};
  const out: { key: string; label: string }[] = [];
  for (const v of CEX_VENUES) {
    const top = e[v.key]; // tolerant: also accept a top-level flag/value
    const listed =
      listedOn.includes(v.key) ||
      prices[v.key] != null ||
      top === true ||
      (typeof top === "string" && top.length > 0) ||
      (!!top && typeof top === "object");
    if (listed) out.push(v);
  }
  return out;
}

/** Tolerant logo lookup: try the chain-keyed item, then the symbol. */
export function logoFor(
  token: LzOftToken,
  logos: LzLogosResponse | null | undefined
): string | null {
  if (!logos) return null;
  for (const d of token.deployments) {
    const u = logos[itemKey(d)];
    if (typeof u === "string" && u) return u;
  }
  const bySymbol =
    logos[token.symbol] ?? logos[token.symbol.toUpperCase()] ?? logos[token.symbol.toLowerCase()];
  return typeof bySymbol === "string" && bySymbol ? bySymbol : null;
}

/** Fires once when the element first scrolls near the viewport (then stays true). */
export function useInView() {
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

// --- small presentational pieces ---

function LiquidityCell({ value }: { value: number | null | undefined }) {
  // undefined = not fetched yet (off-screen or in flight)
  if (value === undefined) {
    return <span className="text-xs text-muted">…</span>;
  }
  return (
    <span
      className={`${PILL} ${liquidityClasses(value)}`}
      title="DEX pool liquidity (USD) via GeckoTerminal"
    >
      {formatUsd(value)}
    </span>
  );
}

/** Graceful token logo: plain img that hides itself if the source fails or is absent. */
export function TokenLogo({ src, symbol }: { src: string | null; symbol: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted/40 text-[10px] font-semibold text-muted"
        aria-hidden
      >
        {symbol.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className="h-6 w-6 shrink-0 rounded-full bg-muted/20 object-cover"
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}

export function CexBadges({ venues }: { venues: { key: string; label: string }[] }) {
  if (venues.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {venues.map((v) => (
        <span
          key={v.key}
          className={`${PILL} bg-info-light text-info`}
          title={`Listed on ${v.label}`}
        >
          {v.label}
        </span>
      ))}
    </span>
  );
}

export function SpreadBadge({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const hot = pct >= 1;
  return (
    <span
      className={`${PILL} ${hot ? "bg-amber-100 text-amber-800" : "bg-muted/40 text-muted"}`}
      title="Cross-chain price spread: (max − min) / min across chains that have a price"
    >
      Δ {pct.toFixed(2)}%
    </span>
  );
}

// --- card ---

export function TokenCard({
  token,
  onOpen,
  onLiquidity,
  onPrice,
}: {
  token: LzOftToken;
  /** Open the detail drawer for this token, passing the live price/liquidity maps. */
  onOpen: (ctx: {
    liquidity: Record<string, number | null> | undefined;
    prices: LzPriceResponse | null | undefined;
    logo: string | null;
    cex: { key: string; label: string }[];
  }) => void;
  /** Reports loaded liquidity per item up to the page, for the aggregate stats header. */
  onLiquidity?: (liq: Record<string, number | null>) => void;
  /** Reports loaded prices per item up to the page, for export. */
  onPrice?: (prices: Record<string, number | null>) => void;
}) {
  const { ref, inView } = useInView();
  const items = useMemo(() => token.deployments.map(itemKey), [token]);
  const symbols = useMemo(() => [token.symbol], [token.symbol]);

  // Everything is gated on the card scrolling into view (bounds upstream API load).
  const { data: liq } = useLzLiquidity(inView ? items : []);
  const { data: prices } = useLzPrice(inView ? items : []);
  const { data: cex } = useLzCex(inView ? symbols : []);
  const { data: logos } = useLzLogos(inView ? items : []);

  // Bubble loaded liquidity up for the stats header.
  useEffect(() => {
    if (liq && onLiquidity) onLiquidity(liq);
  }, [liq, onLiquidity]);

  // Bubble loaded prices up so export can include them.
  useEffect(() => {
    if (prices && onPrice) onPrice(prices);
  }, [prices, onPrice]);

  const spreadPct = useMemo(() => computeSpreadPct(token, prices), [token, prices]);
  const cexVenues = useMemo(() => cexFlagsFor(token.symbol, cex), [token.symbol, cex]);
  const logo = useMemo(() => logoFor(token, logos), [token, logos]);

  function open() {
    onOpen({ liquidity: liq, prices, logo, cex: cexVenues });
  }

  return (
    <div
      ref={ref}
      className="cursor-pointer rounded-lg border border-border p-4 transition-colors hover:border-accent/50 hover:bg-card-hover"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <TokenLogo src={logo} symbol={token.symbol} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-foreground">{token.symbol}</span>
              <span className="truncate text-sm text-muted">{token.name}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                {token.endpointVersion}
              </span>
              <SpreadBadge pct={spreadPct} />
              <CexBadges venues={cexVenues} />
            </div>
          </div>
        </div>
        <span className="shrink-0 text-xs text-muted">
          {token.deployments.length} chain{token.deployments.length > 1 ? "s" : ""}
        </span>
      </div>

      <div className="space-y-1.5">
        {token.deployments.map((d) => {
          const price = inView ? prices?.[itemKey(d)] : undefined;
          return (
            <div
              key={`${d.chainKey}-${d.address}`}
              className="flex items-start justify-between gap-2 rounded px-2 py-1 hover:bg-muted/30"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-sm text-foreground">{d.chainName}</span>
                  <CopyableAddress address={d.tradeAddress} explorerUrl={tradeExplorer(d)} />
                </div>
                {d.isAdapter && (
                  <div
                    className="mt-0.5 flex items-center gap-1 pl-[7.75rem] text-[11px] text-muted"
                    title="OFT adapter contract — wraps the inner ERC-20 shown above"
                  >
                    <span className="uppercase tracking-wide">adapter</span>
                    <CopyableAddress address={d.address} explorerUrl={d.explorerUrl} />
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                {price != null && (
                  <span className="text-xs tabular-nums text-muted" title="Spot price (USD)">
                    {formatPrice(price)}
                  </span>
                )}
                <LiquidityCell value={inView ? liq?.[itemKey(d)] : undefined} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
