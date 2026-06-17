import { encodeFunctionData, decodeFunctionResult, type Address, type Hex } from "viem";
import { GATE_ABI, type RawDeAsset, type FamilyKey } from "./debridge-gate";
import { TRON_INTERNAL_ID } from "../deport/registry";
import { TRON_GATE_BASE58, evmHexFromTronBase58, tronBase58FromEvmHex, tronEthCallBatch } from "./tron-client";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Tron JSON-RPC has no Multicall3; batch eth_calls in modest chunks to stay under TronGrid limits. */
const CHUNK = 40;

/**
 * FORWARD enumeration on Tron, mirroring `enumerateDebridgeReps` (EVM). For each known debridgeId, call
 * the Tron gate's `getDebridge(debridgeId)` via TronGrid `eth_call` and emit a rep when the family has a
 * representation there (`exist`, non-zero address, native chain id matches the family). This finds Tron
 * reps the EVM-only forward pass and the (case-lossy) event index can't — including receive-only ones.
 *
 * Best-effort: a transport failure on a chunk drops that chunk and flips `ok` false (→ graph `partial`),
 * never throws. Addresses are returned canonical (base58check `T…`).
 */
export async function enumerateTronReps(families: FamilyKey[]): Promise<{ reps: RawDeAsset[]; ok: boolean }> {
  const gateHex = evmHexFromTronBase58(TRON_GATE_BASE58);
  if (!gateHex || families.length === 0) return { reps: [], ok: !!gateHex };

  const reps: RawDeAsset[] = [];
  let ok = true;

  for (let i = 0; i < families.length; i += CHUNK) {
    const slice = families.slice(i, i + CHUNK);
    const calldata = slice.map((f) =>
      encodeFunctionData({ abi: GATE_ABI, functionName: "getDebridge", args: [f.debridgeId] })
    );
    let results: (string | null)[];
    try {
      results = await tronEthCallBatch(gateHex, calldata);
    } catch {
      ok = false; // transport failure for this chunk → partial coverage
      continue;
    }
    results.forEach((data, j) => {
      if (!data || data === "0x") return;
      let decoded: readonly [bigint, bigint, bigint, bigint, Address, number, boolean];
      try {
        decoded = decodeFunctionResult({ abi: GATE_ABI, functionName: "getDebridge", data: data as Hex }) as typeof decoded;
      } catch {
        return;
      }
      const [chainId, , , , tokenAddress, , exist] = decoded;
      if (!exist) return;
      const fam = slice[j];
      if (Number(chainId) !== fam.nativeChainId) return; // not this family's record
      const lower = (tokenAddress ?? "").toLowerCase();
      if (!lower || lower === ZERO_ADDRESS) return;
      reps.push({
        internalChainId: TRON_INTERNAL_ID,
        address: tronBase58FromEvmHex(lower), // canonical base58check (case-sensitive — never lowercase)
        nativeChainId: fam.nativeChainId,
        nativeAddress: fam.nativeAddress.startsWith("0x") ? fam.nativeAddress.toLowerCase() : fam.nativeAddress,
        debridgeId: fam.debridgeId,
      });
    });
  }
  return { reps, ok };
}
