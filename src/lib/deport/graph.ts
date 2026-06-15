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
import { deriveFamiliesFromEvents, mergeEventReps, type DerivedEvents } from "./events-graph";

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
 * PURE: the debridgeId universe to forward-expand (getDebridge) over every scanned chain. Built from the
 * token-list-discovered reps PLUS event-derived families, so families no token-list carried still get their
 * on-chain EVM reps resolved — including RECEIVE-ONLY chains, whose deAsset address the submission log never
 * carries (getEvents only records the SOURCE-chain token). Only EVM-native event families can be added: a
 * non-hex (non-EVM, e.g. Solana base58) native address can't seed computeDebridgeId, so it is skipped — those
 * families keep the event-merge path (PASS 5), which preserves their canonical native leg. Deduped by
 * debridgeId (first writer wins; for EVM the discovered and event native addresses are byte-identical
 * lowercase hex, so the ordering is immaterial — the isEvmDeportChain filter, not the dedup order, is what
 * keeps non-EVM native legs out).
 */
export function forwardUniverse(discovered: RawDeAsset[], eventFamilies: Family[]): FamilyKey[] {
  const keys = new Map<string, FamilyKey>();
  const add = (nativeChainId: number, nativeAddress: string) => {
    try {
      const id = computeDebridgeId(nativeChainId, nativeAddress as Hex);
      const k = id.toLowerCase();
      if (!keys.has(k)) keys.set(k, { debridgeId: id, nativeChainId, nativeAddress });
    } catch {
      /* DEFENSE (not the filter): a malformed native address shouldn't reach here, but if one ever does,
         skip that single family rather than aborting the whole graph build — matching the best-effort,
         flag-partial posture of every other pass. The isEvmDeportChain check below is the real guard. */
    }
  };
  // Discovered reps always carry a raw-hex native address (from getNativeInfo) — add them all.
  for (const r of discovered) add(r.nativeChainId, r.nativeAddress);
  // Event families: ONLY EVM-native ones. Their canonical native address IS raw hex (computeDebridgeId can
  // anchor it and the assemble regroup stays correct). A non-EVM native (Solana base58, etc.) would corrupt
  // both anchoring and the native leg, so it is left to the event-merge path (PASS 5), which preserves the
  // canonical native address. NB computeDebridgeId does NOT throw on a base58 string — it silently hashes it
  // wrong — so this MUST be an explicit chain-kind check; the try/catch above is resilience, not a filter.
  for (const f of eventFamilies) {
    if (isEvmDeportChain(f.nativeChainId)) add(f.nativeChainId, f.nativeAddress);
  }
  return [...keys.values()];
}

/**
 * Build the lock-graph live:
 *  1. DISCOVERY   — per-chain token-list -> multicall getNativeInfo -> the family universe (debridgeIds).
 *  -  EVENT SEED  — derive the event-sourced family set; its EVM-native families WIDEN the universe so
 *                   families no token-list carried still get forward-expanded.
 *  2. FORWARD     — for each scanned chain, multicall getDebridge(debridgeId) over that (widened) universe
 *                   to find EVERY deployed rep, including the (majority) that no token-list carries.
 *  3. META FILL   — read decimals()/symbol() on-chain for forward-found reps absent from token-lists.
 *  4. ASSEMBLE    — group the merged reps by debridgeId (pure).
 *  5. EVENT MERGE — overlay event-sourced reps on-chain enumeration can't reach (chiefly non-EVM/Solana).
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

  // ---- EVENT SEED: derive the event-sourced family set up front (best-effort). Used both to WIDEN the
  // forward-pass universe (below) with families no token-list carried, and to merge non-EVM reps after
  // assembly (PASS 5). A failure (e.g. the derive RPC timing out) drops non-EVM/Solana coverage, so flag
  // the build partial — the exact silent-drop migration 0005 was written to avoid. ----
  let derived: DerivedEvents = { repsByDebridgeId: new Map(), families: [] };
  try {
    derived = await deriveFamiliesFromEvents();
  } catch {
    partial = true;
  }

  // The family universe to forward-expand: discovered debridgeIds PLUS EVM-native event-only families
  // (forwardUniverse skips non-EVM natives). getDebridge then resolves their on-chain EVM reps, including
  // the receive-only chains the submission log can't carry a deAsset address for.
  const families = forwardUniverse(discovered, derived.families);

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
        const { meta, ok } = await enumerateErc20Meta(cid, [...addrs]);
        fillMeta(metaByKey, cid, meta);
        // A transport-level metadata failure (fix #7) means some reps' decimals never resolved and
        // get silently dropped from scanning — surface that as partial instead of claiming full coverage.
        if (!ok) partial = true;
      } catch {
        partial = true; // best-effort; reps without resolvable decimals are excluded from scanning
      }
    })
  );

  // ---- PASS 4: assemble on-chain EVM families (pure) ----
  const onChain = assembleFamilies(raw, metaByKey);

  // ---- PASS 5: merge the event-sourced reps onto the assembled on-chain graph. The event set was derived
  // up front (and seeded the forward pass); here it overlays the reps on-chain enumeration can't reach —
  // chiefly non-EVM/Solana reps, plus the native metadata of event-only families. ----
  return {
    families: mergeEventReps(onChain, derived),
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
