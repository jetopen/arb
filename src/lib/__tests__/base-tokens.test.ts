import { describe, it, expect } from "vitest";
import { isQuotableChain, rescaleRaw, tierToBaseUnits, baseToken } from "../arb/base-tokens";

describe("isQuotableChain", () => {
  it("is true for the new non-EVM / bonus chains once they have a base token", () => {
    expect(isQuotableChain(100000027)).toBe(true); // Sei
    expect(isQuotableChain(100000026)).toBe(true); // Tron
    expect(isQuotableChain(100000022)).toBe(true); // HyperEVM (bonus)
    expect(isQuotableChain(100000009)).toBe(true); // Flow (sweep)
    expect(isQuotableChain(7565164)).toBe(true); // Solana
  });
  it("is false for a chain with no base token (e.g. Injective — deferred)", () => {
    expect(isQuotableChain(100000029)).toBe(false); // Injective
    expect(isQuotableChain(999999)).toBe(false);
  });
});

describe("baseToken", () => {
  it("returns the Tron USDT base verbatim (base58 case preserved — never lowercased)", () => {
    expect(baseToken(100000026)?.address).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  });
});

describe("rescaleRaw", () => {
  it("scales UP a raw amount across a positive decimal delta (8 → 18)", () => {
    expect(rescaleRaw("100000000", 8, 18)).toBe("1000000000000000000"); // 1e8 → 1e18
  });
  it("scales DOWN with integer floor across a negative delta (18 → 8), mirroring bridge dust truncation", () => {
    expect(rescaleRaw("1000000000000000000", 18, 8)).toBe("100000000"); // 1e18 → 1e8
    expect(rescaleRaw("1000000009999999999", 18, 8)).toBe("100000000"); // sub-1e10 dust floored away
  });
  it("is a no-op when decimals match (the EVM↔EVM path is unchanged)", () => {
    expect(rescaleRaw("123456789", 6, 6)).toBe("123456789");
  });
  it("returns '0' on a malformed amount rather than throwing", () => {
    expect(rescaleRaw("not-a-number", 8, 18)).toBe("0");
  });
});

describe("tierToBaseUnits", () => {
  it("expresses a USD tier in the base token's units", () => {
    expect(tierToBaseUnits(100, { address: "0x", decimals: 6 })).toBe("100000000");
  });
});
