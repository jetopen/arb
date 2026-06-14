import { describe, it, expect } from "vitest";
import { parseOftList, type RawOftList } from "./ofts";

// Trimmed real response from metadata.layerzero-api.com/.../ofts/list?symbols=USDe
const USDE_FIXTURE: RawOftList = {
  USDe: [
    {
      name: "Ethena",
      sharedDecimals: 6,
      endpointVersion: "v2",
      deployments: {
        ethereum: {
          address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
          localDecimals: 18,
          type: "OFT_ADAPTER",
          innerTokenAddress: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
          approvalRequired: true,
        },
        arbitrum: {
          address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
          localDecimals: 18,
          type: "OFT",
        },
        hyperliquid: {
          address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
          localDecimals: 18,
          type: "OFT",
        },
        zksync: {
          address: "0x39fe7a0dacce31bd90418e3e659fb0b5f0b3db0d",
          localDecimals: 18,
          type: "OFT",
        },
        solana: {
          address: "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT",
          localDecimals: 9,
          type: "OFT",
        },
        someunknownchain: {
          address: "0xabc0000000000000000000000000000000000001",
          localDecimals: 18,
          type: "OFT",
        },
      },
    },
  ],
};

describe("parseOftList", () => {
  const tokens = parseOftList(USDE_FIXTURE);
  const usde = tokens.find((t) => t.symbol === "USDe")!;
  const byChain = (k: string) => usde.deployments.find((d) => d.chainKey === k)!;

  it("produces one token group carrying the issuer name + endpoint version", () => {
    expect(usde).toBeTruthy();
    expect(usde.name).toBe("Ethena");
    expect(usde.endpointVersion).toBe("v2");
    expect(usde.deployments.length).toBe(6);
  });

  it("uses innerTokenAddress as tradeAddress for an OFT_ADAPTER (Ethereum)", () => {
    const eth = byChain("ethereum");
    expect(eth.isAdapter).toBe(true);
    expect(eth.address).toBe("0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34");
    expect(eth.tradeAddress).toBe("0x4c9edd5852cd905f086c759e8383e09bff1e68b3");
    expect(eth.innerTokenAddress).toBe("0x4c9edd5852cd905f086c759e8383e09bff1e68b3");
    expect(eth.explorerUrl).toContain("etherscan.io/address/");
  });

  it("uses address as tradeAddress for a plain OFT (Arbitrum)", () => {
    const arb = byChain("arbitrum");
    expect(arb.isAdapter).toBe(false);
    expect(arb.tradeAddress).toBe(arb.address);
  });

  it("maps hyperliquid -> HyperEVM (evm chain id 999)", () => {
    expect(byChain("hyperliquid").evmChainId).toBe(999);
  });

  it("keeps unknown chains with a name fallback, null evm id, null explorer", () => {
    const u = byChain("someunknownchain");
    expect(u.evmChainId).toBeNull();
    expect(u.chainName).toBe("someunknownchain");
    expect(u.explorerUrl).toBeNull();
  });

  it("handles empty / malformed input without throwing", () => {
    expect(parseOftList({})).toEqual([]);
    expect(parseOftList(null as unknown as RawOftList)).toEqual([]);
    expect(parseOftList({ FOO: undefined })).toEqual([]);
  });
});
