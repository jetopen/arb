import type { Hex } from "viem";
import type { DeAsset, Family } from "../types";
import { computeDebridgeId } from "../onchain/debridge-gate";
import { isEvmDeportChain } from "./registry";
import { toCanonicalAddress } from "./address-codec";
import { getServiceClient, supabaseConfigured } from "../db/supabase";

/** One (chain, address) representation as aggregated by the arb_derive_families RPC. */
interface RawRep {
  chainId: number;
  address: string; // raw hex, lowercased
  symbol?: string | null;
  name?: string | null;
  decimals?: number | null;
}
interface RawFamily {
  debridge_id: string;
  reps: RawRep[];
}

/** A raw rep turned into a canonical-address DeAsset (display form; native-root flag set by caller). */
function toDeAsset(r: RawRep, isNativeRoot: boolean): DeAsset {
  return {
    internalChainId: r.chainId,
    address: toCanonicalAddress(r.chainId, r.address),
    symbol: r.symbol ?? undefined,
    name: r.name ?? undefined,
    decimals: r.decimals ?? undefined,
    isNativeRoot,
  };
}

/**
 * PURE: turn one debridgeId + its raw (chain, hex-address) reps into a Family — IF the native root is
 * present in the reps. The native root is the rep whose `computeDebridgeId(chainId, rawHex)` equals the
 * debridgeId (the same canonical identity the on-chain path uses, computed here without any RPC). Returns
 * null when no rep anchors the debridgeId (e.g. a partial backfill that lacks the family's home-chain leg) —
 * such families can't be constructed standalone, but their reps are still exposed via `repsByDebridgeId`
 * to augment an already-known on-chain family.
 */
export function assembleEventFamily(debridgeId: string, raws: RawRep[]): Family | null {
  const id = debridgeId.toLowerCase();
  let nativeChainId: number | undefined;
  let nativeAddressHex: string | undefined;
  for (const r of raws) {
    try {
      if (computeDebridgeId(r.chainId, r.address as Hex).toLowerCase() === id) {
        nativeChainId = r.chainId;
        nativeAddressHex = r.address.toLowerCase();
        break;
      }
    } catch {
      /* malformed address bytes — skip this rep as a root candidate */
    }
  }
  if (nativeChainId === undefined || nativeAddressHex === undefined) return null;

  const rootRaw = raws.find((r) => r.chainId === nativeChainId && r.address.toLowerCase() === nativeAddressHex);
  return {
    debridgeId,
    nativeChainId,
    // Canonical address (base58 for Solana, hex for EVM) — memberAddress() returns this for the native
    // leg, and the quote dispatch needs the chain-native form (Jupiter wants a base58 mint, not hex).
    nativeAddress: toCanonicalAddress(nativeChainId, nativeAddressHex),
    symbol: rootRaw?.symbol ?? raws[0]?.symbol ?? undefined,
    name: rootRaw?.name ?? raws[0]?.name ?? undefined,
    decimals: rootRaw?.decimals ?? raws[0]?.decimals ?? undefined,
    nativeOnHomeChain: isEvmDeportChain(nativeChainId),
    reps: raws.map((r) => toDeAsset(r, r.chainId === nativeChainId && r.address.toLowerCase() === nativeAddressHex)),
  };
}

export interface DerivedEvents {
  /** Canonical reps per debridgeId (lowercased) — used to augment already-known on-chain families. */
  repsByDebridgeId: Map<string, DeAsset[]>;
  /** Families anchorable from events alone (native root present) — used to add event-only families. */
  families: Family[];
}

/** Read the persisted event index and derive the chain-complete rep set. Empty without Supabase. */
export async function deriveFamiliesFromEvents(): Promise<DerivedEvents> {
  const empty: DerivedEvents = { repsByDebridgeId: new Map(), families: [] };
  if (!supabaseConfigured()) return empty;
  const { data, error } = await getServiceClient().rpc("arb_derive_families");
  if (error) throw new Error(`deriveFamiliesFromEvents: ${error.message}`);
  const raw = (data ?? []) as RawFamily[];

  const repsByDebridgeId = new Map<string, DeAsset[]>();
  const families: Family[] = [];
  for (const f of raw) {
    const reps = (f.reps || []).map((r) => ({ ...r, address: String(r.address).toLowerCase() }));
    const fam = assembleEventFamily(f.debridge_id, reps);
    if (fam) {
      families.push(fam);
      repsByDebridgeId.set(f.debridge_id.toLowerCase(), fam.reps);
    } else {
      repsByDebridgeId.set(f.debridge_id.toLowerCase(), reps.map((r) => toDeAsset(r, false)));
    }
  }
  return { repsByDebridgeId, families };
}

/**
 * PURE: merge the event-derived (chain-complete) reps into the on-chain EVM graph. On-chain EVM reps stay
 * authoritative (the scanner relies on them); event reps the on-chain graph lacks — chiefly every non-EVM
 * representation, plus reps/families the EVM token-list crawler missed — are added.
 */
export function mergeEventReps(onChain: Family[], derived: DerivedEvents): Family[] {
  const byId = new Map<string, Family>(
    onChain.map((f) => [f.debridgeId.toLowerCase(), { ...f, reps: [...f.reps] }])
  );
  const evFamById = new Map(derived.families.map((f) => [f.debridgeId.toLowerCase(), f]));
  // Augment known families with any event reps they lack (e.g. a Solana leg of an EVM-native family).
  for (const [id, fam] of byId) {
    // Restore native-token metadata when on-chain assembly couldn't resolve the native root. This happens
    // for an event-only family that was forward-expanded (PASS 2) only on its deAsset chains because its
    // HOME chain's discovery scan failed — assembleFamilies then took symbol/name/decimals from a deAsset
    // rep (e.g. "deUSDT") instead of the native token. The event family carries the real native metadata.
    // Checked BEFORE the rep augment below adds the native-root rep, so the "no native root" test is valid.
    const ev = evFamById.get(id);
    if (ev && !fam.reps.some((r) => r.isNativeRoot)) {
      fam.symbol = ev.symbol ?? fam.symbol;
      fam.name = ev.name ?? fam.name;
      fam.decimals = ev.decimals ?? fam.decimals;
    }
    const evReps = derived.repsByDebridgeId.get(id);
    if (!evReps) continue;
    const have = new Set(fam.reps.map((r) => `${r.internalChainId}:${r.address.toLowerCase()}`));
    for (const r of evReps) {
      const rk = `${r.internalChainId}:${r.address.toLowerCase()}`;
      if (!have.has(rk)) {
        fam.reps.push(r);
        have.add(rk);
      }
    }
  }
  // Add event-only families (Solana-native, or EVM families no token-list carried) that anchor cleanly.
  for (const ef of derived.families) {
    if (!byId.has(ef.debridgeId.toLowerCase())) byId.set(ef.debridgeId.toLowerCase(), ef);
  }
  return [...byId.values()];
}
