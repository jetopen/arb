/** Symbiosis cross-chain Octopool scanner types. */

export interface SymToken {
  symbol: string;
  address: string;
  chainId: number;
  decimals: number;
  priceUsd: number;
  icon?: string;
}

/** Raw entry from GET /v1/positive-spread-routes (token amounts carry `amount` in base units). */
export interface SymRouteRaw {
  tokenAmountIn: SymToken & { amount: string };
  tokenAmountOut: SymToken & { amount: string };
  profit?: number;
  profitBps: number;
}

/** Parsed opportunity for the UI. */
export interface SymOpportunity {
  id: string;
  inSymbol: string;
  inChainId: number;
  inAddress: string;
  inDecimals: number;
  inPriceUsd: number;
  outSymbol: string;
  outChainId: number;
  outAddress: string;
  outDecimals: number;
  outPriceUsd: number;
  /** Spread Symbiosis reports at its chosen size. */
  profitBps: number;
  /** Notional Symbiosis sized the route at, USD. */
  sizeUsd: number;
  /** Whether both legs are EVM (executable quote check supported). */
  evmOnly: boolean;
  /** True for BTC-family wrapped-vs-wrapped (the canonical Octopool skew). */
  btcFamily: boolean;
}

/** Result of an on-demand executable quote at a given clip (POST /v2/quote). */
export interface SymQuote {
  inUsd: number;
  outUsd: number;
  netBps: number;
  priceImpactPct: number;
  estimatedTimeSec: number;
  feeUsd: number | null;
}
