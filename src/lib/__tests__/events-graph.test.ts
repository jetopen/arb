import { describe, it, expect } from "vitest";
import { toCanonicalAddress } from "../deport/address-codec";
import { assembleEventFamily, mergeEventReps, type DerivedEvents } from "../deport/events-graph";
import type { Family } from "../types";

const SOL = 7565164;
// Real, verified KAKA Solana-native fixture from the deBridge dePort submission log.
const KAKA_ID = "0xcd22ac83267a5b01ff38bab855b9ce854d1f589a200cf6c2f271490904689997";
const KAKA_HEX = "0xd42364ddee8c97e5cb59459dd5c61c20cf16a9aab19b2b36156c6a0d3c491445";
const KAKA_B58 = "FH6jc68WzeAUXKp6uDg9QPciTeU75o32xFDzKLzmbonk";

describe("toCanonicalAddress", () => {
  it("passes EVM addresses through as lowercase hex", () => {
    expect(toCanonicalAddress(1, "0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48")).toBe(
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    );
  });
  it("encodes a Solana 32-byte hex address to base58", () => {
    expect(toCanonicalAddress(SOL, KAKA_HEX)).toBe(KAKA_B58);
  });
});

describe("assembleEventFamily", () => {
  it("anchors a Solana-native family via computeDebridgeId and exposes a base58 rep", () => {
    const fam = assembleEventFamily(KAKA_ID, [{ chainId: SOL, address: KAKA_HEX, symbol: "KAKA", decimals: 6 }]);
    expect(fam).not.toBeNull();
    expect(fam!.nativeChainId).toBe(SOL);
    expect(fam!.nativeOnHomeChain).toBe(false); // Solana is not an EVM scan chain
    const root = fam!.reps.find((r) => r.isNativeRoot)!;
    expect(root.internalChainId).toBe(SOL);
    expect(root.address).toBe(KAKA_B58);
  });
  it("returns null when no rep anchors the debridgeId (partial data)", () => {
    expect(assembleEventFamily(KAKA_ID, [{ chainId: SOL, address: "0x" + "11".repeat(32) }])).toBeNull();
  });
});

function fam(debridgeId: string, reps: Family["reps"]): Family {
  return { debridgeId, nativeChainId: 56, nativeAddress: "0xnative", nativeOnHomeChain: true, reps };
}

describe("mergeEventReps", () => {
  it("augments a known on-chain family with a non-EVM rep it lacks", () => {
    const onChain = [fam("0xT", [{ internalChainId: 56, address: "0xbnb", isNativeRoot: true }])];
    const derived: DerivedEvents = {
      repsByDebridgeId: new Map([["0xt", [{ internalChainId: SOL, address: KAKA_B58, isNativeRoot: false }]]]),
      families: [],
    };
    expect(mergeEventReps(onChain, derived)[0].reps.map((r) => r.internalChainId)).toEqual([56, SOL]);
  });
  it("does not duplicate a rep already present (case-insensitive)", () => {
    const onChain = [fam("0xT", [{ internalChainId: 56, address: "0xbnb", isNativeRoot: true }])];
    const derived: DerivedEvents = {
      repsByDebridgeId: new Map([["0xt", [{ internalChainId: 56, address: "0xBNB", isNativeRoot: false }]]]),
      families: [],
    };
    expect(mergeEventReps(onChain, derived)[0].reps).toHaveLength(1);
  });
  it("adds event-only families absent from the on-chain graph", () => {
    const derived: DerivedEvents = {
      repsByDebridgeId: new Map(),
      families: [fam("0xNEW", [{ internalChainId: SOL, address: KAKA_B58, isNativeRoot: true }])],
    };
    const merged = mergeEventReps([], derived);
    expect(merged).toHaveLength(1);
    expect(merged[0].debridgeId).toBe("0xNEW");
  });
});
