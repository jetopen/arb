"use client";

export type LzSort = "liquidity" | "chains" | "symbol";
export type LzEndpointFilter = "all" | "v2" | "v1";

export interface LzFilterState {
  /** chainKey to filter to, or "" for all chains. */
  chain: string;
  /** Only show tokens with at least one known (>0) liquidity value. */
  hasLiquidityOnly: boolean;
  /** Only show tokens that have at least one EVM deployment. */
  evmOnly: boolean;
  /** Endpoint-version filter. */
  endpoint: LzEndpointFilter;
  /** Sort order. */
  sort: LzSort;
}

export const DEFAULT_LZ_FILTERS: LzFilterState = {
  chain: "",
  hasLiquidityOnly: false,
  evmOnly: false,
  endpoint: "all",
  sort: "liquidity",
};

export interface ChainOption {
  chainKey: string;
  chainName: string;
}

interface FilterBarProps {
  value: LzFilterState;
  onChange: (next: LzFilterState) => void;
  /** Distinct chains present in the dataset, for the dropdown. */
  chains: ChainOption[];
}

const SELECT_CLASS =
  "rounded-md border border-border bg-white px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30";

function Toggle({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
        checked
          ? "border-accent bg-accent/10 text-foreground"
          : "border-border text-muted hover:bg-muted/30"
      }`}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${checked ? "bg-accent" : "bg-muted/50"}`}
      />
      {label}
    </button>
  );
}

export function FilterBar({ value, onChange, chains }: FilterBarProps) {
  function set<K extends keyof LzFilterState>(key: K, v: LzFilterState[K]) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="inline-flex items-center gap-1.5 text-sm text-muted">
        <span className="sr-only">Filter by chain</span>
        <select
          aria-label="Filter by chain"
          className={SELECT_CLASS}
          value={value.chain}
          onChange={(e) => set("chain", e.target.value)}
        >
          <option value="">All chains</option>
          {chains.map((c) => (
            <option key={c.chainKey} value={c.chainKey}>
              {c.chainName}
            </option>
          ))}
        </select>
      </label>

      <Toggle
        label="Has liquidity"
        checked={value.hasLiquidityOnly}
        onChange={(v) => set("hasLiquidityOnly", v)}
        title="Only tokens with at least one chain showing > $0 DEX liquidity (within loaded cards)"
      />
      <Toggle
        label="EVM only"
        checked={value.evmOnly}
        onChange={(v) => set("evmOnly", v)}
        title="Only tokens deployed on at least one EVM chain"
      />

      <label className="inline-flex items-center gap-1.5 text-sm text-muted">
        <span className="sr-only">Endpoint version</span>
        <select
          aria-label="Endpoint version"
          className={SELECT_CLASS}
          value={value.endpoint}
          onChange={(e) => set("endpoint", e.target.value as LzEndpointFilter)}
        >
          <option value="all">All endpoints</option>
          <option value="v2">Endpoint v2</option>
          <option value="v1">Endpoint v1</option>
        </select>
      </label>

      <label className="ml-auto inline-flex items-center gap-1.5 text-sm text-muted">
        Sort
        <select
          aria-label="Sort tokens"
          className={SELECT_CLASS}
          value={value.sort}
          onChange={(e) => set("sort", e.target.value as LzSort)}
        >
          <option value="liquidity">Total liquidity</option>
          <option value="chains">Chain count</option>
          <option value="symbol">Symbol (A–Z)</option>
        </select>
      </label>
    </div>
  );
}
