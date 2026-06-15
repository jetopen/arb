import type { Hex } from "viem";
import type { DeAsset, Family, LockGraph } from "../types";
import {
  computeDebridgeId,
  enumerateNativeInfo,
  enumerateDebridgeReps,
  enumerateErc20Meta,
  type RawDeAsset,
  type FamilyKey,
} from "../onchain/debridge-gate";
import { isEvmDeportChain, EVM_DEPORT_CHAINS } from "./registry";
import { getTokenListForChain } from "../api-client";

export interface TokenMeta {
  symbol?: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
}

function metaKey(internalChainId: number, address: string): string {
  return `${internalChainId}:${address.toLowerCase()}`;
}

/**
 * PURE: group raw getNativeInfo results into dePort families keyed by debridgeId (lock origin).
 *
 * The same nominal token locked from two different native chains has two different debridgeIds and
 * therefore lands in two different families — this is the invariant the whole product depends on.
 */
export function assembleFamilies(
  raw: RawDeAsset[],
  metaByKey: Map<string, TokenMeta>
): Family[] {
  const groups = new Map<string, RawDeAsset[]>();
  for (const r of raw) {
    const id = computeDebridgeId(r.nativeChainId, r.nativeAddress as Hex);
    const list = groups.get(id);
    if (list) list.push(r);
    else groups.set(id, [r]);
  }

  const families: Family[] = [];
  for (const [debridgeId, members] of groups) {
    const { nativeChainId, nativeAddress } = members[0];
    // Dedupe reps by (chain,address) — a token can legitimately appear once per chain.
    const seen = new Set<string>();
    const reps: DeAsset[] = [];
    for (const m of members) {
      const k = metaKey(m.internalChainId, m.address);
      if (seen.has(k)) continue;
      seen.add(k);
      const meta = metaByKey.get(k);
      reps.push({
        internalChainId: m.internalChainId,
        address: m.address,
        symbol: meta?.symbol,
        name: meta?.name,
        decimals: meta?.decimals,
        logoURI: meta?.logoURI,
        isNativeRoot: m.internalChainId === m.nativeChainId,
      });
    }
    const root = reps.find((r) => r.isNativeRoot);
    families.push({
      debridgeId,
      nativeChainId,
      nativeAddress,
      symbol: root?.symbol ?? reps[0].symbol,
      name: root?.name ?? reps[0].name,
      decimals: root?.decimals ?? reps[0].decimals,
      nativeOnHomeChain: isEvmDeportChain(nativeChainId),
      reps,
    });
  }
  return families;
}

/** Families that can actually produce a cross-chain comparison (reps on ≥2 distinct chains). */
export function multiChainFamilies(families: Family[]): Family[] {
  return families.filter((f) => new Set(f.reps.map((r) => r.internalChainId)).size >= 2);
}

interface ChainScan {
  internalChainId: number;
  raw: RawDeAsset[];
  meta: Array<[string, TokenMeta]>;
  ok: boolean;
}

async function scanChain(internalChainId: number): Promise<ChainScan> {
  try {
    const tokenList = await getTokenListForChain(internalChainId);
    const meta: Array<[string, TokenMeta]> = [];
    const addresses: string[] = [];
    // Probe getNativeInfo on EVERY listed token (native + non-native). getNativeInfo returns a
    // self-origin for a registered native root and zero for non-dePort tokens (which enumerateNativeInfo
    // drops), so this discovers families whose only listed member is the native root — not just deAssets.
    for (const entry of tokenList.values()) {
      meta.push([metaKey(internalChainId, entry.address), entry]);
      addresses.push(entry.address);
    }
    const raw = await enumerateNativeInfo(internalChainId, addresses);
    return { internalChainId, raw, meta, ok: true };
  } catch {
    return { internalChainId, raw: [], meta: [], ok: false };
  }
}

/** PURE: combine discovery reps (token-list) with forward-found reps (getDebridge). */
export function mergeForwardReps(discovered: RawDeAsset[], forward: RawDeAsset[]): RawDeAsset[] {
  return [...discovered, ...forward];
}

/**
 * PURE: fold on-chain ERC20 metadata into the metaByKey namespace, without clobbering values the
 * token-list already supplied (a token-list symbol/decimals is authoritative over an on-chain read).
 */
export function fillMeta(
  metaByKey: Map<string, TokenMeta>,
  internalChainId: number,
  fetched: Map<string, { symbol?: string; decimals?: number }>
): void {
  for (const [addr, meta] of fetched) {
    const k = metaKey(internalChainId, addr);
    const existing = metaByKey.get(k) ?? {};
    metaByKey.set(k, {
      ...existing,
      symbol: existing.symbol ?? meta.symbol,
      decimals: existing.decimals ?? meta.decimals,
    });
  }
}

/**
 * Build the lock-graph live in four passes:
 *  1. DISCOVERY  — per-chain token-list -> multicall getNativeInfo -> the family universe (debridgeIds).
 *  2. FORWARD    — for each discovered chain, multicall getDebridge(debridgeId) over that universe to
 *                  find EVERY deployed rep, including the (majority) that no token-list carries.
 *  3. META FILL  — read decimals()/symbol() on-chain for forward-found reps absent from token-lists.
 *  4. ASSEMBLE   — group the merged reps by debridgeId (pure).
 * Chains are scanned concurrently per pass, so wall-time ≈ the slowest single chain, not the sum.
 */
export async function buildLockGraph(
  internalChainIds: number[] = EVM_DEPORT_CHAINS.map((c) => c.internalId)
): Promise<LockGraph> {
  // ---- PASS 1: discovery ----
  const scans = await Promise.all(internalChainIds.map(scanChain));

  const discovered: RawDeAsset[] = [];
  const metaByKey = new Map<string, TokenMeta>();
  const chainsScanned: number[] = [];
  let partial = false;

  for (const s of scans) {
    if (!s.ok) {
      partial = true;
      continue;
    }
    for (const [k, v] of s.meta) metaByKey.set(k, v);
    discovered.push(...s.raw);
    chainsScanned.push(s.internalChainId);
  }

  // The family universe: one FamilyKey per distinct debridgeId (lock origin).
  const familyKeys = new Map<string, FamilyKey>();
  for (const r of discovered) {
    const id = computeDebridgeId(r.nativeChainId, r.nativeAddress as Hex);
    if (!familyKeys.has(id)) {
      familyKeys.set(id, { debridgeId: id, nativeChainId: r.nativeChainId, nativeAddress: r.nativeAddress });
    }
  }
  const families = [...familyKeys.values()];

  // ---- PASS 2: forward expansion (only over chains discovery succeeded on) ----
  const forwardByChain = await Promise.all(
    chainsScanned.map((cid) => enumerateDebridgeReps(cid, families))
  );
  const forward: RawDeAsset[] = [];
  for (const f of forwardByChain) {
    if (!f.ok) partial = true;
    forward.push(...f.reps);
  }
  const raw = mergeForwardReps(discovered, forward);

  // ---- PASS 3: metadata fill for reps with no (or decimals-less) token-list entry ----
  const missingByChain = new Map<number, Set<string>>();
  for (const r of raw) {
    const m = metaByKey.get(metaKey(r.internalChainId, r.address));
    if (!m || m.decimals === undefined) {
      let set = missingByChain.get(r.internalChainId);
      if (!set) {
        set = new Set();
        missingByChain.set(r.internalChainId, set);
      }
      set.add(r.address);
    }
  }
  await Promise.all(
    [...missingByChain].map(async ([cid, addrs]) => {
      try {
        fillMeta(metaByKey, cid, await enumerateErc20Meta(cid, [...addrs]));
      } catch {
        partial = true; // best-effort; reps without resolvable decimals are excluded from scanning
      }
    })
  );

  // ---- PASS 4: assemble (pure) ----
  return {
    families: assembleFamilies(raw, metaByKey),
    builtAt: Date.now(),
    chainsScanned,
    partial,
  };
}

const GRAPH_TTL = 6 * 60 * 60 * 1000; // 6h — deAsset sets change slowly
let cached: LockGraph | null = null;

export async function getLockGraph(force = false): Promise<LockGraph> {
  if (!force && cached && Date.now() - cached.builtAt < GRAPH_TTL) return cached;
  cached = await buildLockGraph();
  return cached;
}

/** Test seam. */
export function __setLockGraph(graph: LockGraph | null) {
  cached = graph;
}
