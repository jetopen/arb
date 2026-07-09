import { describe, it, expect, afterEach } from "vitest";
import { parseZeroExPrice, fetchZeroExQuote, zeroExSupported } from "../quotes/zerox";

describe("parseZeroExPrice", () => {
  it("parses buyAmount into a DexQuote (source 0x), lowercasing tokens", () => {
    const q = parseZeroExPrice(
      { buyAmount: "151074262386", sellAmount: "25000000", liquidityAvailable: true },
      { internalChainId: 42161, tokenIn: "0xUSDC", tokenOut: "0xDEMGLD", amountIn: "25000000" }
    );
    expect(q).not.toBeNull();
    expect(q!.amountOut).toBe("151074262386");
    expect(q!.amountIn).toBe("25000000");
    expect(q!.source).toBe("0x");
    expect(q!.tokenIn).toBe("0xusdc");
    expect(q!.tokenOut).toBe("0xdemgld");
  });

  it("returns null when liquidityAvailable is false (no route)", () => {
    expect(
      parseZeroExPrice({ liquidityAvailable: false }, { internalChainId: 1, tokenIn: "a", tokenOut: "b", amountIn: "1" })
    ).toBeNull();
  });

  it("returns null when buyAmount is absent or zero", () => {
    expect(parseZeroExPrice({ buyAmount: "0" }, { internalChainId: 1, tokenIn: "a", tokenOut: "b", amountIn: "1" })).toBeNull();
    expect(parseZeroExPrice({}, { internalChainId: 1, tokenIn: "a", tokenOut: "b", amountIn: "1" })).toBeNull();
  });
});

describe("zeroExSupported / fetchZeroExQuote", () => {
  afterEach(() => {
    delete process.env.ZEROX_API_KEY;
  });

  it("requires both an API key and a 0x-supported chain", () => {
    delete process.env.ZEROX_API_KEY;
    expect(zeroExSupported(1)).toBe(false); // no key
    process.env.ZEROX_API_KEY = "k";
    expect(zeroExSupported(1)).toBe(true); // Ethereum
    expect(zeroExSupported(56)).toBe(true); // BNB
    expect(zeroExSupported(42161)).toBe(true); // Arbitrum
    expect(zeroExSupported(7565164)).toBe(false); // Solana — not an 0x EVM chain
    expect(zeroExSupported(100000027)).toBe(false); // Sei — not 0x-supported
  });

  it("fetchZeroExQuote returns null without an API key (graceful skip)", async () => {
    delete process.env.ZEROX_API_KEY;
    expect(await fetchZeroExQuote(1, "0xa", "0xb", "1000000")).toBeNull();
  });
});
