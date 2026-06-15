"use client";

import { useState } from "react";
import { useTrackedFamilies, type TrackedRep } from "@/lib/hooks";
import { TableSkeleton } from "../ui/skeleton";

const COLUMNS = ["Asset", "Origin", "Chains", "Representations (★ = native root)"];

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function RepPill({ rep }: { rep: TrackedRep }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/20 px-2 py-0.5 text-xs"
      title={`${rep.chainName} · ${rep.address}${rep.decimals != null ? ` · ${rep.decimals} dec` : ""}`}
    >
      {rep.isNativeRoot && (
        <span className="text-accent" aria-label="native root">
          ★
        </span>
      )}
      <span className="font-medium text-foreground">{rep.chainName}</span>
      <span className="font-mono text-muted">{short(rep.address)}</span>
    </span>
  );
}

/**
 * Browsable view of the tracked dePort asset set: every family (lock origin) and its on-chain
 * representations, forward-enumerated via getDebridge so it includes deAssets no token-list carries.
 */
export function TrackedFamilies() {
  const [multiChainOnly, setMultiChainOnly] = useState(true);
  const { data, error, isLoading } = useTrackedFamilies({ take: 250, multiChainOnly });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted">
          {data ? (
            <>
              <span className="font-medium text-foreground">{data.total.toLocaleString()}</span>{" "}
              {multiChainOnly ? "multi-chain" : "tracked"} dePort {data.total === 1 ? "family" : "families"}
              {data.total > data.families.length && <> · showing top {data.families.length}</>}
            </>
          ) : (
            "…"
          )}
        </div>
        <button
          onClick={() => setMultiChainOnly((v) => !v)}
          className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
            multiChainOnly ? "bg-accent text-white border-accent" : "border-border hover:bg-muted/50"
          }`}
        >
          {multiChainOnly ? "✓ Multi-chain only" : "Multi-chain only"}
        </button>
      </div>

      {data?.partial && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Forward-enumerated on-chain via getDebridge. Coverage is partial — at least one chain was
          rate-limited on this build, so a few reps may be missing.
        </div>
      )}

      {error ? (
        <div className="rounded-lg border border-border bg-white p-8 text-center text-sm text-red-600">
          Failed to load tracked assets: {error.message}
        </div>
      ) : isLoading || !data ? (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            Building the lock-graph (forward getDebridge across all chains)… first load can take a minute.
          </p>
          <TableSkeleton
            columns={COLUMNS}
            rows={6}
            wrapperClassName="overflow-x-auto rounded-lg border border-border bg-white"
          />
        </div>
      ) : data.families.length === 0 ? (
        <div className="rounded-lg border border-border bg-white p-8 text-center text-sm text-muted">
          No families found.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted">
                <th className="px-4 py-2 font-medium">Asset</th>
                <th className="px-4 py-2 font-medium">Origin</th>
                <th className="px-4 py-2 font-medium text-right">Chains</th>
                <th className="px-4 py-2 font-medium">Representations (★ = native root)</th>
              </tr>
            </thead>
            <tbody>
              {data.families.map((f) => (
                <tr
                  key={f.debridgeId}
                  className="border-b border-border/60 align-top last:border-0 hover:bg-muted/20"
                >
                  <td className="px-4 py-3">
                    <div className="font-semibold text-foreground">{f.symbol ?? "—"}</div>
                    <div className="font-mono text-[10px] text-muted" title={f.debridgeId}>
                      {short(f.debridgeId)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-foreground">{f.nativeChainName}</td>
                  <td className="px-4 py-3 text-right font-semibold text-foreground">{f.repCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {f.reps.map((r) => (
                        <RepPill key={`${r.internalChainId}:${r.address}`} rep={r} />
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
