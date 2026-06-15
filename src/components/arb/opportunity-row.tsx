"use client";

import { useState } from "react";
import type { Opportunity } from "@/lib/types";
import { chainName } from "@/lib/deport/registry";
import { LegAddress } from "./leg-address";

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
}

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function OpportunityRow({
  opp,
  index,
  colSpan,
  onSelect,
}: {
  opp: Opportunity;
  index: number;
  colSpan: number;
  onSelect: (o: Opportunity) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const spread = opp.edge.grossSpreadPct;
  const positive = spread > 0;
  const verified = !!opp.verification?.verified;

  return (
    <>
      <tr
        onClick={() => onSelect(opp)}
        className="border-b border-border hover:bg-muted/30 transition-colors cursor-pointer"
      >
        <td className="px-2 py-3 text-sm">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="text-muted hover:text-foreground transition-colors w-5"
            aria-label={expanded ? "Hide token addresses" : "Show token addresses"}
            aria-expanded={expanded}
          >
            {expanded ? "▾" : "▸"}
          </button>
        </td>
        <td className="px-4 py-3 text-sm text-muted">{index + 1}</td>
        <td className="px-4 py-3 text-sm font-medium text-foreground">{opp.symbol ?? "—"}</td>
        <td className="px-4 py-3 text-sm text-muted">
          {chainName(opp.buyChainId)} <span className="text-muted">→</span> {chainName(opp.sellChainId)}
        </td>
        <td className={`px-4 py-3 text-sm font-semibold tabular-nums ${positive ? "text-accent" : "text-red-600"}`}>
          {pct(spread)}
        </td>
        <td className="px-4 py-3 text-sm text-muted tabular-nums">
          {opp.edge.deportFeeUsd > 0 ? usd(opp.edge.deportFeeUsd) : "—"}
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
      {expanded && (
        <tr className="border-b border-border bg-muted/10">
          <td colSpan={colSpan} className="px-4 py-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">
              Token addresses (executable legs)
            </p>
            <div className="space-y-2">
              {opp.lockPath.map((leg, i) => (
                <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="w-44 shrink-0 text-muted">
                    {chainName(leg.chainId)} · {leg.role}
                  </span>
                  <LegAddress chainId={leg.chainId} address={leg.address} />
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
