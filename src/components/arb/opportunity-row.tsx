"use client";

import type { Opportunity } from "@/lib/types";
import { chainName } from "@/lib/deport/registry";

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
}

function usd(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function OpportunityRow({
  opp,
  index,
  onSelect,
}: {
  opp: Opportunity;
  index: number;
  onSelect: (o: Opportunity) => void;
}) {
  const net = opp.edge.netEdgePct;
  const positive = net > 0;
  const verified = !!opp.verification?.verified;

  return (
    <tr
      onClick={() => onSelect(opp)}
      className="border-b border-border hover:bg-muted/30 transition-colors cursor-pointer"
    >
      <td className="px-4 py-3 text-sm text-muted">{index + 1}</td>
      <td className="px-4 py-3 text-sm font-medium text-foreground">{opp.symbol ?? "—"}</td>
      <td className="px-4 py-3 text-sm text-muted">
        {chainName(opp.buyChainId)} <span className="text-muted">→</span> {chainName(opp.sellChainId)}
      </td>
      <td className="px-4 py-3 text-sm text-muted">${opp.tierUsd.toLocaleString()}</td>
      <td className="px-4 py-3 text-sm text-muted tabular-nums">{pct(opp.edge.grossSpreadPct)}</td>
      <td className={`px-4 py-3 text-sm font-semibold tabular-nums ${positive ? "text-accent" : "text-red-600"}`}>
        {pct(net)}
      </td>
      <td className={`px-4 py-3 text-sm tabular-nums ${positive ? "text-accent" : "text-muted"}`}>
        {usd(opp.edge.netUsd)}
      </td>
      <td className="px-4 py-3 text-sm">
        {positive && verified ? (
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800">
            ✓ verified
          </span>
        ) : opp.verification?.rejectReason ? (
          <span className="text-xs text-muted" title={opp.verification.rejectReason}>
            unverified
          </span>
        ) : (
          <span className="text-xs text-muted">—</span>
        )}
      </td>
    </tr>
  );
}
