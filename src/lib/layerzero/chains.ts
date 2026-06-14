/**
 * LayerZero chainKey -> EVM chain id + GeckoTerminal network slug.
 *
 * The OFT list (`metadata.layerzero-api.com/.../experiment/ofts/list`) keys each token's
 * deployments by LayerZero's OWN chain key (e.g. "ethereum", "zkconsensys" for Linea,
 * "hyperliquid" for HyperEVM) — NOT by EVM chain id. We map those here so we can build
 * explorer links (by EVM chain id) and look up DEX liquidity (by GeckoTerminal slug).
 *
 * Unknown keys degrade gracefully (display name only, no liquidity), mirroring the
 * "missing slug => skip" behaviour in lib/liquidity/geckoterminal.ts. `evmChainId` is null
 * for non-EVM chains (Solana/Aptos/TON), which may still expose a `gtSlug` for liquidity.
 *
 * GeckoTerminal slugs are best-effort: a wrong/unknown slug simply yields null liquidity
 * (the token endpoint 404s and is caught), never an error.
 */
export interface LzChain {
  evmChainId: number | null;
  name: string;
  /** GeckoTerminal network slug; omitted when unknown. */
  gtSlug?: string;
}

export const LZ_CHAINS: Record<string, LzChain> = {
  ethereum: { evmChainId: 1, name: "Ethereum", gtSlug: "eth" },
  optimism: { evmChainId: 10, name: "Optimism", gtSlug: "optimism" },
  bsc: { evmChainId: 56, name: "BNB Chain", gtSlug: "bsc" },
  gnosis: { evmChainId: 100, name: "Gnosis", gtSlug: "xdai" },
  unichain: { evmChainId: 130, name: "Unichain", gtSlug: "unichain" },
  polygon: { evmChainId: 137, name: "Polygon", gtSlug: "polygon_pos" },
  sonic: { evmChainId: 146, name: "Sonic", gtSlug: "sonic" },
  manta: { evmChainId: 169, name: "Manta Pacific", gtSlug: "manta-pacific" },
  fantom: { evmChainId: 250, name: "Fantom", gtSlug: "fantom" },
  fraxtal: { evmChainId: 252, name: "Fraxtal", gtSlug: "fraxtal" },
  zksync: { evmChainId: 324, name: "zkSync Era", gtSlug: "zksync" },
  cronos: { evmChainId: 25, name: "Cronos", gtSlug: "cro" },
  metis: { evmChainId: 1088, name: "Metis", gtSlug: "metis" },
  sei: { evmChainId: 1329, name: "Sei", gtSlug: "sei-evm" },
  swell: { evmChainId: 1923, name: "Swell", gtSlug: "swell" },
  kava: { evmChainId: 2222, name: "Kava", gtSlug: "kava" },
  morph: { evmChainId: 2818, name: "Morph" },
  mantle: { evmChainId: 5000, name: "Mantle", gtSlug: "mantle" },
  base: { evmChainId: 8453, name: "Base", gtSlug: "base" },
  mode: { evmChainId: 34443, name: "Mode", gtSlug: "mode" },
  arbitrum: { evmChainId: 42161, name: "Arbitrum", gtSlug: "arbitrum" },
  celo: { evmChainId: 42220, name: "Celo", gtSlug: "celo" },
  avalanche: { evmChainId: 43114, name: "Avalanche", gtSlug: "avax" },
  zircuit: { evmChainId: 48900, name: "Zircuit" },
  // LayerZero keys Linea as "zkconsensys"; accept both.
  linea: { evmChainId: 59144, name: "Linea", gtSlug: "linea" },
  zkconsensys: { evmChainId: 59144, name: "Linea", gtSlug: "linea" },
  bera: { evmChainId: 80094, name: "Berachain", gtSlug: "berachain" },
  berachain: { evmChainId: 80094, name: "Berachain", gtSlug: "berachain" },
  blast: { evmChainId: 81457, name: "Blast", gtSlug: "blast" },
  aurora: { evmChainId: 1313161554, name: "Aurora", gtSlug: "aurora" },
  scroll: { evmChainId: 534352, name: "Scroll", gtSlug: "scroll" },
  // HyperEVM: eth_chainId is 999 (see lib/deport/registry.ts).
  hyperliquid: { evmChainId: 999, name: "HyperEVM", gtSlug: "hyperevm" },
  hyperevm: { evmChainId: 999, name: "HyperEVM", gtSlug: "hyperevm" },
  // Non-EVM: no EVM explorer; liquidity may still resolve via GeckoTerminal.
  solana: { evmChainId: null, name: "Solana", gtSlug: "solana" },
  aptos: { evmChainId: null, name: "Aptos", gtSlug: "aptos" },
  ton: { evmChainId: null, name: "TON", gtSlug: "ton" },
};

export function lzChain(chainKey: string): LzChain | undefined {
  return LZ_CHAINS[chainKey] ?? LZ_CHAINS[chainKey.toLowerCase()];
}

export function lzGtSlug(chainKey: string): string | undefined {
  return lzChain(chainKey)?.gtSlug;
}
