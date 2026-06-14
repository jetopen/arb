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
  minNetPct?: number;
  tier?: number;
  chainId?: number;
  verifiedOnly?: boolean;
  take?: number;
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
  if (f.minNetPct != null) p.set("minNetPct", String(f.minNetPct));
  if (f.tier) p.set("tier", String(f.tier));
  if (f.chainId) p.set("chainId", String(f.chainId));
  if (f.verifiedOnly) p.set("verifiedOnly", "true");
  if (f.take) p.set("take", String(f.take));
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

/** Polls the scan endpoint to keep the cycling scanner advancing while the page is open. */
export function useArbScanner(n = 12) {
  return useSWR<{ unitsProcessed: number; remaining: number; rpmAvailable: number }>(
    `/api/arb/scan?n=${n}`,
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
