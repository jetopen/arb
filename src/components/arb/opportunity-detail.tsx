"use client";

import { useEffect, useState } from "react";
import type { Opportunity } from "@/lib/types";
import { chainName } from "@/lib/deport/registry";
import { LegAddress } from "./leg-address";

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function OpportunityDetail({ opp, onClose }: { opp: Opportunity; onClose: () => void }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  function close() {
    setVisible(false);
    setTimeout(onClose, 200);
  }

  const e = opp.edge;
  const v = opp.verification;

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/20 z-40 transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
        onClick={close}
      />
      <div
        className={`fixed top-0 right-0 h-full w-full max-w-lg bg-white shadow-xl z-50 transition-transform duration-200 ${visible ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            {opp.symbol ?? "Opportunity"} · {chainName(opp.buyChainId)} → {chainName(opp.sellChainId)}
          </h2>
          <button onClick={close} className="text-muted hover:text-foreground text-lg">✕</button>
        </div>

        <div className="overflow-y-auto h-[calc(100%-64px)] px-6 py-4 space-y-6">
          <Section title="Edge">
            <Row label="Gross spread">
              <span className={e.grossSpreadPct > 0 ? "text-accent font-semibold" : "text-red-600"}>
                {e.grossSpreadPct >= 0 ? "+" : ""}{e.grossSpreadPct.toFixed(3)}%
              </span>
            </Row>
            <Row label="Probe size">${opp.tierUsd.toLocaleString()}</Row>
            <Row label="Net edge % (after fees)">
              <span className={e.netEdgePct > 0 ? "text-accent" : "text-red-600"}>
                {e.netEdgePct >= 0 ? "+" : ""}{e.netEdgePct.toFixed(3)}%
              </span>
            </Row>
            <Row label="Net (optimistic)">{money(e.netUsd)}</Row>
            <Row label="Net (after slippage)">{money(e.netUsdConservative)}</Row>
          </Section>

          <OptimizeSection opp={opp} />

          <Section title="Itemized costs">
            <Row label="dePort fixed fee">{money(e.deportFeeUsd)}</Row>
            <Row label="Gas (buy leg)">{money(e.gasBuyUsd)}</Row>
            <Row label="Gas (sell leg)">{money(e.gasSellUsd)}</Row>
            <Row label="DEX impact (buy)">{e.dexImpactBuyBps.toFixed(1)} bps</Row>
            <Row label="DEX impact (sell)">{e.dexImpactSellBps.toFixed(1)} bps</Row>
          </Section>

          <Section title="Verification">
            {v ? (
              <>
                <Row label="Status">
                  {v.verified ? (
                    <span className="text-accent">✓ corroborated ({v.sourcesAgreed.join(" + ")})</span>
                  ) : (
                    <span className="text-muted">{v.rejectReason ?? "unverified"}</span>
                  )}
                </Row>
                {v.quoteDisagreementBps != null && (
                  <Row label="Source disagreement">{v.quoteDisagreementBps.toFixed(0)} bps</Row>
                )}
                {v.liquidityUsd != null && <Row label="Pool liquidity">{money(v.liquidityUsd)}</Row>}
              </>
            ) : (
              <p className="text-sm text-muted">Not verified (only profitable candidates are cross-checked).</p>
            )}
          </Section>

          {(opp.timesSeen ?? 0) > 0 && (
            <Section title="History">
              <Row label="Times observed">{opp.timesSeen}</Row>
              <Row label="Times profitable">
                <span className={(opp.timesProfitable ?? 0) > 0 ? "text-accent" : ""}>{opp.timesProfitable ?? 0}</span>
              </Row>
              {opp.firstSeenAt ? <Row label="First seen">{new Date(opp.firstSeenAt).toLocaleString()}</Row> : null}
            </Section>
          )}

          <Section title="Lock path">
            {opp.lockPath.map((leg, i) => (
              <div key={i} className="text-sm">
                <div className="text-muted">{i + 1}. {chainName(leg.chainId)} — {leg.role}</div>
                <LegAddress chainId={leg.chainId} address={leg.address} />
              </div>
            ))}
          </Section>

          <p className="text-xs text-muted border-t border-border pt-4">
            Real, executable quotes (deBridge + KyberSwap) — time-sensitive and informational. This is a
            screener, not an auto-executor.
          </p>
        </div>
      </div>
    </>
  );
}

interface SizePoint { sizeUsd: number; grossPct: number; netUsd: number; netEdgePct: number }
interface OptimizeResp {
  feeUsd: number;
  curve: SizePoint[];
  best: SizePoint | null;
  breakEvenSizeUsd: number | null;
  grossPositiveMaxUsd: number | null;
  error?: string;
}

/** Sweeps trade sizes for this route and shows the small-capital sweet spot + net%-vs-size curve. */
function OptimizeSection({ opp }: { opp: Opportunity }) {
  const key = `${opp.debridgeId}:${opp.buyChainId}:${opp.sellChainId}`;
  // State is set only inside the async callback (avoids synchronous setState-in-effect).
  const [result, setResult] = useState<{ key: string; data: OptimizeResp | null } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/arb/optimize?debridgeId=${encodeURIComponent(opp.debridgeId)}&buy=${opp.buyChainId}&sell=${opp.sellChainId}`)
      .then((r) => r.json())
      .then((d: OptimizeResp) => alive && setResult({ key, data: d.error || !d.curve?.length ? null : d }))
      .catch(() => alive && setResult({ key, data: null }));
    return () => { alive = false; };
  }, [key, opp.debridgeId, opp.buyChainId, opp.sellChainId]);

  const loading = !result || result.key !== key; // derived — true until THIS route resolves
  const data = !loading ? result.data : null;

  return (
    <Section title="Best trade size (small-capital)">
      {loading && <p className="text-sm text-muted">Sweeping $25–$5k across live quotes…</p>}
      {!loading && !data && <p className="text-sm text-muted">Couldn&apos;t size this route (one leg has no route).</p>}
      {!loading && data && (
        <>
          {data.best && (
            <Row label="Optimal size">
              <span className="font-semibold">${data.best.sizeUsd.toLocaleString()}</span>{" "}
              <span className={data.best.netUsd > 0 ? "text-accent" : "text-red-600"}>
                ({money(data.best.netUsd)}, {data.best.netEdgePct.toFixed(2)}%)
              </span>
            </Row>
          )}
          <Row label="Break-even notional">
            {data.breakEvenSizeUsd ? (
              <span className="text-accent">${Math.round(data.breakEvenSizeUsd).toLocaleString()}+</span>
            ) : (
              <span className="text-muted">never (fee dominates)</span>
            )}
          </Row>
          <Row label="Gross-positive below">
            {data.grossPositiveMaxUsd ? `$${Math.round(data.grossPositiveMaxUsd).toLocaleString()}` : "—"}
          </Row>
          <div className="mt-3 space-y-1">
            {data.curve.map((p) => {
              const w = Math.min(100, Math.abs(p.netEdgePct) * 4);
              const isBest = p.sizeUsd === data.best?.sizeUsd;
              return (
                <div key={p.sizeUsd} className="flex items-center gap-2 text-xs">
                  <span className={`w-12 text-right tabular-nums ${isBest ? "font-semibold text-foreground" : "text-muted"}`}>
                    ${p.sizeUsd >= 1000 ? `${p.sizeUsd / 1000}k` : p.sizeUsd}
                  </span>
                  <div className="flex-1 h-3 bg-muted/20 rounded overflow-hidden">
                    <div className={`h-full ${p.netEdgePct >= 0 ? "bg-accent" : "bg-red-400"}`} style={{ width: `${w}%` }} />
                  </div>
                  <span className={`w-16 text-right tabular-nums ${p.netEdgePct >= 0 ? "text-accent" : "text-muted"}`}>
                    {p.netEdgePct >= 0 ? "+" : ""}{p.netEdgePct.toFixed(2)}%
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">
            Flat dePort fee ${data.feeUsd.toFixed(2)} is size-independent — it dominates at tiny sizes, which is why
            net bottoms out then worsens. Gross can be positive on small trades even when net isn&apos;t.
          </p>
        </>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-3">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm text-muted shrink-0">{label}</span>
      <span className="text-sm text-foreground text-right">{children}</span>
    </div>
  );
}
