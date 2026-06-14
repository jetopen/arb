import type { NormalizedMessage, OrderFilterRequest, TokenInfo } from "./types";
import { mapStatus } from "./status-map";

const API_BASE =
  process.env.DEBRIDGE_API_BASE || "https://dln-api.debridge.finance";
const DLN_BASE = "https://dln.debridge.finance";

function getNestedValue(obj: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function num(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw) || 0;
  if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>;
    return Number(r.bigIntegerValue ?? r.stringValue ?? r) || 0;
  }
  return 0;
}

function str(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>;
    return String(r.stringValue ?? r.bigIntegerValue ?? "");
  }
  return String(raw);
}

export function normalizeOrder(raw: Record<string, unknown>): NormalizedMessage {
  const give = (raw.giveOfferWithMetadata ?? {}) as Record<string, unknown>;
  const take = (raw.takeOfferWithMetadata ?? {}) as Record<string, unknown>;
  const giveMeta = (give.metadata ?? {}) as Record<string, unknown>;
  const takeMeta = (take.metadata ?? {}) as Record<string, unknown>;
  const fulfilled = (raw.fulfilledDstEventMetadata ?? null) as Record<string, unknown> | null;

  const state = str(raw.state);
  const externalCallState = str(raw.externalCallState);

  return {
    orderId: str(raw.orderId),
    txHash: str(raw.createEventTransactionHash),
    dstTxHash: fulfilled ? str(fulfilled.transactionHash) : null,
    fromChainId: num(give.chainId),
    toChainId: num(take.chainId),
    fromTokenAddress: str(give.tokenAddress),
    toTokenAddress: str(take.tokenAddress),
    fromAmount: String(num(give.amount)),
    toAmount: String(num(take.amount)),
    fromTokenSymbol: str(giveMeta.symbol),
    toTokenSymbol: str(takeMeta.symbol),
    fromTokenDecimals: num(giveMeta.decimals) || 18,
    toTokenDecimals: num(takeMeta.decimals) || 18,
    fromTokenName: str(giveMeta.name),
    toTokenName: str(takeMeta.name),
    fromTokenLogo: str(giveMeta.logoURI),
    toTokenLogo: str(takeMeta.logoURI),
    fee: String(num(raw.finalPercentFee)),
    fixFee: String(num(raw.fixFee)),
    operatingExpenses: str(
      getNestedValue(raw, "orderMetadata", "operatingExpensesAmount")
    ),
    status: mapStatus(state, externalCallState),
    timestamp: num(raw.creationTimestamp),
    state,
    externalCallState,
  };
}

interface FetchOptions {
  maxRetries?: number;
  apiKey?: string;
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  fetchOpts: FetchOptions = {}
): Promise<Response> {
  const { maxRetries = 3 } = fetchOpts;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(options.headers as Record<string, string>),
      };
      if (fetchOpts.apiKey) {
        headers["Authorization"] = `Bearer ${fetchOpts.apiKey}`;
      }

      const response = await fetch(url, { ...options, headers });

      if (response.status === 429 && attempt < maxRetries) {
        lastError = new Error(`Rate limited (429), retry ${attempt + 1}`);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Request failed after retries");
}

export async function fetchMessages(
  filter: OrderFilterRequest = {}
): Promise<{ messages: NormalizedMessage[]; total: number }> {
  const body: Record<string, unknown> = {
    giveChainIds: filter.giveChainIds ?? [],
    takeChainIds: filter.takeChainIds ?? [],
    orderStates: filter.orderStates ?? [
      "Created",
      "Fulfilled",
      "SentUnlock",
      "ClaimedUnlock",
    ],
    externalCallStates: filter.externalCallStates ?? [],
    skip: filter.skip ?? 0,
    take: Math.min(filter.take ?? 50, 100),
    filter: filter.filter ?? "",
    filterMode: filter.filterMode ?? "CrossChain",
  };

  if (filter.blockTimestampFrom) body.blockTimestampFrom = filter.blockTimestampFrom;
  if (filter.blockTimestampTo) body.blockTimestampTo = filter.blockTimestampTo;
  if (filter.maker) body.maker = filter.maker;

  const response = await fetchWithRetry(`${API_BASE}/api/Orders/filteredList`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const orders = (data.orders ?? []) as Record<string, unknown>[];
  const total = num(data.totalCount);

  return {
    messages: orders.map(normalizeOrder),
    total,
  };
}

export async function fetchChains(): Promise<unknown> {
  const response = await fetchWithRetry(`${DLN_BASE}/v1.0/supported-chains`, {
    method: "GET",
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

export async function fetchStatistics(): Promise<unknown> {
  const response = await fetchWithRetry(
    `${API_BASE}/api/Satistics/getAllTime`,
    { method: "GET" }
  );
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

export async function searchByTxHash(
  txHash: string
): Promise<NormalizedMessage | null> {
  const response = await fetchWithRetry(
    `${API_BASE}/api/Orders/creationTxHash/${txHash}`,
    { method: "GET" }
  );
  if (!response.ok) {
    if (response.status === 400 || response.status === 404) return null;
    throw new Error(`API error: ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  return normalizeOrder(data);
}

export async function fetchOrderDetails(
  orderId: string
): Promise<NormalizedMessage | null> {
  const response = await fetchWithRetry(
    `${API_BASE}/api/Orders/${orderId}`,
    { method: "GET" }
  );
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`API error: ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  return normalizeOrder(data);
}

export interface TokenListEntry {
  symbol: string;
  name: string;
  decimals: number;
  logoURI: string;
  address: string;
  isNative: boolean;
}

const tokenListCache = new Map<number, Map<string, TokenListEntry>>();

export async function getTokenListForChain(chainId: number): Promise<Map<string, TokenListEntry>> {
  if (tokenListCache.has(chainId)) return tokenListCache.get(chainId)!;
  const response = await fetchWithRetry(`${DLN_BASE}/v1.0/token-list?chainId=${chainId}`, { method: "GET" });
  if (!response.ok) return new Map();
  const data = (await response.json()) as {
    tokens: Record<string, { symbol: string; name: string; decimals: number; logoURI: string; address?: string; isNative?: boolean }>;
  };
  const map = new Map<string, TokenListEntry>();
  for (const [addr, meta] of Object.entries(data.tokens ?? {})) {
    map.set(addr.toLowerCase(), {
      symbol: meta.symbol,
      name: meta.name,
      decimals: meta.decimals,
      logoURI: meta.logoURI,
      address: (meta.address ?? addr).toLowerCase(),
      isNative: meta.isNative ?? false,
    });
  }
  tokenListCache.set(chainId, map);
  return map;
}

export async function fetchPopularTokens(take = 200): Promise<TokenInfo[]> {
  const response = await fetchWithRetry(
    `${API_BASE}/api/TokenMetadata/popularTokens?skip=0&take=${take}`,
    { method: "GET" }
  );
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  const data = (await response.json()) as { tokens: Array<{ chainId: { bigIntegerValue: number }; tokenAddress: { stringValue: string }; popularityIndex: number }> };

  const chainIds = [...new Set(data.tokens.map(t => t.chainId.bigIntegerValue))];
  const tokenLists = new Map<number, Map<string, { symbol: string; name: string; decimals: number; logoURI: string }>>();
  await Promise.all(chainIds.map(async (cid) => {
    tokenLists.set(cid, await getTokenListForChain(cid));
  }));

  return data.tokens.map(t => {
    const chainId = t.chainId.bigIntegerValue;
    const addr = t.tokenAddress.stringValue;
    const meta = tokenLists.get(chainId)?.get(addr.toLowerCase());
    return {
      symbol: meta?.symbol ?? "UNKNOWN",
      name: meta?.name ?? "Unknown Token",
      address: addr,
      chainId,
      decimals: meta?.decimals ?? 18,
      logoURI: meta?.logoURI ?? "",
      popularityIndex: t.popularityIndex,
    };
  }).filter(t => t.symbol !== "UNKNOWN");
}
