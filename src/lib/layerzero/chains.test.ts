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

  it("covers newly-added chains with correct evm chain ids + GeckoTerminal slugs", () => {
    // L1s / sidechains
    expect(lzChain("polygon")?.evmChainId).toBe(137);
    expect(lzChain("polygon")?.gtSlug).toBe("polygon_pos");
    expect(lzChain("moonbeam")?.evmChainId).toBe(1284);
    expect(lzChain("moonbeam")?.gtSlug).toBe("glmr");
    expect(lzChain("klaytn")?.evmChainId).toBe(8217);
    expect(lzChain("klaytn")?.gtSlug).toBe("kaia");
    // L2s / rollups
    expect(lzChain("scroll")?.evmChainId).toBe(534352);
    expect(lzChain("scroll")?.gtSlug).toBe("scroll");
    expect(lzChain("taiko")?.evmChainId).toBe(167000);
    expect(lzChain("taiko")?.gtSlug).toBe("taiko");
    expect(lzChain("ink")?.evmChainId).toBe(57073);
    expect(lzChain("ink")?.gtSlug).toBe("ink");
    expect(lzChain("soneium")?.evmChainId).toBe(1868);
    expect(lzChain("soneium")?.gtSlug).toBe("soneium");
    expect(lzChain("abstract")?.evmChainId).toBe(2741);
    expect(lzChain("abstract")?.gtSlug).toBe("abstract");
    // odd / large chain ids
    expect(lzChain("degen")?.evmChainId).toBe(666666666);
    expect(lzChain("degen")?.gtSlug).toBe("degenchain");
  });

  it("maps LayerZero's 'zkpolygon' key to Polygon zkEVM", () => {
    expect(lzChain("zkpolygon")?.evmChainId).toBe(1101);
    expect(lzChain("zkpolygon")?.gtSlug).toBe("polygon-zkevm");
    expect(lzChain("zkpolygon")?.name).toMatch(/zkEVM/i);
  });

  it("maps LayerZero's 'cronosevm' key to Cronos (alias of 'cronos')", () => {
    expect(lzChain("cronosevm")?.evmChainId).toBe(25);
    expect(lzChain("cronosevm")?.gtSlug).toBe("cro");
  });

  it("maps LayerZero's 'plumephoenix' key (and 'plume' alias) to Plume", () => {
    expect(lzChain("plumephoenix")?.evmChainId).toBe(98866);
    expect(lzChain("plume")?.evmChainId).toBe(98866);
    expect(lzGtSlug("plumephoenix")).toBe("plume-network");
  });

  it("treats tron as non-EVM (null id) but keeps a gt slug", () => {
    expect(lzChain("tron")?.evmChainId).toBeNull();
    expect(lzGtSlug("tron")).toBe("tron");
  });

  it("resolves LayerZero's renamed keys (mp1 -> Corn) with the right slug", () => {
    expect(lzChain("mp1")?.evmChainId).toBe(21000000);
    expect(lzChain("mp1")?.name).toBe("Corn");
    expect(lzGtSlug("mp1")).toBe("corn");
  });

  it("includes chains we cannot confidently slug (name only, no gtSlug)", () => {
    expect(lzChain("xpla")?.evmChainId).toBe(37);
    expect(lzChain("xpla")?.gtSlug).toBeUndefined();
    expect(lzChain("apexfusionnexus")?.evmChainId).toBe(9069);
    expect(lzChain("apexfusionnexus")?.gtSlug).toBeUndefined();
  });

  it("resolves chain keys case-insensitively", () => {
    expect(lzChain("ETHEREUM")?.evmChainId).toBe(1);
    expect(lzChain("Arbitrum")?.gtSlug).toBe("arbitrum");
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
