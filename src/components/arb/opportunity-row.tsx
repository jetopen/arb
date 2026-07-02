"use client";

import { useState } from "react";
import type { Opportunity, SimulationResult } from "@/lib/types";
import { chainName } from "@/lib/deport/registry";
import { timeAgo } from "@/lib/time";
import { LegAddress } from "./leg-address";

/** A quote older than ~one scan cycle is getting stale — flag it amber so a decayed edge can't read as live. */
const STALE_AFTER_MS = 35 * 60 * 1000;

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
}

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** Signed USD with the minus BEFORE the $ (net is usually negative at probe sizes — the fee dominates). */
function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** First blocking leg's reason, for the "reverts" badge tooltip. */
function failReason(sim: SimulationResult): string {
  if (sim.buy.status === "revert") return `buy swap: ${sim.buy.reason ?? "revert"}`;
  if (sim.sell.status === "revert") return `sell swap: ${sim.sell.reason ?? "revert"}`;
  if (sim.send.status === "revert") return `origin send: ${sim.send.reason ?? "revert"}`;
  if (sim.claim.status === "fail") return `claim: ${sim.claim.reason ?? "fail"}`;
  return "reverts on execution";
}

/** Compact sim badge: executable ✓ / reverts ✗ (with reason tooltip) / n/a (nothing simulatable). */
function SimBadge({ sim }: { sim?: SimulationResult }) {
  if (!sim) return <span className="text-xs text-muted">—</span>;
  if (sim.executable === true)
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-800">
        ✓ executable
      </span>
    );
  if (sim.executable === false)
    return (
      <span className="text-xs font-medium text-red-600" title={failReason(sim)}>
        ✗ reverts
      </span>
    );
  return (
    <span className="text-xs text-muted" title="nothing on this route could be simulated">
      sim n/a
    </span>
  );
}

function SimLeg({ label, status, reason }: { label: string; status: string; reason?: string }) {
  const tone =
    status === "pass" ? "text-green-700" : status === "revert" || status === "fail" ? "text-red-600" : "text-muted";
  const word = status === "pass" ? "pass" : status === "revert" ? "revert" : status === "fail" ? "fail" : "n/a";
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="w-48 shrink-0 text-muted">{label}</span>
      <span className={`font-medium ${tone}`}>{word}</span>
      {reason && <span className="text-xs text-muted">— {reason}</span>}
    </div>
  );
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
  const ageMs = opp.computedAt ? Date.now() - opp.computedAt : null;
  const stale = ageMs != null && ageMs > STALE_AFTER_MS;

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
        <td
          className={`px-4 py-3 text-sm font-medium tabular-nums ${opp.edge.netUsdConservative > 0 ? "text-accent" : "text-muted"}`}
          title="Net USD after fees, gas, and a slippage haircut, at this probe size (open the row for the size sweep)"
        >
          {money(opp.edge.netUsdConservative)}
        </td>
        <td className="px-4 py-3 text-sm text-muted tabular-nums" title="Probe size this spread is measured at">
          ${opp.tierUsd.toLocaleString()}
        </td>
        <td className="px-4 py-3 text-sm text-muted tabular-nums">
          {opp.edge.deportFeeUsd > 0 ? usd(opp.edge.deportFeeUsd) : "—"}
        </td>
        <td className="px-4 py-3 text-sm">
          {positive && verified ? (
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800">
              {opp.verification?.sourcesAgreed?.includes("0x") ? "✓ verified (0x)" : "✓ verified"}
            </span>
          ) : positive && opp.verification?.aggregatorRoutable ? (
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800"
              title="No independent pool/spot source could corroborate this, but a DEX aggregator (deBridge/1inch, 0x) routes it — like the MGLD class. Real but unverified; hand-check before sizing up."
            >
              ⚡ 1inch-routable
            </span>
          ) : opp.verification?.rejectReason ? (
            <span className="text-xs text-muted" title={opp.verification.rejectReason}>
              unverified
            </span>
          ) : (
            <span className="text-xs text-muted">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-sm">
          <SimBadge sim={opp.simulation} />
        </td>
        <td className="px-4 py-3 text-xs tabular-nums">
          <span
            className={stale ? "text-amber-600" : "text-muted"}
            title={stale ? "Older than a scan cycle — this quote may be stale" : "When this row's quote was computed"}
          >
            {timeAgo(opp.computedAt)}
          </span>
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
            {opp.simulation && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">
                  Simulation (executable path)
                </p>
                <div className="space-y-1">
                  <SimLeg label="Buy swap (USDC → asset)" status={opp.simulation.buy.status} reason={opp.simulation.buy.reason} />
                  <SimLeg label="Origin send (lock/burn)" status={opp.simulation.send.status} reason={opp.simulation.send.reason} />
                  <SimLeg label="Claim (gate reserves)" status={opp.simulation.claim.status} reason={opp.simulation.claim.reason} />
                  <SimLeg label="Sell swap (asset → USDC)" status={opp.simulation.sell.status} reason={opp.simulation.sell.reason} />
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
