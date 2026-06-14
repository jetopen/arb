import { fetchWithRetry } from "../api-client";
import { getExplorerAddressUrl } from "../chains";
import { lzChain } from "./chains";
import type { LzOftDeployment, LzOftToken } from "./types";

const OFT_LIST_URL =
  "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list";

interface RawDeployment {
  address?: string;
  localDecimals?: number;
  type?: string;
  innerTokenAddress?: string;
  approvalRequired?: boolean;
  details?: unknown;
}

interface RawOftGroup {
  name?: string;
  sharedDecimals?: number;
  endpointVersion?: string;
  deployments?: Record<string, RawDeployment>;
}

/** Shape of the LayerZero OFT-list response: keyed by symbol, value is an array of meshes. */
export type RawOftList = Record<string, RawOftGroup[] | undefined>;

/**
 * PURE: normalize the LayerZero OFT-list payload into UI-ready tokens.
 *
 * Key rule: for an OFT_ADAPTER, `address` is the adapter contract (no DEX pool); the real
 * tradeable ERC-20 is `innerTokenAddress`. We expose both and use innerTokenAddress as
 * `tradeAddress` so the liquidity lookup hits the token that actually has pools.
 */
export function parseOftList(raw: RawOftList): LzOftToken[] {
  const tokens: LzOftToken[] = [];
  if (!raw || typeof raw !== "object") return tokens;

  for (const [symbol, groups] of Object.entries(raw)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const deployments: LzOftDeployment[] = [];

      for (const [chainKey, d] of Object.entries(group.deployments ?? {})) {
        if (!d || typeof d.address !== "string" || d.address.length === 0) continue;
        const meta = lzChain(chainKey);
        const isAdapter = (d.type ?? "").toUpperCase().includes("ADAPTER");
        const tradeAddress =
          isAdapter && d.innerTokenAddress ? d.innerTokenAddress : d.address;
        const evmChainId = meta?.evmChainId ?? null;
        const explorerUrl =
          evmChainId != null ? getExplorerAddressUrl(evmChainId, d.address) || null : null;

        deployments.push({
          chainKey,
          chainName: meta?.name ?? chainKey,
          evmChainId,
          address: d.address,
          tradeAddress,
          innerTokenAddress: d.innerTokenAddress,
          localDecimals: typeof d.localDecimals === "number" ? d.localDecimals : 18,
          type: d.type ?? "OFT",
          isAdapter,
          explorerUrl,
        });
      }

      if (deployments.length === 0) continue;
      deployments.sort((a, b) => a.chainName.localeCompare(b.chainName));

      tokens.push({
        symbol,
        name: group.name ?? symbol,
        sharedDecimals:
          typeof group.sharedDecimals === "number" ? group.sharedDecimals : 18,
        endpointVersion: group.endpointVersion ?? "v2",
        deployments,
      });
    }
  }

  tokens.sort(
    (a, b) =>
      a.symbol.localeCompare(b.symbol) || b.deployments.length - a.deployments.length
  );
  return tokens;
}

export interface OftListFilters {
  symbols?: string;
  chainNames?: string;
}

/** Fetch + normalize the LayerZero OFT list (open endpoint, no API key). */
export async function fetchOftList(filters: OftListFilters = {}): Promise<LzOftToken[]> {
  const params = new URLSearchParams();
  if (filters.symbols) params.set("symbols", filters.symbols);
  if (filters.chainNames) params.set("chainNames", filters.chainNames);
  const qs = params.toString();
  const url = `${OFT_LIST_URL}${qs ? `?${qs}` : ""}`;

  const res = await fetchWithRetry(
    url,
    { method: "GET", headers: { Accept: "application/json" } },
    { maxRetries: 2 }
  );
  if (!res.ok) throw new Error(`LayerZero OFT list request failed: ${res.status}`);
  return parseOftList((await res.json()) as RawOftList);
}
