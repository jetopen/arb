/**
 * dePort chain registry.
 *
 * Two chain-id spaces matter and they are NOT the same for every chain:
 *  - `internalId`  — deBridge's own chain id. Used by the deBridge HTTP APIs
 *    (`/v1.0/chain/estimation`, `/dln/order/create-tx`, `/supported-chains-info`) AND returned by
 *    `deBridgeGate.getNativeInfo(...).nativeChainId`. For most EVM chains it equals the EVM chainId,
 *    but NOT for Cronos (100000019), Mantle (100000023), HyperEVM (100000022), Solana, Tron, etc.
 *    (Verified live: estimation rejects chainId=25/5000 with HTTP 400 but accepts 100000019/100000023.)
 *  - `evmChainId`  — the real EVM chain id reported by `eth_chainId`. Used for the viem RPC clients.
 *    (Verified live: HyperEVM eth_chainId = 0x3e7 = 999, not the 998 in the legacy chains.ts.)
 *
 * The registry is keyed by `internalId` because that is the value the deBridge surfaces speak.
 */

export interface DeportChain {
  /** deBridge internal chain id — what the HTTP APIs and getNativeInfo use. */
  internalId: number;
  /** Real EVM chain id — what viem / RPC needs. */
  evmChainId: number;
  name: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** deBridgeGate (DMP) contract address on this chain. */
  gate: string;
  /** Public RPC endpoint; overridable via env RPC_URL_<evmChainId>. */
  defaultRpcUrl: string;
}

const DEFAULT_GATE = "0x43dE2d77BF8027e25dBD179B491e8d64f38398aA";
const BASE_GATE = "0xc1656B63D9EEBa6d114f6bE19565177893e5bCBF";

/** Multicall3 — same address on every supported EVM chain. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * The EVM chains that dePort + deBridge single-chain estimation both support (Phase 1).
 * Non-EVM dePort chains (Solana 7565164, Tron 100000026, Sei 100000027, Injective 100000029) are
 * Phase 3 — they use different deAsset mechanics and are intentionally excluded here.
 */
export const EVM_DEPORT_CHAINS: DeportChain[] = [
  { internalId: 1, evmChainId: 1, name: "Ethereum", nativeSymbol: "ETH", nativeDecimals: 18, gate: DEFAULT_GATE, defaultRpcUrl: "https://ethereum-rpc.publicnode.com" },
  { internalId: 10, evmChainId: 10, name: "Optimism", nativeSymbol: "ETH", nativeDecimals: 18, gate: DEFAULT_GATE, defaultRpcUrl: "https://optimism-rpc.publicnode.com" },
  { internalId: 56, evmChainId: 56, name: "BNB Chain", nativeSymbol: "BNB", nativeDecimals: 18, gate: DEFAULT_GATE, defaultRpcUrl: "https://bsc-rpc.publicnode.com" },
  { internalId: 137, evmChainId: 137, name: "Polygon", nativeSymbol: "POL", nativeDecimals: 18, gate: DEFAULT_GATE, defaultRpcUrl: "https://polygon-bor-rpc.publicnode.com" },
  { internalId: 8453, evmChainId: 8453, name: "Base", nativeSymbol: "ETH", nativeDecimals: 18, gate: BASE_GATE, defaultRpcUrl: "https://base-rpc.publicnode.com" },
  { internalId: 42161, evmChainId: 42161, name: "Arbitrum", nativeSymbol: "ETH", nativeDecimals: 18, gate: DEFAULT_GATE, defaultRpcUrl: "https://arbitrum-one-rpc.publicnode.com" },
  { internalId: 43114, evmChainId: 43114, name: "Avalanche", nativeSymbol: "AVAX", nativeDecimals: 18, gate: DEFAULT_GATE, defaultRpcUrl: "https://avalanche-c-chain-rpc.publicnode.com" },
  { internalId: 59144, evmChainId: 59144, name: "Linea", nativeSymbol: "ETH", nativeDecimals: 18, gate: DEFAULT_GATE, defaultRpcUrl: "https://linea-rpc.publicnode.com" },
  { internalId: 100000019, evmChainId: 25, name: "Cronos", nativeSymbol: "CRO", nativeDecimals: 18, gate: DEFAULT_GATE, defaultRpcUrl: "https://cronos-evm-rpc.publicnode.com" },
  { internalId: 100000023, evmChainId: 5000, name: "Mantle", nativeSymbol: "MNT", nativeDecimals: 18, gate: DEFAULT_GATE, defaultRpcUrl: "https://mantle-rpc.publicnode.com" },
  { internalId: 100000022, evmChainId: 999, name: "HyperEVM", nativeSymbol: "HYPE", nativeDecimals: 18, gate: DEFAULT_GATE, defaultRpcUrl: "https://rpc.hyperliquid.xyz/evm" },
];

const byInternalId = new Map<number, DeportChain>(EVM_DEPORT_CHAINS.map((c) => [c.internalId, c]));
const byEvmChainId = new Map<number, DeportChain>(EVM_DEPORT_CHAINS.map((c) => [c.evmChainId, c]));

export function getChainByInternalId(internalId: number): DeportChain | undefined {
  return byInternalId.get(internalId);
}

export function getChainByEvmId(evmChainId: number): DeportChain | undefined {
  return byEvmChainId.get(evmChainId);
}

/** Map a deBridge internal chain id (e.g. from getNativeInfo) to the EVM chain id. Passthrough if unknown. */
export function internalToEvmChainId(internalId: number): number {
  return byInternalId.get(internalId)?.evmChainId ?? internalId;
}

/** True when we can build the dePort lock-graph and quote on this internal chain id in Phase 1. */
export function isEvmDeportChain(internalId: number): boolean {
  return byInternalId.has(internalId);
}

/** deBridgeGate address for an internal chain id (Base differs from the shared default). */
export function deBridgeGate(internalId: number): string {
  return byInternalId.get(internalId)?.gate ?? DEFAULT_GATE;
}

/** Human-readable chain name for a deBridge internal chain id. */
export function chainName(internalId: number): string {
  return byInternalId.get(internalId)?.name ?? `Chain ${internalId}`;
}

/**
 * Resolve the RPC url, most-specific first:
 *   DEPORT_RPC_URL_<evmChainId>  — a graph-build endpoint (forward getDebridge is the heaviest path;
 *                                  drop a paid/archival URL here for reliable full coverage), then
 *   RPC_URL_<evmChainId>         — a general override, then
 *   chain.defaultRpcUrl          — the public default.
 */
export function getRpcUrl(internalId: number): string {
  const chain = byInternalId.get(internalId);
  if (!chain) throw new Error(`Unknown dePort chain internalId=${internalId}`);
  const deport = process.env[`DEPORT_RPC_URL_${chain.evmChainId}`];
  if (deport && deport.length > 0) return deport;
  const override = process.env[`RPC_URL_${chain.evmChainId}`];
  return override && override.length > 0 ? override : chain.defaultRpcUrl;
}
