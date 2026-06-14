import { createPublicClient, http, defineChain, type PublicClient } from "viem";
import {
  EVM_DEPORT_CHAINS,
  getChainByInternalId,
  getRpcUrl,
  MULTICALL3_ADDRESS,
  type DeportChain,
} from "../deport/registry";

const clients = new Map<number, PublicClient>();

function toViemChain(c: DeportChain) {
  return defineChain({
    id: c.evmChainId,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: c.nativeDecimals },
    rpcUrls: { default: { http: [getRpcUrl(c.internalId)] } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS as `0x${string}` } },
  });
}

/** Cached viem public client for a dePort chain, keyed by deBridge internal chain id. */
export function getPublicClient(internalChainId: number): PublicClient {
  const cached = clients.get(internalChainId);
  if (cached) return cached;
  const chain = getChainByInternalId(internalChainId);
  if (!chain) throw new Error(`No viem client for internal chain ${internalChainId}`);
  const client = createPublicClient({
    chain: toViemChain(chain),
    transport: http(getRpcUrl(chain.internalId), { batch: true, timeout: 20_000, retryCount: 2 }),
  }) as PublicClient;
  clients.set(internalChainId, client);
  return client;
}

/** Test seam: inject a mock client for a chain (used by unit tests, never in prod paths). */
export function __setPublicClient(internalChainId: number, client: PublicClient) {
  clients.set(internalChainId, client);
}

export function allEvmDeportInternalIds(): number[] {
  return EVM_DEPORT_CHAINS.map((c) => c.internalId);
}
