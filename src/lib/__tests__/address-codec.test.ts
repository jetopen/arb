import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import {
  toCanonicalAddress,
  hasCanonicalCodec,
  canonicalToHashBytes,
  SOLANA_INTERNAL_ID,
  SOLANA_USDC_MINT,
  TRON_INTERNAL_ID,
} from "../deport/address-codec";
import { computeDebridgeId } from "../onchain/debridge-gate";

const toHex = (bytes: Uint8Array) => "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

describe("toCanonicalAddress", () => {
  it("lowercases EVM 0x-hex", () => {
    expect(toCanonicalAddress(1, "0xAbC0000000000000000000000000000000000001")).toBe(
      "0xabc0000000000000000000000000000000000001"
    );
  });

  it("base58-encodes a Solana 32-byte hex pubkey (round-trips the USDC mint)", () => {
    const hex = toHex(bs58.decode(SOLANA_USDC_MINT));
    expect(toCanonicalAddress(SOLANA_INTERNAL_ID, hex)).toBe(SOLANA_USDC_MINT);
  });

  it("passes a Tron base58 address through UNCHANGED (never lowercases — base58check is case-sensitive)", () => {
    const tron = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    expect(toCanonicalAddress(TRON_INTERNAL_ID, tron)).toBe(tron);
    // even a mixed-case base58 from another non-EVM chain is preserved verbatim
    expect(toCanonicalAddress(999999, "TNUC9Qb1rRpS5CbWLmNMxXBjyFoYD5dMSx")).toBe("TNUC9Qb1rRpS5CbWLmNMxXBjyFoYD5dMSx");
  });

  it("encodes a Tron 20-byte hex (getNativeInfo/getDebridge form) to canonical base58check", () => {
    expect(toCanonicalAddress(TRON_INTERNAL_ID, "0x891cdb91d149f23b1a45d9c5ca78a88d0cb44c18")).toBe(
      "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR"
    );
  });

  it("returns empty/falsy input unchanged", () => {
    expect(toCanonicalAddress(1, "")).toBe("");
  });
});

describe("canonicalToHashBytes (bytes computeDebridgeId must hash)", () => {
  it("passes EVM / Solana 0x-hex through (lowercased)", () => {
    expect(canonicalToHashBytes(1, "0xABCdef0000000000000000000000000000000001")).toBe(
      "0xabcdef0000000000000000000000000000000001"
    );
    const solHex = "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001";
    expect(canonicalToHashBytes(SOLANA_INTERNAL_ID, solHex)).toBe(solHex);
  });

  it("reproduces the live Solana debridgeId (SOL family) from its 32-byte hex mint", () => {
    const solHex = "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001";
    const hb = canonicalToHashBytes(SOLANA_INTERNAL_ID, solHex)!;
    expect(computeDebridgeId(SOLANA_INTERNAL_ID, hb).toLowerCase()).toBe(
      "0x15db45753160f76964dfa867510c9ede0ac87ac9ce24771de7efa0dab8251c1a"
    );
  });

  it("decodes a Tron base58 to its BARE 20-byte body and reproduces the live WTRX debridgeId", () => {
    // Verified live: deBridge keys Tron's debridgeId on the 20-byte address body (drop 0x41 + checksum).
    const wtrx = "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";
    const hb = canonicalToHashBytes(TRON_INTERNAL_ID, wtrx)!;
    expect(hb).toMatch(/^0x[0-9a-f]{40}$/); // 20 bytes
    expect(computeDebridgeId(TRON_INTERNAL_ID, hb).toLowerCase()).toBe(
      "0xd1c5783a4542a32fe4ed6c953b25b700446d1e36cbdadee0e1302d35da3bdfa5"
    );
  });

  it("returns null for an un-decodable / corrupted Tron base58 (e.g. lowercased) and for empty input", () => {
    expect(canonicalToHashBytes(TRON_INTERNAL_ID, "tnuc9qb1rrps5cbwlmnmxxbjyfoydxjwfr")).toBeNull();
    expect(canonicalToHashBytes(TRON_INTERNAL_ID, "")).toBeNull();
    expect(canonicalToHashBytes(999999, "SomeCosmosBech32Addr")).toBeNull();
  });
});

describe("hasCanonicalCodec", () => {
  it("covers EVM, Solana, and Tron", () => {
    expect(hasCanonicalCodec(1)).toBe(true); // EVM
    expect(hasCanonicalCodec(SOLANA_INTERNAL_ID)).toBe(true);
    expect(hasCanonicalCodec(TRON_INTERNAL_ID)).toBe(true);
  });
  it("is false for an unregistered chain we have no codec for (e.g. a Cosmos bech32 chain)", () => {
    expect(hasCanonicalCodec(999999)).toBe(false);
  });
});
