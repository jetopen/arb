"use client";

import type { Opportunity } from "@/lib/types";
import { OpportunityRow } from "./opportunity-row";
import { TableSkeleton } from "../ui/skeleton";
import { EmptyState } from "../ui/empty-state";
import { ErrorState } from "../ui/error-state";

const COLUMNS = ["", "#", "Token", "Route (buy → sell)", "Spread %", "Net $", "Size", "dePort fee", "Verified", "Sim", "Age"];
// Headers that toggle the client-side sort key.
const SORTABLE: Record<string, SortKey> = { "Spread %": "gross", "Net $": "net" };

export type SortKey = "gross" | "net";

interface Props {
  opportunities: Opportunity[];
  loading: boolean;
  error: string | null;
  onSelect: (o: Opportunity) => void;
  onRetry?: () => void;
  sortKey: SortKey;
  onSort: (k: SortKey) => void;
}

export function OpportunityTable({ opportunities, loading, error, onSelect, onRetry, sortKey, onSort }: Props) {
  if (loading && opportunities.length === 0) return <TableSkeleton columns={COLUMNS} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (opportunities.length === 0)
    return <EmptyState message="No opportunities yet — the scanner is sweeping the lock-graph." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border text-left">
            {COLUMNS.map((h) => {
              const key = SORTABLE[h];
              return (
                <th key={h} className="px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {key ? (
                    <button
                      onClick={() => onSort(key)}
                      className={`uppercase tracking-wider transition-colors hover:text-foreground ${sortKey === key ? "text-foreground" : ""}`}
                      title={`Sort by ${h.trim()}`}
                    >
                      {h}
                      {sortKey === key ? " ↓" : ""}
                    </button>
                  ) : (
                    h
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {opportunities.map((o, i) => (
            <OpportunityRow key={o.debridgeId} opp={o} index={i} colSpan={COLUMNS.length} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
