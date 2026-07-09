import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionResult, type Hex } from "viem";
import { GATE_ABI, type FamilyKey } from "../onchain/debridge-gate";

// Partial-mock the transport: keep the real address codecs, stub the network batch.
vi.mock("../onchain/tron-client", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, tronEthCallBatch: vi.fn() };
});

import { tronEthCallBatch, tronBase58FromEvmHex, evmHexFromTronBase58 } from "../onchain/tron-client";
import { enumerateTronReps } from "../onchain/tron-reps";

const TRON = 100000026;
const mocked = vi.mocked(tronEthCallBatch);

/** Encode a getDebridge tuple the way the Tron gate would return it. */
function gd(chainId: number, tokenAddr: Hex, exist: boolean): Hex {
  return encodeFunctionResult({
    abi: GATE_ABI,
    functionName: "getDebridge",
    result: [BigInt(chainId), 0n, 0n, 0n, tokenAddr, 0, exist],
  }) as Hex;
}

const WTRX_HEX = "0x891cdb91d149f23b1a45d9c5ca78a88d0cb44c18" as Hex; // Tron WTRX body
const WTRX_B58 = "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";

describe("Tron address codecs", () => {
  it("round-trips a Tron base58 address through the bare 20-byte EVM form", () => {
    expect(evmHexFromTronBase58(WTRX_B58)).toBe(WTRX_HEX);
    expect(tronBase58FromEvmHex(WTRX_HEX)).toBe(WTRX_B58);
  });
  it("rejects a non-mainnet / corrupted base58", () => {
    expect(evmHexFromTronBase58("notbase58!!")).toBeNull();
  });
});

describe("enumerateTronReps", () => {
  beforeEach(() => mocked.mockReset());

  const families: FamilyKey[] = [
    { debridgeId: "0xd1c5783a4542a32fe4ed6c953b25b700446d1e36cbdadee0e1302d35da3bdfa5", nativeChainId: TRON, nativeAddress: WTRX_B58 }, // Tron-native, exists
    { debridgeId: "0x00000000000000000000000000000000000000000000000000000000000000aa", nativeChainId: 1, nativeAddress: "0xeth" }, // exist=false → dropped
    { debridgeId: "0x00000000000000000000000000000000000000000000000000000000000000bb", nativeChainId: 1, nativeAddress: "0xeth2" }, // origin mismatch → dropped
  ];

  it("emits a canonical-base58 rep only on exist + matching native chainId; carries debridgeId", async () => {
    mocked.mockResolvedValueOnce([
      gd(TRON, WTRX_HEX, true), // matches family[0]
      gd(1, "0x1111111111111111111111111111111111111111", false), // not exist
      gd(999, "0x2222222222222222222222222222222222222222", true), // chainId != fam.nativeChainId (1)
    ]);
    const { reps, ok } = await enumerateTronReps(families);
    expect(ok).toBe(true);
    expect(reps).toHaveLength(1);
    expect(reps[0]).toEqual({
      internalChainId: TRON,
      address: WTRX_B58, // canonical base58, never lowercased
      nativeChainId: TRON,
      nativeAddress: WTRX_B58,
      debridgeId: families[0].debridgeId,
    });
  });

  it("flips ok=false (partial) when a batch transport fails, without throwing", async () => {
    mocked.mockRejectedValueOnce(new Error("trongrid 429"));
    const { reps, ok } = await enumerateTronReps(families);
    expect(ok).toBe(false);
    expect(reps).toHaveLength(0);
  });

  it("returns empty for an empty universe", async () => {
    const { reps } = await enumerateTronReps([]);
    expect(reps).toHaveLength(0);
    expect(mocked).not.toHaveBeenCalled();
  });
});
