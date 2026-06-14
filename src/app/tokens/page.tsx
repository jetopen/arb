"use client";

import { useState } from "react";
import { useTokens } from "@/lib/hooks";
import { getChainName } from "@/lib/chains";
import type { TokenInfo } from "@/lib/types";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handleCopy}
      className="text-xs text-muted hover:text-foreground px-1.5 py-0.5 rounded border border-border hover:bg-muted/50 transition-colors"
      title={copied ? "Copied!" : `Copy ${text}`}
    >
      {copied ? "✓" : "Copy"}
    </button>
  );
}

function TokenGroup({ symbol, name, tokens }: { symbol: string; name: string; tokens: TokenInfo[] }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {tokens[0]?.logoURI && (
            <img
              src={tokens[0].logoURI}
              alt=""
              className="w-6 h-6 rounded-full"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          )}
          <span className="font-semibold text-foreground">{symbol}</span>
          <span className="text-sm text-muted">{name}</span>
        </div>
        <span className="text-xs text-muted">{tokens.length} chain{tokens.length > 1 ? "s" : ""}</span>
      </div>
      <div className="space-y-2">
        {tokens.map((t) => (
          <div key={`${t.chainId}-${t.address}`} className="flex items-center justify-between gap-2 py-1 px-2 rounded hover:bg-muted/30">
            <div className="flex items-center gap-3">
              <span className="text-sm text-foreground w-28">{getChainName(t.chainId)}</span>
              <span className="font-mono text-xs text-muted break-all">{t.address}</span>
            </div>
            <CopyButton text={t.address} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TokensPage() {
  const { data, isLoading } = useTokens();
  const [search, setSearch] = useState("");
  const [hideNative, setHideNative] = useState(true);

  const NATIVE = new Set(["ETH", "SOL", "BNB", "MATIC", "AVAX", "FTM", "XDAI", "HT", "OP", "S", "MNT", "CRO", "INJ", "SEI", "FLOW"]);

  const grouped = (() => {
    if (!data?.tokens) return [];
    const map = new Map<string, { name: string; tokens: TokenInfo[] }>();
    for (const t of data.tokens) {
      if (hideNative && NATIVE.has(t.symbol)) continue;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!t.symbol.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q) && !t.address.toLowerCase().includes(q)) continue;
      }
      const existing = map.get(t.symbol);
      if (existing) {
        existing.tokens.push(t);
      } else {
        map.set(t.symbol, { name: t.name, tokens: [t] });
      }
    }
    return Array.from(map.entries())
      .map(([symbol, data]) => ({ symbol, ...data }))
      .sort((a, b) => b.tokens[0].popularityIndex - a.tokens[0].popularityIndex);
  })();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Token Registry</h1>
        <span className="text-sm text-muted">{grouped.length} tokens</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by symbol, name, or address..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[200px] px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <button
          onClick={() => setHideNative(!hideNative)}
          className={`px-3 py-2 text-sm rounded-md border transition-colors ${hideNative ? "bg-accent text-white border-accent" : "border-border hover:bg-muted/50"}`}
        >
          {hideNative ? "✓ Non-Native" : "Show Native"}
        </button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted">Loading tokens...</div>
      ) : grouped.length === 0 ? (
        <div className="text-sm text-muted">No tokens found</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {grouped.map((g) => (
            <TokenGroup key={g.symbol} symbol={g.symbol} name={g.name} tokens={g.tokens} />
          ))}
        </div>
      )}
    </div>
  );
}
