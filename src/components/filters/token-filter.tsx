"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import type { TokenInfo } from "@/lib/types";

interface TokenFilterProps {
  tokens: TokenInfo[];
  value: string;
  onChange: (symbol: string) => void;
}

export function TokenFilter({ tokens, value, onChange }: TokenFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, { symbol: string; name: string; chainCount: number; logoURI: string }>();
    for (const t of tokens) {
      const existing = map.get(t.symbol);
      if (existing) {
        existing.chainCount++;
      } else {
        map.set(t.symbol, { symbol: t.symbol, name: t.name, chainCount: 1, logoURI: t.logoURI });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [tokens]);

  const filtered = useMemo(() => {
    if (!search.trim()) return grouped;
    const q = search.toLowerCase();
    return grouped.filter(
      t => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)
    );
  }, [grouped, search]);

  const selected = grouped.find(t => t.symbol === value);

  return (
    <div className="flex flex-col gap-1" ref={ref}>
      <label className="text-xs font-medium text-muted uppercase tracking-wider">Token</label>
      <div className="relative">
        <button
          onClick={() => { setOpen(!open); setSearch(""); }}
          className="w-full px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30 text-left flex items-center justify-between min-w-[160px]"
        >
          <span className={selected ? "text-foreground" : "text-muted"}>
            {selected ? selected.symbol : "All Tokens"}
          </span>
          <span className="text-muted ml-2">▾</span>
        </button>
        {open && (
          <div className="absolute z-20 mt-1 w-64 rounded-md border border-border bg-white shadow-lg max-h-80 flex flex-col">
            <div className="p-2 border-b border-border">
              <input
                type="text"
                placeholder="Search tokens..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-accent/30"
                autoFocus
              />
            </div>
            <div className="overflow-y-auto flex-1">
              <button
                onClick={() => { onChange(""); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors ${!value ? "bg-accent/10 font-medium" : ""}`}
              >
                All Tokens
              </button>
              {filtered.map(t => (
                <button
                  key={t.symbol}
                  onClick={() => { onChange(t.symbol); setOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors flex items-center justify-between ${value === t.symbol ? "bg-accent/10 font-medium" : ""}`}
                >
                  <span className="flex items-center gap-2">
                    {t.logoURI && (
                      <img src={t.logoURI} alt="" className="w-4 h-4 rounded-full" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    )}
                    <span className="font-medium">{t.symbol}</span>
                    <span className="text-muted text-xs truncate max-w-[100px]">{t.name}</span>
                  </span>
                  <span className="text-xs text-muted">{t.chainCount} chain{t.chainCount > 1 ? "s" : ""}</span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-3 py-4 text-sm text-muted text-center">No tokens found</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
