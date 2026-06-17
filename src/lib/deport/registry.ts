/**
 * dePort chain registry — the SINGLE source of truth for per-chain config.
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
 *
 * ONE ROW PER CHAIN owns everything the scanner needs: whether it is quotable (`baseToken`), how to
 * verify it (`gtSlug` / `kyberSlug`), how to price its gas token (`llamaKey` / `llamaSlug`), its fallback
 * dePort fee (`docFeeNative`), and whether it is scanned on-chain (`onChain` => has a viem client + gate).
 * The old per-concern maps (BASE_USDC, GT_NETWORK, KYBER_SLUG, LLAMA_KEY/SLUG, DOC_FIXED_FEE_NATIVE) are
 * now thin accessors over these rows, so adding a chain is a single edit and a missing field is visible
 * here rather than a silent runtime gap (the bug class that left Monad fee=$0 and MegaETH unverifiable).
 */

/** A chain's USDC/USDT quote base. Presence of a row's `baseToken` is the master "is this chain quotable" switch. */
export interface BaseToken {
  address: string;
  decimals: number;
}

/** deBridge internal chain id for Solana. */
export const SOLANA_INTERNAL_ID = 7565164;
/** deBridge internal chain id for Tron. Its addresses arrive as case-sensitive base58 (T…), not hex. */
export const TRON_INTERNAL_ID = 100000026;
/**
 * Solana USDC (SPL) mint — the quote base on Solana. A case-sensitive base58 string: do NOT lowercase it.
 * Single source of truth, consumed by both the Jupiter quoter (exact-match equality picks the USDC side)
 * and the Solana base-token row — keeping them one constant prevents a silent edit/codemod from desyncing them.
 */
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface DeportChain {
  /** deBridge internal chain id — what the HTTP APIs and getNativeInfo use. */
  internalId: number;
  /** Real EVM chain id — what viem / RPC needs. For non-EVM / quote-only chains this equals `internalId`. */
  evmChainId: number;
  name: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /**
   * True when we build the dePort lock-graph and read this chain on-chain (it has a viem client + gate).
   * Quote-only chains (Solana via Jupiter; Tron/Sei/Flow/Monad/MegaETH via deBridge estimation) are false:
   * they are quotable and verifiable but never scanned with multicall, so their reps come from the event index.
   */
  onChain: boolean;
  /** deBridgeGate (DMP) contract address — on-chain chains only. */
  gate?: string;
  /** Public RPC endpoint; overridable via env RPC_URL_<evmChainId>. On-chain chains only. */
  defaultRpcUrl?: string;
  /** Quote base currency (USDC/USDT). Presence => isQuotableChain. */
  baseToken?: BaseToken;
  /** GeckoTerminal network slug (liquidity gate + spot cross-check). */
  gtSlug?: string;
  /** KyberSwap aggregator slug (the preferred cross-check where covered). */
  kyberSlug?: string;
  /** DefiLlama coin key for the native gas token when it is NOT the EVM zero-address (Solana/Tron/Sei/…). */
  llamaKey?: string;
  /** DefiLlama chain slug — native price via the chain's zero-address. */
  llamaSlug?: string;
  /** Documented flat dePort fee in native units; fallback when the live `getDebridgeChainAssetFixedFee` read is unavailable. */
  docFeeNative?: number;
  /** Display accent color. */
  color?: string;
  /** Native-token logo URL. */
  logoUrl?: string;
  /**
   * Optional ERC20 storage-slot overrides for tx simulation, keyed by lowercased token address. Escape
   * hatch for tokens whose balance/allowance slots the runtime probe (src/lib/sim/slots.ts) can't find;
   * structurally matches that module's `Erc20Slots` (kept inline here so the registry stays a leaf import).
   */
  erc20Slots?: Record<string, { balance: { slot: number; vyper: boolean }; allowance: { slot: number; vyper: boolean } }>;
}

const DEFAULT_GATE = "0x43dE2d77BF8027e25dBD179B491e8d64f38398aA";
const BASE_GATE = "0xc1656B63D9EEBa6d114f6bE19565177893e5bCBF";

/** Multicall3 — same address on every supported EVM chain. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const logo = (internalId: number) =>
  `https://tokens.debridge.finance/Logo/${internalId}/native/big/token-logo.png`;

/**
 * Every dePort chain the scanner knows. `onChain: true` chains are scanned on-chain (graph build, ERC20
 * meta, live fee reads); `onChain: false` chains are quote-only (Solana via Jupiter, the rest via deBridge
 * estimation) and reach the graph through the event index. The config fields below were consolidated from
 * the former BASE_USDC / GT_NETWORK / KYBER_SLUG / LLAMA_* / DOC_FIXED_FEE_NATIVE maps.
 */
export const DEPORT_CHAINS: DeportChain[] = [
  // ---- On-chain EVM chains (lock-graph + on-chain reads) -------------------------------------------------
  { internalId: 1, evmChainId: 1, name: "Ethereum", nativeSymbol: "ETH", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
    baseToken: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 }, gtSlug: "eth", kyberSlug: "ethereum", llamaSlug: "ethereum", docFeeNative: 0.001, color: "#627EEA", logoUrl: logo(1) },
  { internalId: 10, evmChainId: 10, name: "Optimism", nativeSymbol: "ETH", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://optimism-rpc.publicnode.com",
    baseToken: { address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 }, gtSlug: "optimism", kyberSlug: "optimism", llamaSlug: "optimism", docFeeNative: 0.001, color: "#FF0420", logoUrl: logo(10) },
  { internalId: 56, evmChainId: 56, name: "BNB Chain", nativeSymbol: "BNB", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://bsc-rpc.publicnode.com",
    baseToken: { address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 }, gtSlug: "bsc", kyberSlug: "bsc", llamaSlug: "bsc", docFeeNative: 0.005, color: "#F3BA2F", logoUrl: logo(56) },
  { internalId: 137, evmChainId: 137, name: "Polygon", nativeSymbol: "POL", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://polygon-bor-rpc.publicnode.com",
    baseToken: { address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 }, gtSlug: "polygon_pos", kyberSlug: "polygon", llamaSlug: "polygon", docFeeNative: 0.5, color: "#8247E5", logoUrl: logo(137) },
  { internalId: 8453, evmChainId: 8453, name: "Base", nativeSymbol: "ETH", nativeDecimals: 18, onChain: true, gate: BASE_GATE, defaultRpcUrl: "https://base-rpc.publicnode.com",
    baseToken: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 }, gtSlug: "base", kyberSlug: "base", llamaSlug: "base", docFeeNative: 0.001, color: "#0052FF", logoUrl: logo(8453) },
  { internalId: 42161, evmChainId: 42161, name: "Arbitrum", nativeSymbol: "ETH", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://arbitrum-one-rpc.publicnode.com",
    baseToken: { address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 }, gtSlug: "arbitrum", kyberSlug: "arbitrum", llamaSlug: "arbitrum", docFeeNative: 0.001, color: "#28A0F0", logoUrl: logo(42161) },
  { internalId: 43114, evmChainId: 43114, name: "Avalanche", nativeSymbol: "AVAX", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://avalanche-c-chain-rpc.publicnode.com",
    baseToken: { address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6 }, gtSlug: "avax", kyberSlug: "avalanche", llamaSlug: "avax", docFeeNative: 0.05, color: "#E84142", logoUrl: logo(43114) },
  { internalId: 59144, evmChainId: 59144, name: "Linea", nativeSymbol: "ETH", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://linea-rpc.publicnode.com",
    baseToken: { address: "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", decimals: 6 }, gtSlug: "linea", kyberSlug: "linea", llamaSlug: "linea", docFeeNative: 0.001, color: "#61DFFF", logoUrl: logo(59144) },
  { internalId: 100000019, evmChainId: 25, name: "Cronos", nativeSymbol: "CRO", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://cronos-evm-rpc.publicnode.com",
    baseToken: { address: "0xc21223249ca28397b4b6541dffaecc539bff0c59", decimals: 6 }, gtSlug: "cro", kyberSlug: "cronos", llamaSlug: "cronos", docFeeNative: 15, color: "#002D74", logoUrl: logo(100000019) },
  { internalId: 100000023, evmChainId: 5000, name: "Mantle", nativeSymbol: "MNT", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://mantle-rpc.publicnode.com",
    baseToken: { address: "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9", decimals: 6 }, gtSlug: "mantle", kyberSlug: "mantle", llamaSlug: "mantle", docFeeNative: 2, color: "#000000", logoUrl: logo(100000023) },
  { internalId: 100000022, evmChainId: 999, name: "HyperEVM", nativeSymbol: "HYPE", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://rpc.hyperliquid.xyz/evm",
    baseToken: { address: "0xb88339cb7199b77e23db6e890353e22632ba630f", decimals: 6 }, gtSlug: "hyperevm", llamaKey: "coingecko:hyperliquid", docFeeNative: 0.05, color: "#00D1FF", logoUrl: logo(100000022) },
  // Promoted from quote-only to on-chain: the dePort gate (0x43dE…398aA) + Multicall3 are deployed on all
  // of these (verified live), so they ride the same token-list discovery + forward getDebridge pass as the
  // chains above. NB Monad/MegaETH evmChainId corrected to deBridge's originalChainId (143 / 4326).
  // Sei — Circle native USDC (EVM-hex).
  { internalId: 100000027, evmChainId: 1329, name: "Sei", nativeSymbol: "SEI", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://evm-rpc.sei-apis.com",
    baseToken: { address: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392", decimals: 6 }, gtSlug: "sei-evm", llamaKey: "coingecko:sei-network", docFeeNative: 1, color: "#9B1C2E", logoUrl: logo(100000027) },
  // Flow EVM.
  { internalId: 100000009, evmChainId: 747, name: "Flow", nativeSymbol: "FLOW", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://mainnet.evm.nodes.onflow.org",
    baseToken: { address: "0xf1815bd50389c46847f0bda824ec8da914045d14", decimals: 6 }, gtSlug: "flow-evm", llamaKey: "coingecko:flow", docFeeNative: 0.5, color: "#00EF8B", logoUrl: logo(100000009) },
  // Monad (mainnet — evmChainId 143).
  { internalId: 100000030, evmChainId: 143, name: "Monad", nativeSymbol: "MON", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://rpc.monad.xyz",
    baseToken: { address: "0x754704bc059f8c67012fed69bc8a327a5aafb603", decimals: 6 }, gtSlug: "monad", llamaKey: "coingecko:monad", docFeeNative: 0.5, color: "#836EF9", logoUrl: logo(100000030) },
  // MegaETH (gas token is ETH; evmChainId 4326).
  { internalId: 100000031, evmChainId: 4326, name: "MegaETH", nativeSymbol: "ETH", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://megaeth.drpc.org",
    baseToken: { address: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", decimals: 6 }, gtSlug: "megaeth", llamaKey: "coingecko:ethereum", docFeeNative: 0.001, color: "#2B2B2B", logoUrl: logo(100000031) },
  // Story (gas token IP). DISCOVERY-ONLY (no baseToken) — completes families/reps but isn't quoted yet;
  // making it quotable needs a verified GeckoTerminal slug + IP native-price source.
  { internalId: 100000013, evmChainId: 1514, name: "Story", nativeSymbol: "IP", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://mainnet.storyrpc.io",
    docFeeNative: 0.1, color: "#000000", logoUrl: logo(100000013) },
  // Injective native EVM (gas token INJ). DISCOVERY-ONLY — quoting needs a verified slug + INJ price source.
  { internalId: 100000029, evmChainId: 1776, name: "Injective", nativeSymbol: "INJ", nativeDecimals: 18, onChain: true, gate: DEFAULT_GATE, defaultRpcUrl: "https://sentry.evm-rpc.injective.network",
    docFeeNative: 0.05, color: "#00B4CC", logoUrl: logo(100000029) },

  // ---- Quote-only chains (NOT EVM; never multicalled — reps come from the event index + native enumerators) ----
  // Solana — quoted via Jupiter (base58 mint, case-sensitive); never via deBridge estimation.
  { internalId: SOLANA_INTERNAL_ID, evmChainId: SOLANA_INTERNAL_ID, name: "Solana", nativeSymbol: "SOL", nativeDecimals: 9, onChain: false,
    baseToken: { address: SOLANA_USDC_MINT, decimals: 6 }, gtSlug: "solana", llamaKey: "coingecko:solana", docFeeNative: 0.01, color: "#9945FF", logoUrl: logo(SOLANA_INTERNAL_ID) },
  // Tron — USDT (TRC20) base; case-sensitive base58 T-addr (NEVER lowercase). Heavy gas (~$27/trade).
  { internalId: TRON_INTERNAL_ID, evmChainId: TRON_INTERNAL_ID, name: "Tron", nativeSymbol: "TRX", nativeDecimals: 6, onChain: false,
    baseToken: { address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 }, gtSlug: "tron", llamaKey: "coingecko:tron", docFeeNative: 8, color: "#EF0027", logoUrl: logo(TRON_INTERNAL_ID) },
];

/**
 * The EVM chains that dePort + deBridge single-chain estimation both support AND that we scan on-chain.
 * Derived from DEPORT_CHAINS (`onChain`) so it can't drift from the registry. Non-on-chain dePort chains
 * (Solana, Tron, Sei, Flow, Monad, MegaETH) are quotable via HTTP but never multicalled.
 */
export const EVM_DEPORT_CHAINS: DeportChain[] = DEPORT_CHAINS.filter((c) => c.onChain);

const byInternalId = new Map<number, DeportChain>(DEPORT_CHAINS.map((c) => [c.internalId, c]));
const byEvmChainId = new Map<number, DeportChain>(DEPORT_CHAINS.map((c) => [c.evmChainId, c]));

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

/** True when we build the dePort lock-graph and read this internal chain id ON-CHAIN (it has a viem client). */
export function isEvmDeportChain(internalId: number): boolean {
  return byInternalId.get(internalId)?.onChain === true;
}

/** deBridgeGate address for an internal chain id (Base differs from the shared default). */
export function deBridgeGate(internalId: number): string {
  return byInternalId.get(internalId)?.gate ?? DEFAULT_GATE;
}

/** Human-readable chain name for a deBridge internal chain id. Falls back to the generic "Chain <id>". */
export function chainName(internalId: number): string {
  return byInternalId.get(internalId)?.name ?? `Chain ${internalId}`;
}

/**
 * Resolve the RPC url, most-specific first:
 *   DEPORT_RPC_URL_<evmChainId>  — a graph-build endpoint (forward getDebridge is the heaviest path;
 *                                  drop a paid/archival URL here for reliable full coverage), then
 *   RPC_URL_<evmChainId>         — a general override, then
 *   chain.defaultRpcUrl          — the public default.
 * Throws for an unknown chain or a quote-only chain that has no RPC (callers must guard with isEvmDeportChain).
 */
export function getRpcUrl(internalId: number): string {
  const chain = byInternalId.get(internalId);
  if (!chain) throw new Error(`Unknown dePort chain internalId=${internalId}`);
  const deport = process.env[`DEPORT_RPC_URL_${chain.evmChainId}`];
  if (deport && deport.length > 0) return deport;
  const override = process.env[`RPC_URL_${chain.evmChainId}`];
  if (override && override.length > 0) return override;
  if (!chain.defaultRpcUrl) throw new Error(`No RPC for quote-only chain internalId=${internalId}`);
  return chain.defaultRpcUrl;
}
