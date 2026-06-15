import { describe, it, expect, beforeEach } from "vitest";
import type { PublicClient } from "viem";
import {
  enumerateNativeInfo,
  enumerateDebridgeReps,
  enumerateErc20Meta,
  computeDebridgeId,
  type FamilyKey,
} from "../onchain/debridge-gate";
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

describe("enumerateDebridgeReps (forward getDebridge)", () => {
  const families: FamilyKey[] = [
    { debridgeId: "0xd1", nativeChainId: 42161, nativeAddress: "0xARBNATIVE" }, // exists here, matching origin
    { debridgeId: "0xd2", nativeChainId: 1, nativeAddress: "0xETHNATIVE" }, // exist=false -> dropped
    { debridgeId: "0xd3", nativeChainId: 137, nativeAddress: "0xPOLYNATIVE" }, // origin mismatch -> dropped
    { debridgeId: "0xd4", nativeChainId: 10, nativeAddress: "0xOPNATIVE" }, // zero address -> dropped
    { debridgeId: "0xd5", nativeChainId: 8453, nativeAddress: "0xBASENATIVE" }, // revert -> dropped
  ];

  // One getDebridge tuple per contract, keyed off the debridgeId arg: (chainId, _, _, _, tokenAddress, _, exist)
  function gdMock(): PublicClient {
    return {
      multicall: async ({ contracts }: { contracts: Array<{ args: readonly [string] }> }) =>
        contracts.map((c) => {
          switch (c.args[0]) {
            case "0xd1":
              return { status: "success", result: [42161n, 0n, 0n, 0n, "0xAaBb0000000000000000000000000000000000Cc", 0, true] };
            case "0xd2":
              return { status: "success", result: [1n, 0n, 0n, 0n, "0x1111111111111111111111111111111111111111", 0, false] };
            case "0xd3":
              return { status: "success", result: [999n, 0n, 0n, 0n, "0x2222222222222222222222222222222222222222", 0, true] };
            case "0xd4":
              return { status: "success", result: [10n, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", 0, true] };
            default:
              return { status: "failure" };
          }
        }),
    } as unknown as PublicClient;
  }

  it("emits a rep only on exist + matching native chainId; lowercases; carries nativeAddress", async () => {
    __setPublicClient(56, gdMock());
    const { reps, ok } = await enumerateDebridgeReps(56, families);
    expect(ok).toBe(true);
    expect(reps).toHaveLength(1);
    expect(reps[0]).toEqual({
      internalChainId: 56,
      address: "0xaabb0000000000000000000000000000000000cc",
      nativeChainId: 42161,
      nativeAddress: "0xarbnative",
    });
  });

  it("recovers via the halving ladder when wide calls fail, and reports not-ok only when even the floor fails", async () => {
    const big: FamilyKey[] = Array.from({ length: 100 }, (_, i) => ({
      debridgeId: ("0x" + (i + 1).toString(16).padStart(4, "0")) as `0x${string}`,
      nativeChainId: 56,
      nativeAddress: "0xnat",
    }));

    // Throws for wide batches (>60), succeeds for narrow ones -> halving recovers, ok stays true.
    __setPublicClient(56, {
      multicall: async ({ contracts }: { contracts: unknown[] }) => {
        if (contracts.length > 60) throw new Error("response too large");
        return contracts.map(() => ({
          status: "success",
          result: [56n, 0n, 0n, 0n, "0xabc0000000000000000000000000000000000abc", 0, true],
        }));
      },
    } as unknown as PublicClient);
    const recovered = await enumerateDebridgeReps(56, big);
    expect(recovered.ok).toBe(true);
    expect(recovered.reps).toHaveLength(100);

    // Always throws -> ladder bottoms out at the floor: not-ok, no reps (and no throw).
    __setPublicClient(56, {
      multicall: async () => {
        throw new Error("rpc down");
      },
    } as unknown as PublicClient);
    const failed = await enumerateDebridgeReps(56, big);
    expect(failed.ok).toBe(false);
    expect(failed.reps).toHaveLength(0);
  });
});

describe("enumerateErc20Meta", () => {
  it("decodes interleaved decimals/symbol, leaves a failed read undefined, keys by lowercased address; ok stays true on a per-call revert", async () => {
    // contracts are [a0.decimals, a0.symbol, a1.decimals, a1.symbol]; fail a1's decimals (index 2).
    __setPublicClient(56, {
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string }> }) =>
        contracts.map((c, i) => {
          if (c.functionName === "decimals") return i === 2 ? { status: "failure" } : { status: "success", result: 18 };
          return { status: "success", result: "SYM" };
        }),
    } as unknown as PublicClient);

    const { meta, ok } = await enumerateErc20Meta(56, [
      "0xAAA0000000000000000000000000000000000001",
      "0xBBB0000000000000000000000000000000000002",
    ]);
    expect(meta.get("0xaaa0000000000000000000000000000000000001")).toEqual({ decimals: 18, symbol: "SYM" });
    expect(meta.get("0xbbb0000000000000000000000000000000000002")).toEqual({ decimals: undefined, symbol: "SYM" });
    // A per-call revert (allowFailure) is NOT a transport failure — coverage is still complete.
    expect(ok).toBe(true);
  });

  it("reports ok:false when even a floor-sized multicall chunk throws (transport failure → graph goes partial)", async () => {
    // Always-throwing transport: the halving ladder bottoms out at the floor and reports not-ok,
    // surfacing that some reps' decimals never resolved (instead of silently claiming full coverage).
    __setPublicClient(56, {
      multicall: async () => {
        throw new Error("rpc down");
      },
    } as unknown as PublicClient);

    const { meta, ok } = await enumerateErc20Meta(56, ["0xAAA0000000000000000000000000000000000001"]);
    expect(ok).toBe(false);
    // Still address-keyed with undefined fields (never throws), so callers can degrade gracefully.
    expect(meta.get("0xaaa0000000000000000000000000000000000001")).toEqual({ decimals: undefined, symbol: undefined });
  });
});
