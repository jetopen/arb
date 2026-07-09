import bs58 from "bs58";
import { sha256, type Hex } from "viem";
import { isEvmDeportChain, SOLANA_INTERNAL_ID, TRON_INTERNAL_ID, SOLANA_USDC_MINT } from "./registry";

// Chain-identity constants now live in the registry (the single source of truth). Re-exported here so the
// many `from "../deport/address-codec"` importers (scanner, scan-service, jupiter, tests) keep working.
export { SOLANA_INTERNAL_ID, TRON_INTERNAL_ID, SOLANA_USDC_MINT };

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(Math.floor(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): Hex {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as Hex;
}

const TRON_PREFIX = 0x41;

/** Tron base58check address → its bare 20-byte `0x`-hex body (eth_call form). Null if not a valid T-addr. */
export function evmHexFromTronBase58(addr: string): Hex | null {
  try {
    const dec = bs58.decode(addr); // 0x41 + 20-byte body + 4-byte checksum = 25 bytes
    if (dec.length !== 25 || dec[0] !== TRON_PREFIX) return null;
    return bytesToHex(dec.slice(1, 21));
  } catch {
    return null;
  }
}

/** Bare 20-byte EVM-hex (as the Tron gate returns) → canonical Tron base58check `T…` address. */
export function tronBase58FromEvmHex(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const body = new Uint8Array(21);
  body[0] = TRON_PREFIX;
  for (let i = 0; i < 20; i++) body[i + 1] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  // base58check checksum: first 4 bytes of sha256(sha256(0x41||addr)).
  const c2 = sha256(bytesToHex(sha256(bytesToHex(body), "bytes")), "bytes");
  const out = new Uint8Array(25);
  out.set(body, 0);
  out.set(c2.slice(0, 4), 21);
  return bs58.encode(out);
}

/**
 * Convert a deBridge raw token address (as returned by getEvents / getNativeInfo) to the chain's
 * canonical form used for display AND for the quote API:
 *   - EVM        → lowercase 0x hex (20-byte).
 *   - Solana     → base58 (32-byte pubkey) — what Solscan, wallets, and Jupiter use.
 *   - Tron       → base58 `T…` (already canonical from getEvents; case-sensitive — passed through as-is,
 *                  which is also exactly what deBridge's estimation API expects).
 *   - other non-EVM (Cosmos/…) → passed through unchanged (their codecs land incrementally).
 *
 * Only 0x-hex inputs are normalized (lowercased / base58-encoded for Solana). A non-hex input is already
 * a case-sensitive canonical string (e.g. Tron base58) and is returned untouched — lowercasing it would
 * destroy the base58check. The RAW hex (not this form) is what `computeDebridgeId` hashes, so native-root
 * detection must use the raw value, not the output of this function.
 */
export function toCanonicalAddress(internalChainId: number, raw: string): string {
  if (!raw) return raw;
  if (!raw.startsWith("0x")) return raw; // base58 (Tron) / already-canonical — never lowercase
  const hex = raw.toLowerCase();
  if (isEvmDeportChain(internalChainId)) return hex;
  if (internalChainId === SOLANA_INTERNAL_ID) {
    try {
      return bs58.encode(hexToBytes(hex));
    } catch {
      return hex;
    }
  }
  if (internalChainId === TRON_INTERNAL_ID) {
    try {
      return tronBase58FromEvmHex(hex); // 20-byte hex (getNativeInfo/getDebridge) → canonical T-addr
    } catch {
      return hex;
    }
  }
  return hex;
}

/** True when we render a real (non-hex) canonical address for this chain (EVM hex, Solana/Tron base58). */
export function hasCanonicalCodec(internalChainId: number): boolean {
  return isEvmDeportChain(internalChainId) || internalChainId === SOLANA_INTERNAL_ID || internalChainId === TRON_INTERNAL_ID;
}

/**
 * The raw bytes `computeDebridgeId` must hash for a token's native address — i.e. exactly what deBridge
 * hashed when it registered the family. Verified live against on-chain debridgeIds:
 *   - EVM / Solana → the address is ALREADY raw `0x`-hex (20-byte EVM, 32-byte Solana mint) in the event
 *     index and from getNativeInfo → passthrough (lowercased).
 *   - Tron → the BARE 20-byte address. A Tron base58check string decodes to `0x41` + 20 bytes + 4-byte
 *     checksum (25 bytes); drop the `0x41` prefix and the checksum. (NB: deBridge uses the 20-byte body,
 *     NOT the 21-byte `0x41`-prefixed form.)
 * Returns null when the address can't be decoded to the expected shape (e.g. a lowercased/corrupted Tron
 * base58 — getEvents stores many Tron addresses lowercased, which is unrecoverable), so the caller skips
 * it as a native-root candidate rather than anchoring on garbage.
 */
export function canonicalToHashBytes(internalChainId: number, addr: string): Hex | null {
  if (!addr) return null;
  if (addr.startsWith("0x")) return addr.toLowerCase() as Hex; // EVM + Solana: already raw hex
  if (internalChainId === TRON_INTERNAL_ID) {
    try {
      const dec = bs58.decode(addr); // 0x41 + 20-byte addr + 4-byte checksum = 25 bytes
      if (dec.length !== 25 || dec[0] !== 0x41) return null;
      return bytesToHex(dec.slice(1, 21));
    } catch {
      return null;
    }
  }
  return null; // unknown non-EVM codec → not a native-root candidate
}
