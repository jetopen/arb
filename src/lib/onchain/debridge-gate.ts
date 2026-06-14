import { keccak256, encodePacked, type Hex, type Address } from "viem";
import { getPublicClient } from "./client";
import { deBridgeGate } from "../deport/registry";

/**
 * Minimal deBridgeGate (DMP) ABI — only the reads we need.
 *  - getNativeInfo: reverse-lookup a deAsset -> its lock origin (zero for non-deBridge tokens).
 *  - getDebridgeChainAssetFixedFee: live flat redemption fee, in native wei.
 */
export const GATE_ABI = [
  {
    type: "function",
    name: "getNativeInfo",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "nativeChainId", type: "uint256" },
      { name: "nativeAddress", type: "bytes" },
    ],
  },
  {
    type: "function",
    name: "getDebridgeChainAssetFixedFee",
    stateMutability: "view",
    inputs: [
      { name: "_debridgeId", type: "bytes32" },
      { name: "_chainId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * debridgeId = keccak256(abi.encodePacked(uint256 nativeChainId, bytes nativeAddress)).
 * This is the canonical lock-origin identity. The same nominal token locked from two different
 * native chains yields two different debridgeIds — which is exactly why families must key on this,
 * never on symbol. (Encoding verified live against deBridgeGate.getDebridgeId.)
 */
export function computeDebridgeId(nativeChainId: bigint | number, nativeAddress: Hex): Hex {
  return keccak256(encodePacked(["uint256", "bytes"], [BigInt(nativeChainId), nativeAddress]));
}

export interface RawDeAsset {
  /** internal chain id where this deAsset representation lives */
  internalChainId: number;
  /** the deAsset contract address (lowercased) */
  address: string;
  /** lock-origin internal chain id (from getNativeInfo) */
  nativeChainId: number;
  /** lock-origin token address (lowercased) */
  nativeAddress: string;
}

const CHUNK = 400;

/**
 * Run getNativeInfo over a chain's token addresses via Multicall3 (chunked), keeping only genuine
 * dePort deAssets (non-zero origin). viem's multicall auto-uses Multicall3 + JSON-RPC batching.
 */
export async function enumerateNativeInfo(
  internalChainId: number,
  tokenAddresses: string[]
): Promise<RawDeAsset[]> {
  const client = getPublicClient(internalChainId);
  const gate = deBridgeGate(internalChainId) as Address;
  const out: RawDeAsset[] = [];

  for (let i = 0; i < tokenAddresses.length; i += CHUNK) {
    const slice = tokenAddresses.slice(i, i + CHUNK);
    const contracts = slice.map((addr) => ({
      address: gate,
      abi: GATE_ABI,
      functionName: "getNativeInfo" as const,
      args: [addr as Address],
    }));
    const results = await client.multicall({ contracts, allowFailure: true });
    results.forEach((r, j) => {
      if (r.status !== "success") return;
      const [nativeChainId, nativeAddress] = r.result as readonly [bigint, Hex];
      if (nativeChainId === 0n || !nativeAddress || nativeAddress === "0x") return;
      out.push({
        internalChainId,
        address: slice[j].toLowerCase(),
        nativeChainId: Number(nativeChainId),
        nativeAddress: nativeAddress.toLowerCase(),
      });
    });
  }
  return out;
}

/** Live flat redemption fee (native wei) for an asset on a chain; throws on RPC failure (caller falls back). */
export async function getFixedFeeWei(internalChainId: number, debridgeId: Hex): Promise<bigint> {
  const client = getPublicClient(internalChainId);
  const gate = deBridgeGate(internalChainId) as Address;
  return client.readContract({
    address: gate,
    abi: GATE_ABI,
    functionName: "getDebridgeChainAssetFixedFee",
    args: [debridgeId, BigInt(internalChainId)],
  });
}
