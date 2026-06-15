import bs58 from "bs58";
import { isEvmDeportChain } from "./registry";

/** deBridge internal chain id for Solana. */
export const SOLANA_INTERNAL_ID = 7565164;

/**
 * Solana USDC (SPL) mint — the quote base on Solana. A case-sensitive base58 string: do NOT lowercase it.
 * Single source of truth, consumed by both the Jupiter quoter (exact-match equality picks the USDC side)
 * and the BASE_USDC table — keeping them one constant prevents a silent edit/codemod from desyncing them.
 */
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(Math.floor(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Convert a deBridge raw token address (hex, as returned by getEvents / getNativeInfo) to the chain's
 * canonical display form:
 *   - EVM        → lowercase 0x hex (20-byte).
 *   - Solana     → base58 (32-byte pubkey) — what Solscan and wallets show.
 *   - other non-EVM (Tron/Cosmos/…) → raw hex for now (their codecs land incrementally:
 *     Tron base58check, Cosmos/Sei/Injective bech32).
 *
 * The RAW hex (not this canonical form) is what `computeDebridgeId` hashes, so native-root detection
 * must use the raw hex, not the output of this function.
 */
export function toCanonicalAddress(internalChainId: number, rawHex: string): string {
  if (!rawHex) return rawHex;
  const hex = rawHex.toLowerCase();
  if (isEvmDeportChain(internalChainId)) return hex;
  if (internalChainId === SOLANA_INTERNAL_ID) {
    try {
      return bs58.encode(hexToBytes(hex));
    } catch {
      return hex;
    }
  }
  return hex;
}

/** True when we can render a real (non-hex) canonical address for this chain (EVM or Solana so far). */
export function hasCanonicalCodec(internalChainId: number): boolean {
  return isEvmDeportChain(internalChainId) || internalChainId === SOLANA_INTERNAL_ID;
}
