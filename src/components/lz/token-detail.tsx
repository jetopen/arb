"use client";

import { useEffect, useState } from "react";
import type { LzOftToken } from "@/lib/layerzero/types";
import type { LzPriceResponse } from "@/lib/hooks";
import { CopyableAddress } from "@/components/ui/copyable-address";
import {
  CexBadges,
  SpreadBadge,
  TokenLogo,
  computeSpreadPct,
  formatPrice,
  formatUsd,
  itemKey,
  tradeExplorer,
} from "./token-card";

export interface LzDetailContext {
  liquidity: Record<string, number | null> | undefined;
  prices: LzPriceResponse | null | undefined;
  logo: string | null;
  cex: { key: string; label: string }[];
}

export function TokenDetail({
  token,
  ctx,
  onClose,
}: {
  token: LzOftToken;
  ctx: LzDetailContext;
  onClose: () => void;
}) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function close() {
    setVisible(false);
    setTimeout(onClose, 200);
  }

  const spreadPct = computeSpreadPct(token, ctx.prices);
  const knownLiq = token.deployments.reduce((acc, d) => {
    const v = ctx.liquidity?.[itemKey(d)];
    return typeof v === "number" ? acc + v : acc;
  }, 0);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/20 z-40 transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
        onClick={close}
      />
      <div
        className={`fixed top-0 right-0 h-full w-full max-w-lg bg-white shadow-xl z-50 transition-transform duration-200 ${visible ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <TokenLogo src={ctx.logo} symbol={token.symbol} />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-foreground">
                {token.symbol} <span className="text-sm font-normal text-muted">{token.name}</span>
              </h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                  {token.endpointVersion}
                </span>
                <SpreadBadge pct={spreadPct} />
                <CexBadges venues={ctx.cex} />
              </div>
            </div>
          </div>
          <button
            onClick={close}
            className="ml-2 shrink-0 text-lg text-muted hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="h-[calc(100%-72px)] space-y-6 overflow-y-auto px-6 py-4">
          <Section title="Summary">
            <Row label="Chains deployed">{token.deployments.length}</Row>
            <Row label="Shared decimals">{token.sharedDecimals}</Row>
            <Row label="Known liquidity">{formatUsd(knownLiq || null)}</Row>
            <Row label="Cross-chain spread">
              {spreadPct == null ? (
                <span className="text-muted">— (need ≥ 2 priced chains)</span>
              ) : (
                <span className={spreadPct >= 1 ? "font-semibold text-amber-700" : ""}>
                  {spreadPct.toFixed(2)}%
                </span>
              )}
            </Row>
          </Section>

          <Section title={`Deployments (${token.deployments.length})`}>
            {token.deployments.map((d) => {
              const liq = ctx.liquidity?.[itemKey(d)];
              const price = ctx.prices?.[itemKey(d)];
              return (
                <div
                  key={`${d.chainKey}-${d.address}`}
                  className="rounded-md border border-border px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{d.chainName}</span>
                    <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                      {d.type}
                    </span>
                  </div>
                  <div className="mt-1.5 space-y-1">
                    <Row label="Trade address">
                      <CopyableAddress address={d.tradeAddress} explorerUrl={tradeExplorer(d)} />
                    </Row>
                    {d.isAdapter && (
                      <Row label="Adapter">
                        <CopyableAddress address={d.address} explorerUrl={d.explorerUrl} />
                      </Row>
                    )}
                    <Row label="Price">
                      {price != null ? (
                        <span className="tabular-nums">{formatPrice(price)}</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Row>
                    <Row label="Liquidity">
                      {liq === undefined ? (
                        <span className="text-muted">…</span>
                      ) : (
                        <span className="tabular-nums">{formatUsd(liq)}</span>
                      )}
                    </Row>
                    {d.explorerUrl && (
                      <Row label="Explorer">
                        <a
                          href={d.explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-accent hover:underline"
                        >
                          open ↗
                        </a>
                      </Row>
                    )}
                  </div>
                </div>
              );
            })}
          </Section>

          <p className="border-t border-border pt-4 text-xs text-muted">
            Addresses, prices and DEX liquidity are informational. Prices/CEX/logos are best-effort
            and may be unavailable for some tokens.
          </p>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-sm text-muted">{label}</span>
      <span className="text-right text-sm text-foreground">{children}</span>
    </div>
  );
}
