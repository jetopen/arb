"use client";

import type { GraphSummary, ScanRunInfo } from "@/lib/hooks";
import { timeAgo } from "@/lib/time";
import { Skeleton } from "../ui/skeleton";

interface Props {
  graph?: GraphSummary;
  scan?: { remaining: number; rpmAvailable: number };
  lastScan?: ScanRunInfo | null;
  /** Freshness gate (ms) from /api/arb/opportunities — the same window that hides stale rows. */
  gateMs?: number;
}

function Stat({ label, value, accent, alarm, loading }: { label: string; value: string; accent?: boolean; alarm?: boolean; loading?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium text-muted uppercase tracking-wider">{label}</span>
      {loading ? (
        <Skeleton className="h-4 w-12" />
      ) : (
        <span className={`text-sm font-semibold ${alarm ? "text-amber-600" : accent ? "text-accent" : "text-foreground"}`}>{value}</span>
      )}
    </div>
  );
}

export function ScanStatus({ graph, scan, lastScan, gateMs }: Props) {
  // A dead scanner must not look like a calm dashboard: past the same gate that empties the table (and
  // flips /api/health to 503), flag the bar amber. gateMs<=0 = gate disabled → never alarms; lastScan
  // null (fresh in-memory dev store) shows "—" as before — the watchdog owns the store-null case in prod.
  const stale = !!lastScan?.finishedAt && !!gateMs && gateMs > 0 && Date.now() - lastScan.finishedAt > gateMs;
  return (
    <div className="rounded-lg border border-border bg-white p-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <Stat label="Families" value={graph ? graph.families.toLocaleString() : ""} loading={!graph} />
        <Stat label="Multi-chain" value={graph ? String(graph.multiChainFamilies) : ""} loading={!graph} />
        <Stat label="Chains" value={graph ? `${graph.chainsScanned.length} EVM` : ""} loading={!graph} />
        <Stat
          label="Queue"
          value={scan ? String(scan.remaining) : String(graph?.queueSize ?? "—")}
          loading={!scan && !graph}
        />
        <Stat label="RPM free" value={scan ? String(scan.rpmAvailable) : "—"} />
        <Stat label="Last scan" value={timeAgo(lastScan?.finishedAt)} alarm={stale} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${
            graph?.persisted ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"
          }`}
        >
          {graph?.persisted ? "● Supabase (persistent)" : "● in-memory (resets on restart)"}
        </span>
        {stale && (
          <span className="inline-flex items-center rounded-full px-2 py-0.5 font-medium bg-amber-100 text-amber-800">
            scanner stale — last scan {timeAgo(lastScan?.finishedAt)}, data may be dead
          </span>
        )}
        {graph?.partial && (
          <span className="inline-flex items-center rounded-full px-2 py-0.5 font-medium bg-amber-100 text-amber-800">
            partial coverage — some chains failed to scan
          </span>
        )}
        {lastScan && (
          <span className="text-muted">
            last batch: {lastScan.unitsProcessed} units · {lastScan.quotesSpent} quotes · {lastScan.opportunitiesFound} profitable
          </span>
        )}
      </div>
    </div>
  );
}
