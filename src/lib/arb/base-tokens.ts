/**
 * Quote-base helpers. The per-chain base token (USDC/USDT) now lives on the chain registry row
 * (src/lib/deport/registry.ts) — `baseToken`/`isQuotableChain` read it from there, so a chain becomes
 * scannable by adding ONE registry row, not an entry in a separate map. `BASE_USDC` is kept as a derived
 * view for back-compat. `rescaleRaw` / `tierToBaseUnits` are pure amount helpers and stay here.
 */
import { DEPORT_CHAINS, getChainByInternalId, type BaseToken } from "../deport/registry";

export type { BaseToken };

/** Derived view of the per-chain quote base, keyed by deBridge internal chain id (back-compat). */
export const BASE_USDC: Record<number, BaseToken> = Object.fromEntries(
  DEPORT_CHAINS.filter((c) => c.baseToken).map((c) => [c.internalId, c.baseToken as BaseToken])
);

export function baseToken(internalChainId: number): BaseToken | undefined {
  return getChainByInternalId(internalChainId)?.baseToken;
}

/** True when we can DEX-quote USDC↔token on this chain (its registry row carries a base token). */
export function isQuotableChain(internalChainId: number): boolean {
  return getChainByInternalId(internalChainId)?.baseToken !== undefined;
}

/** tier (USD) expressed in the chain's USDC base units, as a decimal string. */
export function tierToBaseUnits(tierUsd: number, base: BaseToken): string {
  return (BigInt(Math.round(tierUsd)) * 10n ** BigInt(base.decimals)).toString();
}

/**
 * PURE: rescale a raw token amount from `fromDec` to `toDec` decimals. The dePort move conserves VALUE
 * (1 deToken ⇄ 1 native), so when the two legs carry different decimals the raw integer must be scaled by
 * the decimal delta. deBridge mints deTokens with min(native, 8) decimals, so e.g. an 18-dec EVM token's
 * Solana deAsset is 8-dec and the amounts differ by 10^10. A down-scale uses integer floor, mirroring the
 * bridge's normalization that drops precision finer than the deToken's granularity (dust). Equal → unchanged.
 */
export function rescaleRaw(amount: string, fromDec: number, toDec: number): string {
  if (fromDec === toDec) return amount;
  let v: bigint;
  try {
    v = BigInt(amount);
  } catch {
    return "0";
  }
  return toDec > fromDec
    ? (v * 10n ** BigInt(toDec - fromDec)).toString()
    : (v / 10n ** BigInt(fromDec - toDec)).toString();
}
