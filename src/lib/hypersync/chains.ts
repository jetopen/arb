/**
 * HyperSync (Envio) chain coverage for the on-chain ACTIVITY sweep — the one signal the arb scanner has
 * never checked (raw Transfer/Swap logs, independent of GeckoTerminal/DexScreener/Kyber/0x/1inch). Used
 * ONLY by scripts/backtest-hypersync-activity.mts to MEASURE whether any "dead" dePort rep is actually
 * being traded on-chain (the GRASS-on-Topaz / MGLD class the GT prefilter false-negatives). NOT wired
 * into the live scan/verify paths — gated on the backtest finding activity (see plan).
 *
 * Keyed by deBridge INTERNAL chain id (what enumerateUnits emits); value carries the EVM id, the
 * HyperSync host, and an approximate block time (only used to size a time-bounded lookback window).
 * Covers the app's HyperSync-served EVM chains; deliberately EXCLUDES the gaps: Cronos (evm 25),
 * Flow (747), MegaETH (4326 — no verified endpoint), Solana + Tron (non-EVM / experimental).
 */
export interface HyperSyncChain {
  /** EVM chain id (for reference / logging). */
  evmChainId: number;
  /** HyperSync host, e.g. https://eth.hypersync.xyz — POST /query, GET /height. */
  url: string;
  /**
   * Approximate seconds per block, used to convert a lookback in days into a fromBlock offset. Bias these
   * LOW (a lower bound on the real block time): under-estimating widens the swept window, over-estimating
   * NARROWS it and silently under-samples activity (the fromBlock = height − days·86400/spb math puts spb
   * in the denominator). A too-slow value is a false-dead risk; a too-fast one just costs a little scan.
   */
  secondsPerBlock: number;
}

export const HYPERSYNC_CHAINS = new Map<number, HyperSyncChain>([
  [1, { evmChainId: 1, url: "https://eth.hypersync.xyz", secondsPerBlock: 12 }],
  [10, { evmChainId: 10, url: "https://optimism.hypersync.xyz", secondsPerBlock: 2 }],
  [56, { evmChainId: 56, url: "https://bsc.hypersync.xyz", secondsPerBlock: 0.75 }], // post-Maxwell ~0.75s

  [137, { evmChainId: 137, url: "https://polygon.hypersync.xyz", secondsPerBlock: 2 }],
  [8453, { evmChainId: 8453, url: "https://base.hypersync.xyz", secondsPerBlock: 2 }],
  [42161, { evmChainId: 42161, url: "https://arbitrum.hypersync.xyz", secondsPerBlock: 0.25 }],
  [43114, { evmChainId: 43114, url: "https://avalanche.hypersync.xyz", secondsPerBlock: 2 }],
  [59144, { evmChainId: 59144, url: "https://linea.hypersync.xyz", secondsPerBlock: 3 }],
  // Newer chains (internal id != evm id) — where a fresh, thinly-indexed listing is most likely.
  [100000022, { evmChainId: 999, url: "https://hyperliquid.hypersync.xyz", secondsPerBlock: 1 }], // HyperEVM
  [100000023, { evmChainId: 5000, url: "https://mantle.hypersync.xyz", secondsPerBlock: 2 }], // Mantle
  [100000027, { evmChainId: 1329, url: "https://sei.hypersync.xyz", secondsPerBlock: 0.4 }], // Sei
  [100000030, { evmChainId: 143, url: "https://monad.hypersync.xyz", secondsPerBlock: 1 }], // Monad
]);

/** ERC-20 Transfer(address,address,uint256) topic0 — the cheapest chain-agnostic "is this token moving?" signal. */
export const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** True when we can sweep on-chain activity for this internal chain (token present + HyperSync serves it). */
export function hyperSyncSupported(internalChainId: number): boolean {
  return !!process.env.ENVIO_API_TOKEN && HYPERSYNC_CHAINS.has(internalChainId);
}
