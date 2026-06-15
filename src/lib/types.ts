export type MessageStatus =
  | "Awaiting Confirmation"
  | "Awaiting Execution"
  | "Executing"
  | "Executed"
  | "Cancelled"
  | "Failed";

export type OrderState =
  | "None"
  | "Created"
  | "Fulfilled"
  | "SentUnlock"
  | "OrderCancelled"
  | "SentOrderCancel"
  | "ClaimedUnlock"
  | "ClaimedOrderCancel";

export type ExternalCallState =
  | "NoExtCall"
  | "AwaitingOrderFulfillment"
  | "AwaitingExecution"
  | "Executing"
  | "Completed"
  | "Failed"
  | "Cancelled"
  | "OrderCancelled";

export interface NormalizedMessage {
  orderId: string;
  txHash: string;
  dstTxHash: string | null;
  fromChainId: number;
  toChainId: number;
  fromTokenAddress: string;
  toTokenAddress: string;
  fromAmount: string;
  toAmount: string;
  fromTokenSymbol: string;
  toTokenSymbol: string;
  fromTokenDecimals: number;
  toTokenDecimals: number;
  fromTokenName: string;
  toTokenName: string;
  fromTokenLogo: string;
  toTokenLogo: string;
  fee: string;
  fixFee: string;
  operatingExpenses: string;
  status: MessageStatus;
  timestamp: number;
  state: string;
  externalCallState: string;
}

export interface OrderFilterRequest {
  giveChainIds?: number[];
  takeChainIds?: number[];
  orderStates?: string[];
  externalCallStates?: string[];
  skip?: number;
  take?: number;
  filter?: string;
  blockTimestampFrom?: number | null;
  blockTimestampTo?: number | null;
  filterMode?: string;
  maker?: string | null;
  creator?: string | null;
  referralCode?: string | null;
  orderTradeType?: string | null;
}

export interface ChainInfo {
  id: number;
  name: string;
  symbol: string;
  logoUrl: string;
  color: string;
  explorerTxUrl: string;
}

export interface Statistics {
  totalOrders: number;
  totalVolume: string;
  totalFees: string;
}

export interface AlertConfig {
  enabled: boolean;
  inApp: boolean;
  telegram: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  webhook: boolean;
  webhookUrl: string;
}

export interface DashboardSettings {
  alerts: AlertConfig;
  messagesPerPage: number;
  autoRefresh: boolean;
  refreshIntervalSeconds: number;
}

export interface TokenInfo {
  symbol: string;
  name: string;
  address: string;
  chainId: number;
  decimals: number;
  logoURI: string;
  popularityIndex: number;
}

// ---------------------------------------------------------------------------
// dePort cross-chain arbitrage scanner
// ---------------------------------------------------------------------------

/** One representation of a dePort family on a specific chain (a deAsset, or the native root). */
export interface DeAsset {
  /** deBridge internal chain id where this representation lives. */
  internalChainId: number;
  address: string; // lowercased
  symbol?: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
  /** True when this is the native/home token of the family (not a minted deAsset). */
  isNativeRoot: boolean;
}

/**
 * A dePort "family" — every member is 1:1 redeemable to the native root.
 * Identity is the lock origin (debridgeId), NEVER the symbol: the same nominal token locked from
 * different native chains produces different, non-fungible deAssets and thus different families.
 */
export interface Family {
  /** keccak256 of (nativeChainId, nativeAddress) — canonical identity. */
  debridgeId: string;
  /** deBridge internal chain id of the lock origin. */
  nativeChainId: number;
  /** Native token address on the home chain (lowercased). */
  nativeAddress: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  /** True when the home chain is one we can DEX-quote in this phase. */
  nativeOnHomeChain: boolean;
  /** Representations across chains (includes the native root when it is on a quotable chain). */
  reps: DeAsset[];
}

export interface LockGraph {
  families: Family[];
  builtAt: number;
  /** Internal chain ids successfully scanned. */
  chainsScanned: number[];
  /** True when at least one chain's enumeration failed (coverage gap, surfaced in UI). */
  partial: boolean;
}

/** A real, executable DEX quote from an aggregator (price impact included). */
export interface DexQuote {
  internalChainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string; // base units of tokenIn
  amountOut: string; // base units of tokenOut (best route)
  amountInUsd: number;
  amountOutUsd: number;
  priceImpactBps: number;
  gasUsd: number;
  recommendedSlippageBps: number;
  source: "debridge" | "kyberswap" | "onchain" | "jupiter";
}

export type ArbKind = "redemption" | "cross_rep";

export interface ScanUnit {
  debridgeId: string;
  /** chain where we buy the (cheaper) representation, internal id. */
  buyChainId: number;
  /** chain where we sell after redeeming/moving, internal id. */
  sellChainId: number;
  tierUsd: number;
  kind: ArbKind;
}

export interface EdgeResult {
  grossSpreadPct: number;
  dexImpactBuyBps: number;
  dexImpactSellBps: number;
  deportFeeUsd: number;
  gasBuyUsd: number;
  gasSellUsd: number;
  /** sellValueUsd - tierUsd - all costs (optimistic). */
  netUsd: number;
  netEdgePct: number;
  /** netUsd after applying recommended slippage as a haircut (conservative). */
  netUsdConservative: number;
  profitable: boolean;
}

/** Result of independent cross-checking a candidate opportunity. */
export interface Verification {
  verified: boolean;
  /** Sources whose quote agreed within tolerance (e.g. ["debridge","kyberswap"]). */
  sourcesAgreed: string[];
  /** Disagreement between primary and cross-check, in bps. */
  quoteDisagreementBps: number | null;
  /** Pool liquidity (USD) observed for the traded leg, if checked. */
  liquidityUsd: number | null;
  /** Reason the candidate was rejected, when verified === false. */
  rejectReason?: string;
}

export interface Opportunity {
  id: string;
  debridgeId: string;
  kind: ArbKind;
  symbol?: string;
  buyChainId: number;
  sellChainId: number;
  nativeChainId: number;
  tierUsd: number;
  edge: EdgeResult;
  verification: Verification | null;
  /** Ordered legs describing the executable lock path. */
  lockPath: Array<{ chainId: number; address: string; role: string }>;
  computedAt: number;
  /** How many scans have observed this unit (persistence layer). */
  timesSeen?: number;
  /** How many of those observations were profitable — the "repeatedly profitable" signal. */
  timesProfitable?: number;
  firstSeenAt?: number;
}

export interface OpportunityFilter {
  /** Minimum gross round-trip spread % (the price gap). Primary filter for the spread screener. */
  minSpreadPct?: number;
  chainId?: number;
  verifiedOnly?: boolean;
  /** Exclude opportunities whose computedAt is older than this many ms (freshness gate). */
  maxAgeMs?: number;
  /** Collapse to one row per token (family): keep the highest-spread row per debridgeId. */
  groupByToken?: boolean;
  page?: number;
  take?: number;
}
