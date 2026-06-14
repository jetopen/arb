import { describe, it, expect, beforeEach } from "vitest";
import type { PublicClient } from "viem";
import { enumerateNativeInfo, computeDebridgeId } from "../onchain/debridge-gate";
import { __setPublicClient } from "../onchain/client";

/**
 * enumerateNativeInfo is the I/O wrapper around viem multicall. We mock the client so the
 * decode + filter logic is tested without network (viem's fetch is jsdom-incompatible anyway).
 */
function mockClient(results: Array<{ status: "success" | "failure"; result?: readonly [bigint, string] }>): PublicClient {
  return {
    multicall: async ({ contracts }: { contracts: unknown[] }) => {
      expect(contracts.length).toBeLessThanOrEqual(results.length || contracts.length);
      return results;
    },
  } as unknown as PublicClient;
}

describe("enumerateNativeInfo", () => {
  beforeEach(() => {
    // chain 56 client returns: a self-origin native root, a real cross-chain deAsset, a zero (non-deBridge), a failure
    __setPublicClient(
      56,
      mockClient([
        { status: "success", result: [56n, "0x55D398326f99059fF775485246999027B3197955"] }, // native root (origin self)
        { status: "success", result: [1n, "0xDAC17F958D2ee523a2206206994597C13D831ec7"] }, // deAsset of ETH-USDT
        { status: "success", result: [0n, "0x"] }, // not a deBridge token -> dropped
        { status: "failure" }, // reverted -> dropped
      ])
    );
  });

  it("keeps genuine deAssets (incl. self-origin native roots), drops zero/failed, lowercases", async () => {
    const out = await enumerateNativeInfo(56, [
      "0xAAA0000000000000000000000000000000000001",
      "0xBBB0000000000000000000000000000000000002",
      "0xCCC0000000000000000000000000000000000003",
      "0xDDD0000000000000000000000000000000000004",
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      internalChainId: 56,
      address: "0xaaa0000000000000000000000000000000000001",
      nativeChainId: 56,
      nativeAddress: "0x55d398326f99059ff775485246999027b3197955",
    });
    expect(out[1].nativeChainId).toBe(1);
    expect(out[1].nativeAddress).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7");
  });

  it("computeDebridgeId matches the live-verified on-chain encoding", () => {
    expect(computeDebridgeId(1, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2")).toBe(
      "0x7a4f5988eb2e00ce51697c543e0163ef96f4ec0dfd6729d29b0a1dd88626f055"
    );
  });
});
