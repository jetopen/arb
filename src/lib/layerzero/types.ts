/** A single LayerZero OFT deployment on one chain (one row in the UI). */
export interface LzOftDeployment {
  /** LayerZero chain key, e.g. "ethereum", "zkconsensys" (Linea), "hyperliquid". */
  chainKey: string;
  /** Display name, e.g. "Ethereum". */
  chainName: string;
  /** Real EVM chain id, or null for non-EVM / unmapped chains. */
  evmChainId: number | null;
  /** The OFT / adapter contract address as reported by LayerZero (always copyable). */
  address: string;
  /**
   * The address that actually trades on a DEX: for an OFT_ADAPTER this is the underlying
   * ERC-20 (`innerTokenAddress`); for a plain OFT it equals `address`. Used for liquidity.
   */
  tradeAddress: string;
  /** Present only for OFT_ADAPTER deployments: the underlying ERC-20 token. */
  innerTokenAddress?: string;
  localDecimals: number;
  /** "OFT" | "OFT_ADAPTER" | future types. */
  type: string;
  isAdapter: boolean;
  /** Block-explorer address URL, or null when the chain/explorer is unknown. */
  explorerUrl: string | null;
}

/** One OFT mesh for a symbol (a symbol can expose more than one mesh). */
export interface LzOftToken {
  symbol: string;
  /** Issuer / project name, e.g. "Ethena". */
  name: string;
  sharedDecimals: number;
  endpointVersion: string;
  deployments: LzOftDeployment[];
}

export interface LzOftsResponse {
  tokens: LzOftToken[];
}

/** Map of `${chainKey}:${tradeAddress}` -> pool liquidity in USD (null when unknown). */
export type LzLiquidityResponse = Record<string, number | null>;
