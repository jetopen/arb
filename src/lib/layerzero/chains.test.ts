import { describe, it, expect } from "vitest";
import { lzChain, lzGtSlug } from "./chains";

describe("lzChain", () => {
  it("maps common EVM chain keys to EVM chain ids + GeckoTerminal slugs", () => {
    expect(lzChain("ethereum")?.evmChainId).toBe(1);
    expect(lzChain("ethereum")?.gtSlug).toBe("eth");
    expect(lzChain("arbitrum")?.evmChainId).toBe(42161);
    expect(lzChain("base")?.gtSlug).toBe("base");
  });

  it("maps hyperliquid -> HyperEVM (evm chain id 999)", () => {
    expect(lzChain("hyperliquid")?.evmChainId).toBe(999);
  });

  it("maps LayerZero's 'zkconsensys' key to Linea", () => {
    expect(lzChain("zkconsensys")?.evmChainId).toBe(59144);
    expect(lzChain("zkconsensys")?.name).toMatch(/Linea/i);
  });

  it("treats non-EVM chains as evmChainId null but keeps a gt slug", () => {
    expect(lzChain("solana")?.evmChainId).toBeNull();
    expect(lzGtSlug("solana")).toBe("solana");
  });

  it("returns undefined for unknown chain keys", () => {
    expect(lzChain("totallyunknownchain")).toBeUndefined();
    expect(lzGtSlug("totallyunknownchain")).toBeUndefined();
  });
});
