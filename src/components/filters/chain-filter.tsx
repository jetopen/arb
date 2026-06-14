"use client";

import { SUPPORTED_CHAINS } from "@/lib/chains";

interface ChainFilterProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

export function ChainFilter({ label, value, onChange }: ChainFilterProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted uppercase tracking-wider">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
      >
        <option value="">All Chains</option>
        {SUPPORTED_CHAINS.map((chain) => (
          <option key={chain.id} value={String(chain.id)}>
            {chain.name}
          </option>
        ))}
      </select>
    </div>
  );
}
