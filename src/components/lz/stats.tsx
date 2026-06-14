"use client";

function formatUsd(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export interface LzStats {
  /** Tokens currently rendered (after filters, before the MAX_CARDS cap). */
  tokensShown: number;
  /** Distinct chains across the shown tokens' deployments. */
  distinctChains: number;
  /** Sum of known liquidity (USD) across shown tokens; null entries ignored. */
  knownLiquidityUsd: number;
  /** How many liquidity values are still loading / not yet fetched (off-screen). */
  liquidityPending: number;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}

export function StatsHeader({ stats }: { stats: LzStats }) {
  const liqHint =
    stats.liquidityPending > 0
      ? `${stats.liquidityPending} chain row${stats.liquidityPending === 1 ? "" : "s"} still loading`
      : "across visible tokens";

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Stat label="Tokens" value={stats.tokensShown.toLocaleString()} hint="matching filters" />
      <Stat
        label="Chains"
        value={stats.distinctChains.toLocaleString()}
        hint="distinct deployments"
      />
      <Stat
        label="Known liquidity"
        value={formatUsd(stats.knownLiquidityUsd)}
        hint={liqHint}
      />
    </div>
  );
}
