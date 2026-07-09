import type { Hex } from "viem";
import { getFixedFeeWei } from "../onchain/debridge-gate";
import { DEPORT_CHAINS, getChainByInternalId } from "./registry";

/**
 * Documented flat dePort fee per chain (native token), used as a fallback when the live
 * `getDebridgeChainAssetFixedFee` read fails. Now sourced from the chain registry's `docFeeNative` (single
 * source of truth); kept as a derived view for back-compat. The live read is still preferred.
 */
export const DOC_FIXED_FEE_NATIVE: Record<number, number> = Object.fromEntries(
  DEPORT_CHAINS.filter((c) => c.docFeeNative != null).map((c) => [c.internalId, c.docFeeNative as number])
);

/** PURE: convert a native-wei fee to USD. */
export function feeWeiToUsd(feeWei: bigint, nativeDecimals: number, nativeUsdPrice: number): number {
  const native = Number(feeWei) / 10 ** nativeDecimals;
  return native * nativeUsdPrice;
}

/** PURE: convert the documented (human-unit) native fee to USD. */
export function docFeeToUsd(internalChainId: number, nativeUsdPrice: number): number {
  const native = getChainByInternalId(internalChainId)?.docFeeNative ?? 0;
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
