import { keccak256, encodePacked, type Hex, type Address, type PublicClient } from "viem";
import { getPublicClient } from "./client";
import { deBridgeGate } from "../deport/registry";

/**
 * Minimal deBridgeGate (DMP) ABI — only the reads we need.
 *  - getNativeInfo: reverse-lookup a deAsset -> its lock origin (zero for non-deBridge tokens).
 *  - getDebridge: FORWARD-lookup a debridgeId -> whether the family has a representation on THIS chain
 *    and its address there (`tokenAddress`), regardless of token-listing. This is the public getter for
 *    `mapping(bytes32 => DebridgeInfo)`; the struct flattens to a 7-field tuple. It is the only way to
 *    enumerate deAssets that the per-chain token-list omits (the bulk of them).
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
    name: "getDebridge",
    stateMutability: "view",
    inputs: [{ name: "debridgeId", type: "bytes32" }],
    outputs: [
      { name: "chainId", type: "uint256" }, // native (origin) internal id — same value on every chain
      { name: "maxAmount", type: "uint256" },
      { name: "balance", type: "uint256" },
      { name: "lockedInStrategies", type: "uint256" },
      { name: "tokenAddress", type: "address" }, // this family's address ON THE QUERIED CHAIN
      { name: "minReservesBps", type: "uint16" },
      { name: "exist", type: "bool" },
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

/** deBridgeGate.send ABI fragment — initiates a dePort transfer (burns/locks the input token). Exported
 *  so the sim subsystem can reuse the definition rather than duplicate it. */
export const GATE_SEND_ABI = [
  {
    type: "function",
    name: "send",
    stateMutability: "payable",
    inputs: [
      { name: "_tokenAddress", type: "address" },
      { name: "_amount", type: "uint256" },
      { name: "_chainIdTo", type: "uint256" },
      { name: "_receiver", type: "bytes" },
      { name: "_permitEnvelope", type: "bytes" },
      { name: "_useAssetFee", type: "bool" },
      { name: "_referralCode", type: "uint32" },
      { name: "_autoParams", type: "bytes" },
    ],
    outputs: [{ name: "submissionId", type: "bytes32" }],
  },
] as const;

/** ERC20 metadata — read on-chain for forward-found reps that no token-list covers. */
export const ERC20_META_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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
  /** lock-origin token address — `0x`-hex lowercased for EVM/Solana; base58 verbatim for Tron. */
  nativeAddress: string;
  /** Authoritative debridgeId for forward-found reps (from the FamilyKey). Absent on discovered reps,
   *  which carry a raw-hex nativeAddress that `computeDebridgeId` can re-derive correctly. Lets the
   *  assembler group non-EVM-native families (Solana/Tron) without re-hashing a base58 native address. */
  debridgeId?: string;
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

/** A discovered dePort family's identity — the input universe for forward enumeration. */
export interface FamilyKey {
  debridgeId: Hex;
  /** lock-origin internal chain id (from discovery) */
  nativeChainId: number;
  /** lock-origin token address, lowercased (from discovery; getDebridge does not return it) */
  nativeAddress: string;
}

/** getDebridge returns a 7-field struct ≈224 B/result; wide multicalls overflow public-RPC response limits. */
const REP_CHUNK = 120;
const REP_CHUNK_FLOOR = 15;

type McResult = { status: "success"; result: unknown } | { status: "failure"; error?: unknown };

/**
 * Multicall `contracts` with a halving fallback ladder. On a TRANSPORT-level failure (the whole
 * eth_call throws — typically a response too large for a public RPC) the slice is split in half and
 * each half retried, down to REP_CHUNK_FLOOR. Per-call reverts are NOT failures (allowFailure:true
 * tolerates a chain simply lacking a rep). Returns exactly one result per CONTRACT, in order, plus an
 * `ok` flag that is false only when even a floor-sized chunk could not be fetched (→ graph goes partial).
 * Laddering over contracts (not over logical items) keeps the result count exact when an item maps to
 * several contracts (e.g. ERC20 decimals+symbol).
 */
async function multicallLadder<C>(
  client: PublicClient,
  contracts: readonly C[]
): Promise<{ results: McResult[]; ok: boolean }> {
  const run = (sub: readonly C[]) =>
    client.multicall({
      contracts: sub as never,
      allowFailure: true,
    }) as unknown as Promise<McResult[]>;

  const attempt = async (slice: readonly C[]): Promise<{ results: McResult[]; ok: boolean }> => {
    try {
      return { results: await run(slice), ok: true };
    } catch {
      if (slice.length <= REP_CHUNK_FLOOR) {
        return { results: slice.map(() => ({ status: "failure" as const })), ok: false };
      }
      const mid = Math.ceil(slice.length / 2);
      const a = await attempt(slice.slice(0, mid));
      const b = await attempt(slice.slice(mid));
      return { results: [...a.results, ...b.results], ok: a.ok && b.ok };
    }
  };
  return attempt(contracts);
}

/** Pre-chunk to REP_CHUNK, ladder each chunk, return all results in order + a combined ok flag. */
async function chunkedMulticall<C>(
  client: PublicClient,
  contracts: C[]
): Promise<{ results: McResult[]; ok: boolean }> {
  const results: McResult[] = [];
  let ok = true;
  for (let i = 0; i < contracts.length; i += REP_CHUNK) {
    const r = await multicallLadder(client, contracts.slice(i, i + REP_CHUNK));
    if (!r.ok) ok = false;
    results.push(...r.results);
  }
  return { results, ok };
}

/**
 * FORWARD enumeration: for each known debridgeId, ask `internalChainId` whether the family has a
 * representation there (`exist`) and its address (`tokenAddress`) — independent of any token-list.
 * Emits a RawDeAsset for every (chain, family) where exist==true AND the struct's native chainId
 * matches the family's discovered nativeChainId (cross-check guard), carrying nativeAddress through.
 */
export async function enumerateDebridgeReps(
  internalChainId: number,
  families: FamilyKey[]
): Promise<{ reps: RawDeAsset[]; ok: boolean }> {
  const client = getPublicClient(internalChainId);
  const gate = deBridgeGate(internalChainId) as Address;
  const contracts = families.map((f) => ({
    address: gate,
    abi: GATE_ABI,
    functionName: "getDebridge" as const,
    args: [f.debridgeId],
  }));
  const { results, ok } = await chunkedMulticall(client, contracts);

  const reps: RawDeAsset[] = [];
  results.forEach((r, j) => {
    if (r.status !== "success") return;
    const [chainId, , , , tokenAddress, , exist] = r.result as readonly [
      bigint, bigint, bigint, bigint, Address, number, boolean
    ];
    if (!exist) return;
    const fam = families[j];
    if (Number(chainId) !== fam.nativeChainId) return; // not this family's record
    const addr = (tokenAddress ?? "").toLowerCase();
    if (!addr || addr === ZERO_ADDRESS) return;
    reps.push({
      internalChainId,
      address: addr,
      nativeChainId: fam.nativeChainId,
      // Preserve a base58 (Tron/Solana) native address; only 0x-hex is safe to lowercase.
      nativeAddress: fam.nativeAddress.startsWith("0x") ? fam.nativeAddress.toLowerCase() : fam.nativeAddress,
      debridgeId: fam.debridgeId,
    });
  });
  return { reps, ok };
}

/**
 * On-chain ERC20 metadata for addresses no token-list covers (forward-found reps). Address-keyed
 * (lowercased); a token whose decimals()/symbol() reverts yields the field as undefined rather than
 * throwing. decimals is what matters — the scanner needs it to confirm a family's 1:1 raw move is safe.
 *
 * Returns `{ meta, ok }` (fix #7): `ok` is false when even a floor-sized chunk could not be fetched
 * (a TRANSPORT failure, not a per-token revert). Surfacing it lets the graph mark itself `partial`
 * instead of silently dropping reps whose decimals never resolved while claiming full coverage.
 */
export async function enumerateErc20Meta(
  internalChainId: number,
  addresses: string[]
): Promise<{ meta: Map<string, { symbol?: string; decimals?: number }>; ok: boolean }> {
  const client = getPublicClient(internalChainId);
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))];
  // 2 contracts per address (decimals, symbol); laddering over contracts keeps the count exact.
  const contracts = uniq.flatMap((addr) => [
    { address: addr as Address, abi: ERC20_META_ABI, functionName: "decimals" as const },
    { address: addr as Address, abi: ERC20_META_ABI, functionName: "symbol" as const },
  ]);
  const { results, ok } = await chunkedMulticall(client, contracts);

  const meta = new Map<string, { symbol?: string; decimals?: number }>();
  uniq.forEach((addr, k) => {
    const dec = results[k * 2];
    const sym = results[k * 2 + 1];
    meta.set(addr, {
      decimals: dec?.status === "success" ? Number(dec.result) : undefined,
      symbol: sym?.status === "success" ? String(sym.result) : undefined,
    });
  });
  return { meta, ok };
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

/** Live gate reserve/limit state for a family on a given chain — the readable inputs to the claim
 *  precheck (a dePort claim can't be eth_call'd cold). Throws on RPC failure (caller treats as skipped). */
export interface DebridgeInfo {
  /** native (origin) internal chain id — same value on every chain. */
  nativeChainId: number;
  /** per-tx transfer cap in the asset's units (0 = no cap). */
  maxAmount: bigint;
  /** locked balance backing the asset on THIS chain (meaningful on the native/home chain). */
  balance: bigint;
  /** portion of `balance` lent out to strategies (not idle / not claimable right now). */
  lockedInStrategies: bigint;
  /** this family's token address ON THE QUERIED CHAIN. */
  tokenAddress: string;
  minReservesBps: number;
  /** whether the family is registered on the queried chain. */
  exist: boolean;
}

export async function readDebridgeInfo(internalChainId: number, debridgeId: Hex): Promise<DebridgeInfo> {
  const client = getPublicClient(internalChainId);
  const gate = deBridgeGate(internalChainId) as Address;
  const [nativeChainId, maxAmount, balance, lockedInStrategies, tokenAddress, minReservesBps, exist] =
    await client.readContract({ address: gate, abi: GATE_ABI, functionName: "getDebridge", args: [debridgeId] });
  return {
    nativeChainId: Number(nativeChainId),
    maxAmount,
    balance,
    lockedInStrategies,
    tokenAddress,
    minReservesBps: Number(minReservesBps),
    exist,
  };
}
