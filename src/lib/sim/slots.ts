import {
  concat,
  encodeFunctionData,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { getChainByInternalId } from "../deport/registry";

/**
 * ERC20 storage-slot resolver (Foundry `deal`-style).
 *
 * To simulate a swap from a cold synthetic sender we must override the input token's `balanceOf` and
 * `allowance` storage so `transferFrom` succeeds inside the eth_call. That requires the token's mapping
 * slot indices, which vary by implementation (and proxies). We discover them by PROBING: override a
 * candidate slot with a sentinel value, then read `balanceOf`/`allowance` — if it returns the sentinel,
 * we found the slot (and the hashing order: Solidity `keccak(key.slot)` vs Vyper `keccak(slot.key)`).
 *
 * Cached per (chain, token). A failed probe caches `null` → the caller marks the leg `skipped` (never a
 * false `revert`). A registry `erc20Slots` override short-circuits the probe for known-awkward tokens.
 */

export interface SlotLayout {
  /** mapping slot index. */
  slot: number;
  /** true = Vyper layout keccak(slot . key); false = Solidity keccak(key . slot). */
  vyper: boolean;
}
export interface Erc20Slots {
  balance: SlotLayout;
  allowance: SlotLayout;
}

const BALANCE_OF_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const ALLOWANCE_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// All-lowercase: viem's encodeFunctionData rejects mixed-case addresses that fail the EIP-55 checksum.
const PROBE_OWNER = "0x000000000000000000000000000000000000b0b0" as Address;
const PROBE_SPENDER = "0x000000000000000000000000000000000000c0de" as Address;
const SENTINEL = 0x1234abcdn;
const SENTINEL_HEX = pad(toHex(SENTINEL), { size: 32 });
// Probe common layouts first (0–2 plain ERC20; 9 = USDC FiatToken), then the rest.
const SLOT_CANDIDATES = [0, 1, 2, 9, 3, 4, 5, 6, 7, 8, 10, 11, 12, 51, 101];

const NULL_TTL_MS = 5 * 60 * 1000; // re-probe null entries after 5 min (transient RPC errors expire)

interface CacheEntry {
  value: Erc20Slots | null;
  /** Epoch ms when a null was cached; 0 for successful results (they never expire). */
  nullTs: number;
}
const cache = new Map<string, CacheEntry>();

/** Storage key for `balances[holder]` under a given layout. */
export function balanceSlotKey(holder: Address, layout: SlotLayout): Hex {
  const k = pad(holder, { size: 32 });
  const s = pad(toHex(layout.slot), { size: 32 });
  return keccak256(layout.vyper ? concat([s, k]) : concat([k, s]));
}

/** Storage key for `allowance[owner][spender]` (nested mapping) under a given layout. */
export function allowanceSlotKey(owner: Address, spender: Address, layout: SlotLayout): Hex {
  const inner = balanceSlotKey(owner, layout); // keccak(owner . slot)
  const sp = pad(spender, { size: 32 });
  return keccak256(layout.vyper ? concat([inner, sp]) : concat([sp, inner]));
}

/** Shared slot discovery loop: try each (slot, vyper) candidate; return the first that echoes SENTINEL. */
async function probeSlot(
  client: PublicClient,
  token: Address,
  readData: Hex,
  keyFn: (layout: SlotLayout) => Hex
): Promise<SlotLayout | null> {
  for (const slot of SLOT_CANDIDATES) {
    for (const vyper of [false, true]) {
      const layout = { slot, vyper };
      const key = keyFn(layout);
      try {
        const { data } = await client.call({
          to: token,
          data: readData,
          stateOverride: [{ address: token, stateDiff: [{ slot: key, value: SENTINEL_HEX }] }],
        });
        if (data && BigInt(data) === SENTINEL) return layout;
      } catch {
        /* slot/layout mismatch reverts or returns garbage — try next */
      }
    }
  }
  return null;
}

async function probeBalance(client: PublicClient, token: Address): Promise<SlotLayout | null> {
  const readData = encodeFunctionData({ abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [PROBE_OWNER] });
  return probeSlot(client, token, readData, (layout) => balanceSlotKey(PROBE_OWNER, layout));
}

async function probeAllowance(client: PublicClient, token: Address): Promise<SlotLayout | null> {
  const readData = encodeFunctionData({ abi: ALLOWANCE_ABI, functionName: "allowance", args: [PROBE_OWNER, PROBE_SPENDER] });
  return probeSlot(client, token, readData, (layout) => allowanceSlotKey(PROBE_OWNER, PROBE_SPENDER, layout));
}

/** Resolve (and cache) the balance/allowance storage slots for an ERC20, or null if undiscoverable.
 *  Null results are cached with a 5-minute TTL so a transient RPC error at startup doesn't permanently
 *  silence simulation for that token. */
export async function resolveErc20Slots(
  client: PublicClient,
  internalChainId: number,
  token: Address
): Promise<Erc20Slots | null> {
  const cacheKey = `${internalChainId}:${token.toLowerCase()}`;
  const entry = cache.get(cacheKey);
  if (entry !== undefined) {
    if (entry.value !== null) return entry.value;
    if (Date.now() - entry.nullTs < NULL_TTL_MS) return null; // cached null still fresh
    // stale null — fall through and re-probe
  }

  const override = getChainByInternalId(internalChainId)?.erc20Slots?.[token.toLowerCase()];
  if (override) {
    cache.set(cacheKey, { value: override, nullTs: 0 });
    return override;
  }

  const balance = await probeBalance(client, token);
  const allowance = balance ? await probeAllowance(client, token) : null;
  const result = balance && allowance ? { balance, allowance } : null;
  cache.set(cacheKey, { value: result, nullTs: result === null ? Date.now() : 0 });
  return result;
}

/** Test seam: clear the resolver cache between cases (or force null-TTL expiry by passing a far-future ts). */
export function __clearSlotCache() {
  cache.clear();
}
