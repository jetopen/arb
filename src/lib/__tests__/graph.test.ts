import { describe, it, expect } from "vitest";
import { assembleFamilies, multiChainFamilies, mergeForwardReps, fillMeta, forwardUniverse, type TokenMeta } from "../deport/graph";
import { computeDebridgeId, type RawDeAsset } from "../onchain/debridge-gate";
import type { Family } from "../types";

// A token natively on chain 56, its address.
const USDT_BSC = "0x55d398326f99059ff775485246999027b3197955";
// A different-origin token that happens to share the symbol "USDT" but is native to chain 1.
const USDT_ETH = "0xdac17f958d2ee523a2206206994597c13d831ec7";

function meta(entries: Array<[number, string, TokenMeta]>): Map<string, TokenMeta> {
  const m = new Map<string, TokenMeta>();
  for (const [chain, addr, v] of entries) m.set(`${chain}:${addr.toLowerCase()}`, v);
  return m;
}

describe("assembleFamilies", () => {
  it("groups a native root and its deAsset on another chain into ONE family", () => {
    const raw: RawDeAsset[] = [
      // native root on 56 (origin == self)
      { internalChainId: 56, address: USDT_BSC, nativeChainId: 56, nativeAddress: USDT_BSC },
      // deAsset of BSC-USDT on Arbitrum (origin == 56)
      { internalChainId: 42161, address: "0xaaa0000000000000000000000000000000000001", nativeChainId: 56, nativeAddress: USDT_BSC },
    ];
    const families = assembleFamilies(raw, meta([
      [56, USDT_BSC, { symbol: "USDT", decimals: 18 }],
      [42161, "0xaaa0000000000000000000000000000000000001", { symbol: "deUSDT", decimals: 18 }],
    ]));

    expect(families).toHaveLength(1);
    const f = families[0];
    expect(f.nativeChainId).toBe(56);
    expect(f.reps).toHaveLength(2);
    expect(f.reps.filter((r) => r.isNativeRoot)).toHaveLength(1);
    expect(f.nativeOnHomeChain).toBe(true); // 56 is a quotable EVM dePort chain
  });

  it("keeps the SAME symbol from DIFFERENT origins as TWO families (the dePort invariant)", () => {
    const raw: RawDeAsset[] = [
      // a deAsset on BSC whose origin is Ethereum-USDT
      { internalChainId: 56, address: "0xbbb0000000000000000000000000000000000001", nativeChainId: 1, nativeAddress: USDT_ETH },
      // a deAsset on Arbitrum whose origin is BSC-USDT
      { internalChainId: 42161, address: "0xccc0000000000000000000000000000000000001", nativeChainId: 56, nativeAddress: USDT_BSC },
    ];
    const families = assembleFamilies(raw, new Map());
    expect(families).toHaveLength(2);
    const ids = new Set(families.map((f) => f.debridgeId));
    expect(ids.size).toBe(2);
    // and neither debridgeId is the other's
    expect(computeDebridgeId(1, USDT_ETH as `0x${string}`)).not.toBe(
      computeDebridgeId(56, USDT_BSC as `0x${string}`)
    );
  });

  it("a deAsset whose origin chain is non-EVM marks nativeOnHomeChain=false", () => {
    const raw: RawDeAsset[] = [
      { internalChainId: 56, address: "0xddd0000000000000000000000000000000000001", nativeChainId: 7565164, nativeAddress: "0x1234" },
    ];
    const [f] = assembleFamilies(raw, new Map());
    expect(f.nativeChainId).toBe(7565164); // Solana
    expect(f.nativeOnHomeChain).toBe(false);
  });

  it("multiChainFamilies keeps only families spanning ≥2 chains", () => {
    const families = assembleFamilies(
      [
        { internalChainId: 56, address: "0xe01", nativeChainId: 56, nativeAddress: "0xe01" },
        { internalChainId: 42161, address: "0xe02", nativeChainId: 56, nativeAddress: "0xe01" },
        // single-chain family (origin elsewhere, only one rep)
        { internalChainId: 8453, address: "0xf01", nativeChainId: 1, nativeAddress: "0xf99" },
      ],
      new Map()
    );
    expect(families).toHaveLength(2);
    expect(multiChainFamilies(families)).toHaveLength(1);
  });
});

describe("forward-expansion merge (the lock-graph rebuild)", () => {
  const ARB = "0x912ce59144191c1204e64559fe8253a0e49e6548"; // Arbitrum-native ARB

  it("merges discovery + forward reps into ONE family spanning all chains (the ARB regression)", () => {
    // Discovery only saw ARB on its home chain (the only chain where it is token-listed).
    const discovered: RawDeAsset[] = [
      { internalChainId: 42161, address: ARB, nativeChainId: 42161, nativeAddress: ARB },
    ];
    // Forward getDebridge found ARB deAssets on 4 more chains that no token-list carries.
    const forward: RawDeAsset[] = [
      { internalChainId: 1, address: "0xa1", nativeChainId: 42161, nativeAddress: ARB },
      { internalChainId: 56, address: "0xa2", nativeChainId: 42161, nativeAddress: ARB },
      { internalChainId: 137, address: "0xa3", nativeChainId: 42161, nativeAddress: ARB },
      { internalChainId: 8453, address: "0xa4", nativeChainId: 42161, nativeAddress: ARB },
    ];
    const families = assembleFamilies(
      mergeForwardReps(discovered, forward),
      meta([[42161, ARB, { symbol: "ARB", decimals: 18 }]])
    );
    expect(families).toHaveLength(1);
    expect(families[0].reps).toHaveLength(5);
    expect(new Set(families[0].reps.map((r) => r.internalChainId)).size).toBe(5);
    expect(families[0].reps.filter((r) => r.isNativeRoot)).toHaveLength(1);
    expect(multiChainFamilies(families)).toHaveLength(1); // was 0 before the forward pass
  });

  it("dedupes a rep present in BOTH discovery and forward (token-listed AND found via getDebridge)", () => {
    const DEASSET_56 = "0xa2";
    const discovered: RawDeAsset[] = [
      { internalChainId: 42161, address: ARB, nativeChainId: 42161, nativeAddress: ARB },
      { internalChainId: 56, address: DEASSET_56, nativeChainId: 42161, nativeAddress: ARB },
    ];
    const forward: RawDeAsset[] = [
      { internalChainId: 56, address: DEASSET_56, nativeChainId: 42161, nativeAddress: ARB },
    ];
    const [f] = assembleFamilies(mergeForwardReps(discovered, forward), new Map());
    expect(f.reps).toHaveLength(2); // not 3 — assembleFamilies dedupes by (chain,address)
  });

  it("fillMeta supplies decimals/symbol for forward reps without clobbering token-list values", () => {
    const metaByKey = meta([[42161, ARB, { symbol: "ARB", decimals: 18 }]]);
    // forward rep on chain 1 has no token-list entry → on-chain read provides its meta.
    fillMeta(metaByKey, 1, new Map([["0xa1", { symbol: "ARB", decimals: 18 }]]));
    // a differing on-chain read for the already-known root must NOT overwrite the token-list value.
    fillMeta(metaByKey, 42161, new Map([[ARB, { symbol: "WRONG", decimals: 6 }]]));

    const raw: RawDeAsset[] = [
      { internalChainId: 42161, address: ARB, nativeChainId: 42161, nativeAddress: ARB },
      { internalChainId: 1, address: "0xa1", nativeChainId: 42161, nativeAddress: ARB },
    ];
    const [f] = assembleFamilies(raw, metaByKey);
    const root = f.reps.find((r) => r.isNativeRoot)!;
    const rep1 = f.reps.find((r) => r.internalChainId === 1)!;
    expect(root.decimals).toBe(18); // token-list wins
    expect(root.symbol).toBe("ARB");
    expect(rep1.decimals).toBe(18); // filled from on-chain
    expect(rep1.symbol).toBe("ARB");
  });
});

describe("forwardUniverse (feed event-only families into the on-chain forward pass)", () => {
  const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // base58, NOT hex
  const evFam = (nativeChainId: number, nativeAddress: string): Family => ({
    debridgeId: computeDebridgeId(nativeChainId, nativeAddress as `0x${string}`),
    nativeChainId,
    nativeAddress,
    nativeOnHomeChain: false,
    reps: [],
  });

  it("yields one FamilyKey per distinct discovered family (carrying native chain+address)", () => {
    const discovered: RawDeAsset[] = [
      { internalChainId: 56, address: USDT_BSC, nativeChainId: 56, nativeAddress: USDT_BSC },
      { internalChainId: 42161, address: "0xa1", nativeChainId: 56, nativeAddress: USDT_BSC }, // same family
    ];
    const u = forwardUniverse(discovered, []);
    expect(u).toHaveLength(1);
    expect(u[0].nativeChainId).toBe(56);
    expect(u[0].debridgeId).toBe(computeDebridgeId(56, USDT_BSC as `0x${string}`));
  });

  it("ADDS an EVM-native event-only family (no token-list carried it) to the forward universe", () => {
    const discovered: RawDeAsset[] = [
      { internalChainId: 56, address: USDT_BSC, nativeChainId: 56, nativeAddress: USDT_BSC },
    ];
    const eth = evFam(1, USDT_ETH); // Ethereum-native, only known via events
    const u = forwardUniverse(discovered, [eth]);
    expect(u).toHaveLength(2);
    expect(u.some((k) => k.debridgeId === computeDebridgeId(1, USDT_ETH as `0x${string}`))).toBe(true);
  });

  it("dedupes an event family that was also discovered (no duplicate key)", () => {
    const discovered: RawDeAsset[] = [
      { internalChainId: 56, address: USDT_BSC, nativeChainId: 56, nativeAddress: USDT_BSC },
    ];
    const u = forwardUniverse(discovered, [evFam(56, USDT_BSC)]);
    expect(u).toHaveLength(1);
  });

  it("adds MULTIPLE EVM-native event families (the primary production path)", () => {
    const u = forwardUniverse([], [evFam(1, USDT_ETH), evFam(56, USDT_BSC)]);
    expect(u).toHaveLength(2);
    expect(u.some((k) => k.nativeChainId === 1)).toBe(true);
    expect(u.some((k) => k.nativeChainId === 56)).toBe(true);
  });

  it("SKIPS a non-EVM (Solana, base58) native family — its hex-less address can't anchor getDebridge", () => {
    // A Solana-native event family: forward-expanding it via EVM getDebridge would corrupt the native
    // leg's (base58) address, so it must NOT enter the universe. It stays on the event-merge path.
    const discovered: RawDeAsset[] = [
      { internalChainId: 56, address: USDT_BSC, nativeChainId: 56, nativeAddress: USDT_BSC },
    ];
    const sol: Family = {
      debridgeId: "0xdeadbeef",
      nativeChainId: 7565164,
      nativeAddress: SOLANA_USDC, // base58, not hex
      nativeOnHomeChain: false,
      reps: [],
    };
    const u = forwardUniverse(discovered, [sol]);
    expect(u).toHaveLength(1); // Solana family skipped, only the discovered one remains
    expect(u.every((k) => k.nativeChainId !== 7565164)).toBe(true);
  });
});

describe("debridgeId encoding", () => {
  it("is deterministic and order-sensitive on (chainId, address)", () => {
    const a = computeDebridgeId(1, USDT_ETH as `0x${string}`);
    const b = computeDebridgeId(1, USDT_ETH as `0x${string}`);
    expect(a).toBe(b);
    // verified live against deBridgeGate.getDebridgeId(1, WETH)
    const wethId = computeDebridgeId(1, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
    expect(wethId).toBe("0x7a4f5988eb2e00ce51697c543e0163ef96f4ec0dfd6729d29b0a1dd88626f055");
  });
});
