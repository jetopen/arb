"use client";

import type { Opportunity } from "@/lib/types";
import { OpportunityRow } from "./opportunity-row";
import { TableSkeleton } from "../ui/skeleton";
import { EmptyState } from "../ui/empty-state";
import { ErrorState } from "../ui/error-state";

const COLUMNS = ["#", "Token", "Route (buy → sell)", "Tier", "Gross %", "Net %", "Net $", "Verified"];

interface Props {
  opportunities: Opportunity[];
  loading: boolean;
  error: string | null;
  onSelect: (o: Opportunity) => void;
  onRetry?: () => void;
}

export function OpportunityTable({ opportunities, loading, error, onSelect, onRetry }: Props) {
  if (loading && opportunities.length === 0) return <TableSkeleton columns={COLUMNS} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (opportunities.length === 0)
    return <EmptyState message="No opportunities yet — the scanner is sweeping the lock-graph." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border text-left">
            {COLUMNS.map((h) => (
              <th key={h} className="px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {opportunities.map((o, i) => (
            <OpportunityRow key={o.id} opp={o} index={i} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
