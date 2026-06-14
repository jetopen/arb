import type { Hex } from "viem";
import type { DeAsset, Family, LockGraph } from "../types";
import { computeDebridgeId, enumerateNativeInfo, type RawDeAsset } from "../onchain/debridge-gate";
import { isEvmDeportChain, EVM_DEPORT_CHAINS } from "./registry";
import { getTokenListForChain, type TokenListEntry } from "../api-client";

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
    const nonNative: TokenListEntry[] = [];
    for (const entry of tokenList.values()) {
      meta.push([metaKey(internalChainId, entry.address), entry]);
      if (!entry.isNative) nonNative.push(entry);
    }
    const raw = await enumerateNativeInfo(internalChainId, nonNative.map((t) => t.address));
    return { internalChainId, raw, meta, ok: true };
  } catch {
    return { internalChainId, raw: [], meta: [], ok: false };
  }
}

/**
 * Build the lock-graph live: token-list -> multicall getNativeInfo -> assemble families.
 * Chains are scanned concurrently so wall-time ≈ the slowest single chain, not the sum.
 */
export async function buildLockGraph(
  internalChainIds: number[] = EVM_DEPORT_CHAINS.map((c) => c.internalId)
): Promise<LockGraph> {
  const scans = await Promise.all(internalChainIds.map(scanChain));

  const raw: RawDeAsset[] = [];
  const metaByKey = new Map<string, TokenMeta>();
  const chainsScanned: number[] = [];
  let partial = false;

  for (const s of scans) {
    if (!s.ok) {
      partial = true;
      continue;
    }
    for (const [k, v] of s.meta) metaByKey.set(k, v);
    raw.push(...s.raw);
    chainsScanned.push(s.internalChainId);
  }

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
