import { describe, it, expect } from "vitest";
import { SUPPORTED_CHAINS, chainById, getChainName, getExplorerTxUrl } from "../chains";

describe("chains", () => {
  it("has 30+ supported chains", () => {
    expect(SUPPORTED_CHAINS.length).toBeGreaterThanOrEqual(30);
  });

  it("chainById returns Ethereum for id=1", () => {
    expect(chainById.get(1)?.name).toBe("Ethereum");
  });

  it("chainById returns Solana for id=7565164", () => {
    expect(chainById.get(7565164)?.name).toBe("Solana");
  });

  it("getChainName returns BNB Chain for id=56", () => {
    expect(getChainName(56)).toBe("BNB Chain");
  });

  it("getChainName falls back to Chain {id} for unknown", () => {
    expect(getChainName(99999)).toBe("Chain 99999");
  });

  it("getExplorerTxUrl returns etherscan URL for Ethereum", () => {
    expect(getExplorerTxUrl(1, "0xabc")).toBe("https://etherscan.io/tx/0xabc");
  });

  it("getExplorerTxUrl returns # for unknown chain", () => {
    expect(getExplorerTxUrl(99999, "0xabc")).toBe("#");
  });

  it("every chain has required fields", () => {
    for (const chain of SUPPORTED_CHAINS) {
      expect(chain.id).toBeTypeOf("number");
      expect(chain.name).toBeTypeOf("string");
      expect(chain.symbol).toBeTypeOf("string");
      expect(chain.logoUrl).toBeTypeOf("string");
      expect(chain.explorerTxUrl).toBeTypeOf("string");
    }
  });
});
