"use client";

import type { SymOpportunity } from "@/lib/symbiosis/types";
import { chainLabel } from "@/lib/symbiosis/scanner";
import { LoadingSpinner } from "../ui/loading-spinner";
import { EmptyState } from "../ui/empty-state";
import { ErrorState } from "../ui/error-state";

interface Props {
  opportunities: SymOpportunity[];
  loading: boolean;
  error: string | null;
  onSelect: (o: SymOpportunity) => void;
  onRetry?: () => void;
}

export function SymTable({ opportunities, loading, error, onSelect, onRetry }: Props) {
  if (loading && opportunities.length === 0) return <LoadingSpinner />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (opportunities.length === 0) return <EmptyState message="No positive-spread routes right now." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border text-left">
            {["#", "Token", "Route (buy → sell)", "Spread", "~Size", "Type"].map((h) => (
              <th key={h} className="px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {opportunities.map((o, i) => (
            <tr
              key={o.id}
              onClick={() => onSelect(o)}
              className="border-b border-border hover:bg-muted/30 transition-colors cursor-pointer"
            >
              <td className="px-4 py-3 text-sm text-muted">{i + 1}</td>
              <td className="px-4 py-3 text-sm font-medium text-foreground">
                {o.inSymbol}{o.inSymbol !== o.outSymbol ? ` → ${o.outSymbol}` : ""}
              </td>
              <td className="px-4 py-3 text-sm text-muted">
                {chainLabel(o.inChainId)} <span className="text-muted">→</span> {chainLabel(o.outChainId)}
              </td>
              <td className="px-4 py-3 text-sm font-semibold tabular-nums text-accent">+{o.profitBps.toFixed(1)} bps</td>
              <td className="px-4 py-3 text-sm text-muted tabular-nums">${o.sizeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
              <td className="px-4 py-3 text-sm">
                {o.btcFamily ? (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800">BTC wrap</span>
                ) : (
                  <span className="text-xs text-muted">{o.inSymbol === o.outSymbol ? "same-asset" : "wrap"}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
