import useSWR from "swr";
import type { NormalizedMessage, ChainInfo, Statistics, TokenInfo } from "./types";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
};

export interface MessagesResponse {
  messages: NormalizedMessage[];
  total: number;
}

export interface Filters {
  chainFrom?: string;
  chainTo?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  take?: number;
}

function buildMessagesUrl(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.chainFrom) params.set("chainFrom", filters.chainFrom);
  if (filters.chainTo) params.set("chainTo", filters.chainTo);
  if (filters.status) params.set("status", filters.status);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  if (filters.page) params.set("page", String(filters.page));
  if (filters.take) params.set("take", String(filters.take));
  const qs = params.toString();
  return `/api/messages${qs ? `?${qs}` : ""}`;
}

export function useMessages(filters: Filters) {
  const url = buildMessagesUrl(filters);
  return useSWR<MessagesResponse>(url, fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
    dedupingInterval: 5_000,
  });
}

export function useChains() {
  return useSWR<ChainInfo[]>("/api/chains", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
}

export function useStats() {
  return useSWR<Statistics>("/api/stats", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    dedupingInterval: 10_000,
  });
}

export function useSearch(query: string) {
  const shouldFetch = query.trim().length > 0;
  return useSWR<{ message: NormalizedMessage | null }>(
    shouldFetch ? `/api/search?q=${encodeURIComponent(query.trim())}` : null,
    fetcher,
    { dedupingInterval: 2_000 }
  );
}

export function useTokens() {
  return useSWR<{ tokens: TokenInfo[] }>("/api/tokens", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

// --- Arbitrage ---
import type { Opportunity } from "./types";

export interface ArbFilters {
  minSpreadPct?: number;
  chainId?: number;
  /** Pin to one probe size (a rung of the scan ladder); unset = best size per token. */
  tierUsd?: number;
  verifiedOnly?: boolean;
  /** Keep only rows whose tx simulation proved the executable path (needs ARB_SIMULATE on the scanner). */
  executableOnly?: boolean;
  take?: number;
  page?: number;
}

export interface ScanRunInfo {
  startedAt: number;
  finishedAt: number;
  unitsProcessed: number;
  quotesSpent: number;
  opportunitiesFound: number;
  partial: boolean;
}

export interface ArbResponse {
  opportunities: Opportunity[];
  total: number;
  lastScan: ScanRunInfo | null;
  /** The probe-size ladder actually scanned (mirrors ARB_SCAN_NOTIONAL_USD) — drives the capital selector. */
  tiers?: number[];
  /** Freshness gate (ms) the server applied — lets the UI alarm when lastScan exceeds it (<=0 = disabled). */
  gateMs?: number;
}

export interface GraphSummary {
  families: number;
  multiChainFamilies: number;
  chainsScanned: number[];
  partial: boolean;
  builtAt: number;
  persisted: boolean;
  queueSize?: number;
}

function buildArbUrl(f: ArbFilters): string {
  const p = new URLSearchParams();
  if (f.minSpreadPct != null) p.set("minSpreadPct", String(f.minSpreadPct));
  if (f.chainId) p.set("chainId", String(f.chainId));
  if (f.tierUsd != null) p.set("tierUsd", String(f.tierUsd));
  if (f.verifiedOnly) p.set("verifiedOnly", "true");
  if (f.executableOnly) p.set("executableOnly", "true");
  if (f.take) p.set("take", String(f.take));
  if (f.page && f.page > 1) p.set("page", String(f.page));
  const qs = p.toString();
  return `/api/arb/opportunities${qs ? `?${qs}` : ""}`;
}

export function useArbOpportunities(filters: ArbFilters) {
  return useSWR<ArbResponse>(buildArbUrl(filters), fetcher, {
    refreshInterval: 8_000,
    revalidateOnFocus: false,
    dedupingInterval: 3_000,
  });
}

/**
 * Polls the scan endpoint to keep the cycling scanner advancing while the page is open. When a dedicated
 * scan driver owns scanning (NEXT_PUBLIC_ARB_DRIVER=1), the browser must NOT also poll — the key goes null
 * (SWR disabled), and it would 401 anyway if CRON_SECRET is set. ScanStatus then falls back to the queue
 * depth from the graph summary.
 */
export function useArbScanner(n = 12) {
  const driverOwnsScanning = process.env.NEXT_PUBLIC_ARB_DRIVER === "1";
  return useSWR<{ unitsProcessed: number; remaining: number; rpmAvailable: number }>(
    driverOwnsScanning ? null : `/api/arb/scan?n=${n}`,
    fetcher,
    { refreshInterval: 7_000, revalidateOnFocus: false, dedupingInterval: 5_000 }
  );
}

/** One-time lock-graph summary (first call builds the graph; cached server-side 6h). */
export function useLockGraphSummary() {
  return useSWR<GraphSummary>("/api/arb/graph", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

export interface TrackedRep {
  internalChainId: number;
  chainName: string;
  address: string;
  isNativeRoot: boolean;
  symbol?: string;
  decimals?: number;
}

export interface TrackedFamily {
  debridgeId: string;
  symbol?: string;
  nativeChainId: number;
  nativeChainName: string;
  repCount: number;
  reps: TrackedRep[];
}

export interface GraphDetailResponse {
  families: TrackedFamily[];
  total: number;
  page: number;
  take: number;
  partial: boolean;
  builtAt: number;
  chainsScanned: number[];
}

/** Browsable tracked dePort asset set (families + per-chain reps). Reuses the server-cached graph. */
export function useTrackedFamilies(opts: { page?: number; take?: number; multiChainOnly?: boolean } = {}) {
  const p = new URLSearchParams({ detail: "1" });
  if (opts.page) p.set("page", String(opts.page));
  if (opts.take) p.set("take", String(opts.take));
  if (opts.multiChainOnly) p.set("multiChainOnly", "1");
  return useSWR<GraphDetailResponse>(`/api/arb/graph?${p.toString()}`, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
    // Toggling "Multi-chain only" (or paging) changes the SWR key; keepPreviousData keeps the prior
    // rows visible during the refetch instead of dropping to a full skeleton each time (fix #12).
    keepPreviousData: true,
  });
}

// --- LayerZero OFT tracker ---
import type { LzOftsResponse, LzLiquidityResponse } from "./layerzero/types";

export function useLzOfts(symbols?: string) {
  const url =
    symbols && symbols.trim()
      ? `/api/lz/ofts?symbols=${encodeURIComponent(symbols.trim())}`
      : "/api/lz/ofts";
  return useSWR<LzOftsResponse>(url, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 600_000,
  });
}

/** Batched per-token pool liquidity; each item keyed as `${chainKey}:${tradeAddress}`. */
export function useLzLiquidity(items: string[]) {
  const key = items.length
    ? `/api/lz/liquidity?items=${encodeURIComponent(items.join(","))}`
    : null;
  return useSWR<LzLiquidityResponse>(key, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

/**
 * Tolerant fetcher for the optional price/cex/logo endpoints. These routes live on sibling
 * branches not yet merged here, so they 404 at runtime — return null instead of throwing so the
 * UI degrades gracefully (column/badge/logo simply omitted) rather than surfacing an error.
 */
const softFetcher = async <T>(url: string): Promise<T | null> => {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
};

/** Map of `${chainKey}:${tradeAddress}` -> USD price (null when unknown). */
export type LzPriceResponse = Record<string, number | null>;
/** Per-symbol CEX listing flags; tolerant of either booleans or truthy values per venue. */
export type LzCexResponse = Record<string, Record<string, unknown> | null>;
/** Map of `${chainKey}:${tradeAddress}` (or symbol) -> logo URL (null when unknown). */
export type LzLogosResponse = Record<string, string | null>;

/**
 * The /api/lz/price route returns a metrics object per item
 * (`{ priceUsd, liquidityUsd, volumeH24Usd, fdvUsd } | null`); the UI only needs the spot
 * price, so flatten each entry to its `priceUsd` number (null when missing/non-numeric).
 */
const priceFetcher = async (url: string): Promise<LzPriceResponse | null> => {
  const raw = await softFetcher<Record<string, { priceUsd?: number | null } | null>>(url);
  if (!raw) return null;
  const out: LzPriceResponse = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v && typeof v.priceUsd === "number" ? v.priceUsd : null;
  }
  return out;
};

/**
 * Batched per-token spot price; each item keyed as `${chainKey}:${tradeAddress}`.
 * Graceful: a missing route or failure resolves to `null` data, treated as "no price".
 */
export function useLzPrice(items: string[]) {
  const key = items.length
    ? `/api/lz/price?items=${encodeURIComponent(items.join(","))}`
    : null;
  return useSWR<LzPriceResponse | null>(key, priceFetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

/** Batched per-symbol CEX listing badges. Graceful: failure resolves to "no data". */
export function useLzCex(symbols: string[]) {
  const key = symbols.length
    ? `/api/lz/cex?symbols=${encodeURIComponent(symbols.join(","))}`
    : null;
  return useSWR<LzCexResponse | null>(key, softFetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 600_000,
  });
}

/** Batched token logos keyed as `${chainKey}:${tradeAddress}` or by symbol. Graceful on failure. */
export function useLzLogos(items: string[]) {
  const key = items.length
    ? `/api/lz/logo?items=${encodeURIComponent(items.join(","))}`
    : null;
  return useSWR<LzLogosResponse | null>(key, softFetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 600_000,
  });
}

// --- Symbiosis Octopool scanner ---
import type { SymOpportunity } from "./symbiosis/types";

export interface SymbiosisResponse {
  opportunities: SymOpportunity[];
  total: number;
  fetchedAt: number;
}

/** Live Symbiosis positive-spread feed (Symbiosis ranks these; we proxy + cache ~15s). */
export function useSymbiosis() {
  return useSWR<SymbiosisResponse>("/api/arb/symbiosis", fetcher, {
    refreshInterval: 20_000,
    revalidateOnFocus: false,
    dedupingInterval: 10_000,
  });
}
