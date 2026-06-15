import type { Hex } from "viem";
import { getFixedFeeWei } from "../onchain/debridge-gate";
import { getChainByInternalId } from "./registry";

/**
 * Documented flat dePort fee per chain (native token), used as a fallback when the live
 * `getDebridgeChainAssetFixedFee` read fails. Source: deBridge DMP fees doc. These are deliberately
 * NOT authoritative — the live read is preferred; this only keeps the scanner running on RPC hiccups.
 */
export const DOC_FIXED_FEE_NATIVE: Record<number, number> = {
  1: 0.001, // Ethereum (ETH)
  10: 0.001, // Optimism (ETH)
  56: 0.005, // BNB
  137: 0.5, // Polygon (POL)
  8453: 0.001, // Base (ETH)
  42161: 0.001, // Arbitrum (ETH)
  43114: 0.05, // Avalanche (AVAX)
  59144: 0.001, // Linea (ETH)
  100000019: 15, // Cronos (CRO)
  100000023: 2, // Mantle (MNT) — approximate
  100000022: 0.05, // HyperEVM (HYPE) — approximate
  7565164: 0.01, // Solana (SOL) — approximate; refine with the real dePort fee
};

/** PURE: convert a native-wei fee to USD. */
export function feeWeiToUsd(feeWei: bigint, nativeDecimals: number, nativeUsdPrice: number): number {
  const native = Number(feeWei) / 10 ** nativeDecimals;
  return native * nativeUsdPrice;
}

/** PURE: convert the documented (human-unit) native fee to USD. */
export function docFeeToUsd(internalChainId: number, nativeUsdPrice: number): number {
  const native = DOC_FIXED_FEE_NATIVE[internalChainId] ?? 0;
  return native * nativeUsdPrice;
}

/**
 * Flat redemption fee in USD for an asset on a chain. Tries the live gate read, falls back to the
 * documented table. `nativeUsdPrice` is the chain's gas-token price (sourced elsewhere, e.g. DefiLlama).
 */
export async function getFixedFeeUsd(
  internalChainId: number,
  debridgeId: Hex,
  nativeUsdPrice: number
): Promise<number> {
  const chain = getChainByInternalId(internalChainId);
  const decimals = chain?.nativeDecimals ?? 18;
  try {
    const wei = await getFixedFeeWei(internalChainId, debridgeId);
    if (wei > 0n) return feeWeiToUsd(wei, decimals, nativeUsdPrice);
  } catch {
    // fall through to documented fallback
  }
  return docFeeToUsd(internalChainId, nativeUsdPrice);
}
