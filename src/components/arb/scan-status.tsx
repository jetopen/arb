"use client";

import type { GraphSummary, ScanRunInfo } from "@/lib/hooks";

interface Props {
  graph?: GraphSummary;
  scan?: { remaining: number; rpmAvailable: number };
  lastScan?: ScanRunInfo | null;
}

function ago(ts?: number): string {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-medium text-muted uppercase tracking-wider">{label}</span>
      <span className={`text-sm font-semibold ${accent ? "text-accent" : "text-foreground"}`}>{value}</span>
    </div>
  );
}

export function ScanStatus({ graph, scan, lastScan }: Props) {
  return (
    <div className="rounded-lg border border-border bg-white p-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <Stat label="Families" value={graph ? graph.families.toLocaleString() : "…"} />
        <Stat label="Multi-chain" value={graph ? String(graph.multiChainFamilies) : "…"} />
        <Stat label="Chains" value={graph ? `${graph.chainsScanned.length} EVM` : "…"} />
        <Stat label="Queue" value={scan ? String(scan.remaining) : graph ? String(graph.queueSize ?? "—") : "…"} />
        <Stat label="RPM free" value={scan ? String(scan.rpmAvailable) : "—"} />
        <Stat label="Last scan" value={ago(lastScan?.finishedAt)} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${
            graph?.persisted ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"
          }`}
        >
          {graph?.persisted ? "● Supabase (persistent)" : "● in-memory (resets on restart)"}
        </span>
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
