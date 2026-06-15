/**
 * Base quote currency (USDC) per dePort chain, keyed by deBridge internal chain id.
 * Note BNB Chain USDC is 18 decimals (not 6). HyperEVM is intentionally omitted — no canonical
 * USDC we can rely on yet, so it is excluded as a buy/sell base in Phase 1.
 */
import { SOLANA_USDC_MINT } from "../deport/address-codec";

export interface BaseToken {
  address: string;
  decimals: number;
}

export const BASE_USDC: Record<number, BaseToken> = {
  1: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
  10: { address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 },
  56: { address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 },
  137: { address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 },
  8453: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
  42161: { address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
  43114: { address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6 },
  59144: { address: "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", decimals: 6 },
  100000019: { address: "0xc21223249ca28397b4b6541dffaecc539bff0c59", decimals: 6 }, // Cronos
  100000023: { address: "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9", decimals: 6 }, // Mantle
  // Solana USDC (SPL) — a base58 mint, case-sensitive (do NOT lowercase). Quoted via Jupiter, not deBridge.
  // Address comes from the shared SOLANA_USDC_MINT constant so it can't drift from the Jupiter quoter.
  7565164: { address: SOLANA_USDC_MINT, decimals: 6 },
};

export function baseToken(internalChainId: number): BaseToken | undefined {
  return BASE_USDC[internalChainId];
}

/** True when we can DEX-quote USDC↔token on this chain (it has a USDC base): the EVM dePort chains + Solana. */
export function isQuotableChain(internalChainId: number): boolean {
  return BASE_USDC[internalChainId] !== undefined;
}

/** tier (USD) expressed in the chain's USDC base units, as a decimal string. */
export function tierToBaseUnits(tierUsd: number, base: BaseToken): string {
  return (BigInt(Math.round(tierUsd)) * 10n ** BigInt(base.decimals)).toString();
}
