/**
 * LayerZero chainKey -> EVM chain id + GeckoTerminal network slug.
 *
 * The OFT list (`metadata.layerzero-api.com/.../experiment/ofts/list`) keys each token's
 * deployments by LayerZero's OWN chain key (e.g. "ethereum", "zkconsensys" for Linea,
 * "hyperliquid" for HyperEVM) — NOT by EVM chain id. We map those here so we can build
 * explorer links (by EVM chain id) and look up DEX liquidity (by GeckoTerminal slug).
 *
 * Coverage goal: every chainKey that appears in the live OFT list (~75 keys) so the UI
 * shows real names/links instead of "—". chainKeys + EVM ids are cross-checked against
 * `metadata.layerzero-api.com/v1/metadata` (chainDetails.nativeChainId); gtSlugs are
 * cross-checked against GeckoTerminal's network list (`api.geckoterminal.com/api/v2/networks`).
 *
 * Unknown keys degrade gracefully (display name only, no liquidity), mirroring the
 * "missing slug => skip" behaviour in lib/liquidity/geckoterminal.ts. `evmChainId` is null
 * for non-EVM chains (Solana/Aptos/TON/Tron), which may still expose a `gtSlug` for liquidity.
 *
 * GeckoTerminal slugs are best-effort: a wrong/unknown slug simply yields null liquidity
 * (the token endpoint 404s and is caught), never an error. We omit `gtSlug` when we can't
 * confidently match a GeckoTerminal network rather than guess.
 */
export interface LzChain {
  evmChainId: number | null;
  name: string;
  /** GeckoTerminal network slug; omitted when unknown. */
  gtSlug?: string;
}

export const LZ_CHAINS: Record<string, LzChain> = {
  // --- L1s & majors ---
  ethereum: { evmChainId: 1, name: "Ethereum", gtSlug: "eth" },
  flare: { evmChainId: 14, name: "Flare", gtSlug: "flare" },
  cronos: { evmChainId: 25, name: "Cronos", gtSlug: "cro" },
  // LayerZero keys Cronos EVM as "cronosevm"; accept both.
  cronosevm: { evmChainId: 25, name: "Cronos", gtSlug: "cro" },
  rootstock: { evmChainId: 30, name: "Rootstock", gtSlug: "rootstock" },
  xpla: { evmChainId: 37, name: "XPLA" },
  telos: { evmChainId: 40, name: "Telos", gtSlug: "tlos" },
  bsc: { evmChainId: 56, name: "BNB Chain", gtSlug: "bsc" },
  gnosis: { evmChainId: 100, name: "Gnosis", gtSlug: "xdai" },
  unichain: { evmChainId: 130, name: "Unichain", gtSlug: "unichain" },
  polygon: { evmChainId: 137, name: "Polygon", gtSlug: "polygon_pos" },
  sonic: { evmChainId: 146, name: "Sonic", gtSlug: "sonic" },
  manta: { evmChainId: 169, name: "Manta Pacific", gtSlug: "manta-pacific" },
  xlayer: { evmChainId: 196, name: "X Layer", gtSlug: "x-layer" },
  opbnb: { evmChainId: 204, name: "opBNB", gtSlug: "opbnb" },
  tac: { evmChainId: 239, name: "TAC", gtSlug: "tac" },
  fantom: { evmChainId: 250, name: "Fantom", gtSlug: "ftm" },
  fraxtal: { evmChainId: 252, name: "Fraxtal", gtSlug: "fraxtal" },
  zksync: { evmChainId: 324, name: "zkSync Era", gtSlug: "zksync" },
  optimism: { evmChainId: 10, name: "Optimism", gtSlug: "optimism" },
  astar: { evmChainId: 592, name: "Astar", gtSlug: "astr" },
  redstone: { evmChainId: 690, name: "Redstone", gtSlug: "redstone" },
  flow: { evmChainId: 747, name: "Flow EVM", gtSlug: "flow-evm" },
  worldchain: { evmChainId: 480, name: "World Chain", gtSlug: "world-chain" },
  zora: { evmChainId: 7777777, name: "Zora", gtSlug: "zora-network" },
  metis: { evmChainId: 1088, name: "Metis", gtSlug: "metis" },
  // LayerZero keys Polygon zkEVM as "zkpolygon"; the metadata omits it, so the id (1101)
  // is the well-known canonical value.
  zkpolygon: { evmChainId: 1101, name: "Polygon zkEVM", gtSlug: "polygon-zkevm" },
  lisk: { evmChainId: 1135, name: "Lisk", gtSlug: "lisk" },
  coredao: { evmChainId: 1116, name: "Core", gtSlug: "core" },
  moonbeam: { evmChainId: 1284, name: "Moonbeam", gtSlug: "glmr" },
  moonriver: { evmChainId: 1285, name: "Moonriver", gtSlug: "movr" },
  glue: { evmChainId: 1300, name: "Glue", gtSlug: "glue" },
  sei: { evmChainId: 1329, name: "Sei", gtSlug: "sei-evm" },
  // LayerZero keys Vana (chain id 1480) as "islander".
  islander: { evmChainId: 1480, name: "Vana", gtSlug: "vana" },
  gravity: { evmChainId: 1625, name: "Gravity", gtSlug: "gravity-alpha" },
  soneium: { evmChainId: 1868, name: "Soneium", gtSlug: "soneium" },
  lightlink: { evmChainId: 1890, name: "LightLink", gtSlug: "lightlink-phoenix" },
  swell: { evmChainId: 1923, name: "Swell", gtSlug: "swellchain" },
  sanko: { evmChainId: 1996, name: "Sanko", gtSlug: "sanko-mainnet" },
  kava: { evmChainId: 2222, name: "Kava", gtSlug: "kava" },
  goat: { evmChainId: 2345, name: "GOAT", gtSlug: "goat" },
  morph: { evmChainId: 2818, name: "Morph", gtSlug: "morph-l2" },
  peaq: { evmChainId: 3338, name: "peaq", gtSlug: "peaq" },
  mantle: { evmChainId: 5000, name: "Mantle", gtSlug: "mantle" },
  somnia: { evmChainId: 5031, name: "Somnia", gtSlug: "somnia" },
  nibiru: { evmChainId: 6900, name: "Nibiru", gtSlug: "nibiru" },
  cyber: { evmChainId: 7560, name: "Cyber", gtSlug: "cyber" },
  klaytn: { evmChainId: 8217, name: "Kaia", gtSlug: "kaia" },
  base: { evmChainId: 8453, name: "Base", gtSlug: "base" },
  iota: { evmChainId: 8822, name: "IOTA EVM", gtSlug: "iota-evm" },
  // "apexfusionnexus" is the ApeX Fusion Nexus EVM chain; no confident GT slug.
  apexfusionnexus: { evmChainId: 9069, name: "ApeX Fusion Nexus" },
  // HyperEVM: eth_chainId is 999 (see lib/deport/registry.ts).
  hyperliquid: { evmChainId: 999, name: "HyperEVM", gtSlug: "hyperevm" },
  hyperevm: { evmChainId: 999, name: "HyperEVM", gtSlug: "hyperevm" },
  abstract: { evmChainId: 2741, name: "Abstract", gtSlug: "abstract" },
  ape: { evmChainId: 33139, name: "ApeChain", gtSlug: "apechain" },
  mode: { evmChainId: 34443, name: "Mode", gtSlug: "mode" },
  bob: { evmChainId: 60808, name: "BOB", gtSlug: "bob-network" },
  arbitrum: { evmChainId: 42161, name: "Arbitrum", gtSlug: "arbitrum" },
  celo: { evmChainId: 42220, name: "Celo", gtSlug: "celo" },
  etherlink: { evmChainId: 42793, name: "Etherlink", gtSlug: "etherlink" },
  hemi: { evmChainId: 43111, name: "Hemi", gtSlug: "hemi" },
  avalanche: { evmChainId: 43114, name: "Avalanche", gtSlug: "avax" },
  zircuit: { evmChainId: 48900, name: "Zircuit", gtSlug: "zircuit" },
  sophon: { evmChainId: 50104, name: "Sophon", gtSlug: "sophon" },
  ink: { evmChainId: 57073, name: "Ink", gtSlug: "ink" },
  // LayerZero keys Linea as "zkconsensys"; accept both.
  linea: { evmChainId: 59144, name: "Linea", gtSlug: "linea" },
  zkconsensys: { evmChainId: 59144, name: "Linea", gtSlug: "linea" },
  bera: { evmChainId: 80094, name: "Berachain", gtSlug: "berachain" },
  berachain: { evmChainId: 80094, name: "Berachain", gtSlug: "berachain" },
  blast: { evmChainId: 81457, name: "Blast", gtSlug: "blast" },
  // LayerZero keys Plume mainnet as "plumephoenix"; accept "plume" too.
  plumephoenix: { evmChainId: 98866, name: "Plume", gtSlug: "plume-network" },
  plume: { evmChainId: 98866, name: "Plume", gtSlug: "plume-network" },
  taiko: { evmChainId: 167000, name: "Taiko", gtSlug: "taiko" },
  scroll: { evmChainId: 534352, name: "Scroll", gtSlug: "scroll" },
  // Zero Network is absent from LZ metadata; 543210 is the well-known canonical id.
  zero: { evmChainId: 543210, name: "Zero Network", gtSlug: "zero-network" },
  "zero-network": { evmChainId: 543210, name: "Zero Network", gtSlug: "zero-network" },
  katana: { evmChainId: 747474, name: "Katana", gtSlug: "katana" },
  // LayerZero keys Corn (chain id 21000000) as "mp1".
  mp1: { evmChainId: 21000000, name: "Corn", gtSlug: "corn" },
  degen: { evmChainId: 666666666, name: "Degen", gtSlug: "degenchain" },
  aurora: { evmChainId: 1313161554, name: "Aurora", gtSlug: "aurora" },
  xdc: { evmChainId: 50, name: "XDC", gtSlug: "xdc" },
  // Non-EVM: no EVM explorer; liquidity may still resolve via GeckoTerminal.
  // (Tron's LZ "nativeChainId" is a synthetic id, not an EVM chain id, so it's null here.)
  solana: { evmChainId: null, name: "Solana", gtSlug: "solana" },
  aptos: { evmChainId: null, name: "Aptos", gtSlug: "aptos" },
  ton: { evmChainId: null, name: "TON", gtSlug: "ton" },
  tron: { evmChainId: null, name: "Tron", gtSlug: "tron" },
};

export function lzChain(chainKey: string): LzChain | undefined {
  return LZ_CHAINS[chainKey] ?? LZ_CHAINS[chainKey.toLowerCase()];
}

export function lzGtSlug(chainKey: string): string | undefined {
  return lzChain(chainKey)?.gtSlug;
}
