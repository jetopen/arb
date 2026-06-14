"use client";

import { useEffect, useState } from "react";
import type { SymOpportunity, SymQuote } from "@/lib/symbiosis/types";
import { chainLabel } from "@/lib/symbiosis/scanner";

const SIZES = [50, 250, 1000, 5000];

interface SizePoint { usd: number; q: SymQuote | null }

export function SymDetail({ opp, onClose }: { opp: SymOpportunity; onClose: () => void }) {
  const [visible, setVisible] = useState(false);
  const [points, setPoints] = useState<SizePoint[] | null>(null);

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

  useEffect(() => {
    let alive = true;
    const url = (usd: number) =>
      `/api/arb/symbiosis/quote?inAddr=${opp.inAddress}&inChain=${opp.inChainId}&inDec=${opp.inDecimals}` +
      `&inSym=${encodeURIComponent(opp.inSymbol)}&outAddr=${opp.outAddress}&outChain=${opp.outChainId}` +
      `&outDec=${opp.outDecimals}&outSym=${encodeURIComponent(opp.outSymbol)}&inPrice=${opp.inPriceUsd}&usd=${usd}`;
    Promise.all(
      SIZES.map((usd) =>
        fetch(url(usd)).then((r) => r.json()).then((d) => ({ usd, q: (d.quote ?? null) as SymQuote | null })).catch(() => ({ usd, q: null }))
      )
    ).then((pts) => alive && setPoints(pts));
    return () => { alive = false; };
  }, [opp.id, opp.inAddress, opp.inChainId, opp.inDecimals, opp.inSymbol, opp.outAddress, opp.outChainId, opp.outDecimals, opp.outSymbol, opp.inPriceUsd]);

  const best = points?.filter((p) => p.q).sort((a, b) => (b.q!.netBps) - (a.q!.netBps))[0];

  return (
    <>
      <div className={`fixed inset-0 bg-black/20 z-40 transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`} onClick={close} />
      <div className={`fixed top-0 right-0 h-full w-full max-w-lg bg-white shadow-xl z-50 transition-transform duration-200 ${visible ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            {opp.inSymbol} → {opp.outSymbol} · {chainLabel(opp.inChainId)} → {chainLabel(opp.outChainId)}
          </h2>
          <button onClick={close} className="text-muted hover:text-foreground text-lg">✕</button>
        </div>

        <div className="overflow-y-auto h-[calc(100%-64px)] px-6 py-4 space-y-6">
          <Section title="Symbiosis feed">
            <Row label="Reported spread"><span className="text-accent font-semibold">+{opp.profitBps.toFixed(2)} bps</span></Row>
            <Row label="At notional">${opp.sizeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</Row>
            <Row label="In price">${opp.inPriceUsd}</Row>
          </Section>

          <Section title="Executable net by clip size (live /v2/quote)">
            {!points && <p className="text-sm text-muted">Quoting $50 – $5k…</p>}
            {points && (
              <>
                {best?.q && (
                  <Row label="Best clip">
                    <span className="font-semibold">${best.usd.toLocaleString()}</span>{" "}
                    <span className={best.q.netBps > 0 ? "text-accent" : "text-red-600"}>({best.q.netBps >= 0 ? "+" : ""}{best.q.netBps.toFixed(0)} bps)</span>
                  </Row>
                )}
                <div className="mt-2 space-y-1">
                  {points.map((p) => {
                    const net = p.q?.netBps ?? null;
                    const w = net == null ? 0 : Math.min(100, Math.abs(net) / 10);
                    return (
                      <div key={p.usd} className="flex items-center gap-2 text-xs">
                        <span className="w-12 text-right tabular-nums text-muted">${p.usd >= 1000 ? `${p.usd / 1000}k` : p.usd}</span>
                        <div className="flex-1 h-3 bg-muted/20 rounded overflow-hidden">
                          {net != null && <div className={`h-full ${net >= 0 ? "bg-accent" : "bg-red-400"}`} style={{ width: `${w}%` }} />}
                        </div>
                        <span className={`w-20 text-right tabular-nums ${net == null ? "text-muted" : net >= 0 ? "text-accent" : "text-red-600"}`}>
                          {net == null ? "no route" : `${net >= 0 ? "+" : ""}${net.toFixed(0)} bps`}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {best?.q && (
                  <p className="mt-2 text-xs text-muted">
                    Settlement ~{best.q.estimatedTimeSec}s · impact {best.q.priceImpactPct}% · fee {best.q.feeUsd != null ? `$${best.q.feeUsd.toFixed(2)}` : "—"}.
                    A fixed cross-chain fee dominates tiny clips; thin-pool dislocation rewards small clips. The U-curve is route-specific.
                  </p>
                )}
              </>
            )}
          </Section>

          <p className="text-xs text-muted border-t border-border pt-4">
            Live Symbiosis Octopool spreads (wrapped-vs-wrapped, AMM-priced 1:1 assets diverge). Real & executable but
            time-sensitive; micro-cap routes carry liquidity/fill risk. Screener, not an auto-executor.
          </p>
        </div>
      </div>
    </>
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
