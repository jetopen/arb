import type { LockGraph, Opportunity, OpportunityFilter, ScanUnit } from "../types";
import { SupabaseStore } from "./supabase-store";

export interface ScanRunRecord {
  startedAt: number;
  finishedAt: number;
  unitsProcessed: number;
  quotesSpent: number;
  opportunitiesFound: number;
  partial: boolean;
}

/** One point in a scan-unit's spread/net trajectory (for the drawer sparkline). 5c. */
export interface OpportunityHistoryPoint {
  ts: number;
  grossSpreadPct: number;
  netUsd: number;
  tierUsd: number;
}

/** Per-unit result fed back after a batch so the queue can demote routes that can't be quoted. */
export interface ScanOutcome {
  unit: ScanUnit;
  /** true when BOTH legs returned a real (non-zero, non-throwing) quote — i.e. the route has liquidity. */
  live: boolean;
  /** true when a non-live result came from a TRANSIENT upstream error (5xx/429/network) rather than a
   *  permanent no-route. Transient failures on an unproven route get a short backoff, not the 6h penalty. */
  transient?: boolean;
}

/**
 * How far into the future a dead route's `lastScannedAt` is pushed so the time-ordered dequeue stops
 * re-scanning it. A no-liquidity wrapped-deAsset retries roughly every penalty window (liquidity can
 * appear later), instead of burning a quote every cycle. Override via env for tuning.
 *
 * Parsed defensively (fix #5): a non-numeric override (e.g. "6h") would otherwise be NaN, which throws
 * a RangeError in `new Date(now + NaN).toISOString()` (500s every scan) and corrupts MemoryStore
 * ordering. Fall back to the 6h default unless the env is a finite, non-negative number.
 */
const DEFAULT_DEAD_ROUTE_PENALTY_MS = 6 * 60 * 60 * 1000;

/** Defensively parse a penalty-ms env override; falls back to `fallback` unless `raw` is finite & >= 0. */
export function parsePenaltyMs(raw: string | undefined, fallback = DEFAULT_DEAD_ROUTE_PENALTY_MS): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const DEAD_ROUTE_PENALTY_MS = parsePenaltyMs(process.env.ARB_DEAD_ROUTE_PENALTY_MS);

/** Backoff for a TRANSIENT quote failure (5xx/429/network/timeout) on a not-yet-proven route. Short on
 * purpose: a flaky chain's genuinely-live routes (Flow/Sei estimation is intermittently 5xx) recover
 * within minutes instead of being hidden for the full 6h dead penalty. Default 10m; ARB_TRANSIENT_RETRY_MS. */
export const TRANSIENT_RETRY_MS = parsePenaltyMs(process.env.ARB_TRANSIENT_RETRY_MS, 10 * 60 * 1000);

/** Default read-freshness window for the Opportunities list — DECOUPLED from the dead-route penalty. The
 * continuous scan loop keeps the proven (hot-lane) set refreshed every ~28 min, so a 3h window holds the last
 * several cycles while dropping day-old phantoms — a stale quote (an edge that has since decayed) must NOT keep
 * ranking #1 by spread. Deliberately SMALLER than the 6h dead-route penalty: the two are independent (this
 * gates what the UI shows; the penalty gates re-scan scheduling). Override live via ARB_OPP_MAX_AGE_MS (e.g.
 * loosen if the list looks too sparse); maxAgeMs<=0 (at the route) disables the gate entirely. /api/health
 * flips to 503 against this same window so a stalled scanner is caught, not silently blanked. */
export const DEFAULT_OPP_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/** Fraction of each dequeue batch reserved for the proven/realized-quotability set (priority>=1) so the
 * handful of live routes refresh fast instead of competing time-fairly with the ~1000 dead ones. 0..1. */
export function parseHotRatio(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.5;
}
export const HOT_RATIO = parseHotRatio(process.env.ARB_SCAN_HOT_RATIO);

/** Min time before a HOT unit (a token's proven best row) is eligible for the hot lane again. seedQueue now
 * warms only ~1 row per token, so without a floor the tiny hot set would re-scan every couple minutes and
 * waste the budget that shrink frees; with it, unfilled hot slots spill to the cold-discovery sweep. 4b. */
export const HOT_MIN_INTERVAL_MS = parsePenaltyMs(process.env.ARB_HOT_MIN_INTERVAL_MS, 10 * 60 * 1000);

/** A "proven" route (one that has produced an opportunity) stops counting as proven once its newest
 * opportunity is older than this — so a route that quoted once long ago and has failed every scan since is
 * demoted like any dead route instead of holding a hot slot forever. Override via ARB_PROVEN_MAX_AGE_MS. 4c. */
export const PROVEN_MAX_AGE_MS = parsePenaltyMs(process.env.ARB_PROVEN_MAX_AGE_MS, 24 * 60 * 60 * 1000);

/** Ceiling for the exponential dead-route backoff (6h·2^fail_count). Keeps a persistently-dead rep from being
 * pushed absurdly far out while still cutting re-scan spend on the long tail. 4d. */
export const MAX_DEAD_PENALTY_MS = 72 * 60 * 60 * 1000;

export interface Store {
  upsertOpportunities(opps: Opportunity[]): Promise<void>;
  topOpportunities(filter: OpportunityFilter): Promise<{ opportunities: Opportunity[]; total: number }>;
  enqueue(units: ScanUnit[], priorityOf?: (u: ScanUnit) => number): Promise<void>;
  dequeue(n: number): Promise<ScanUnit[]>;
  /** Record per-unit scan outcomes: live (and proven) routes cycle normally, unproven-dead get demoted. */
  markScanned(outcomes: ScanOutcome[]): Promise<void>;
  /**
   * Warm-start priority for these units (proven-productive routes) so they're preferred among
   * equally-stale peers in the time-ordered dequeue. Does NOT reset lastScannedAt (that would let the
   * whole proven set jump the queue and starve never-scanned routes) and does NOT touch leases (that
   * would release units a concurrent scan is mid-processing → double-processing). Priority bump only.
   */
  requeueFresh(ids: string[]): Promise<void>;
  /** Ids of routes that have ever produced a quote (an opportunity row) — the realized-quotability set. */
  knownUnitIds(): Promise<Set<string>>;
  /** Remove ALL queued units for these families (the majors-denylist cleanup). Opportunities are kept. */
  deleteUnitsByDebridgeIds(debridgeIds: string[]): Promise<void>;
  queueSize(): Promise<number>;
  recordScanRun(run: ScanRunRecord): Promise<void>;
  lastScanRun(): Promise<ScanRunRecord | null>;
  /** Persist the assembled lock-graph as a snapshot (families + builtAt/chainsScanned/partial). */
  saveGraph(graph: LockGraph): Promise<void>;
  /** Load the last persisted snapshot, or null when none has been written. */
  loadGraph(): Promise<LockGraph | null>;
  /** Record alert ids and return ONLY the ones not previously recorded — dedup so each opportunity
   *  pings once, not every scan tick it stays profitable. */
  filterNewAlerts(ids: string[]): Promise<string[]>;
  /** Recent spread/net history for one scan-unit id, newest first (for the drawer sparkline). 5c. */
  opportunityHistory(unitId: string, limit: number): Promise<OpportunityHistoryPoint[]>;
}

/** Stable scan-unit / opportunity / queue-row id (same format across all three). */
export function workUnitId(u: ScanUnit): string {
  return `${u.debridgeId}:${u.buyChainId}:${u.sellChainId}:${u.tierUsd}:${u.kind}`;
}

const unitKey = workUnitId;

/** In-memory store (Phase 1). Swapped for a Supabase-backed store in Phase 2 via getStore(). */
export class MemoryStore implements Store {
  private opps = new Map<string, Opportunity>();
  private history = new Map<string, OpportunityHistoryPoint[]>();
  private queue: { unit: ScanUnit; priority: number; lastScannedAt: number | null; failCount: number }[] = [];
  private queued = new Set<string>();
  private lastRun: ScanRunRecord | null = null;
  private graph: LockGraph | null = null;
  private alerted = new Set<string>();

  async upsertOpportunities(opps: Opportunity[]): Promise<void> {
    for (const o of opps) {
      const prev = this.opps.get(o.id);
      this.opps.set(o.id, {
        ...o,
        timesSeen: (prev?.timesSeen ?? 0) + 1,
        timesProfitable: (prev?.timesProfitable ?? 0) + (o.edge.profitable ? 1 : 0),
        firstSeenAt: prev?.firstSeenAt ?? o.computedAt,
      });
      // Append a history point (bounded ring) — mirrors the SQL history append in arb_upsert_opportunities. 5c.
      const hist = this.history.get(o.id) ?? [];
      hist.push({ ts: o.computedAt, grossSpreadPct: o.edge.grossSpreadPct, netUsd: o.edge.netUsd, tierUsd: o.tierUsd });
      if (hist.length > 500) hist.shift();
      this.history.set(o.id, hist);
    }
  }

  async opportunityHistory(unitId: string, limit: number): Promise<OpportunityHistoryPoint[]> {
    const hist = this.history.get(unitId) ?? [];
    return hist.slice(-limit).reverse(); // newest first
  }

  async topOpportunities(filter: OpportunityFilter): Promise<{ opportunities: Opportunity[]; total: number }> {
    let list = [...this.opps.values()];
    if (filter.minSpreadPct != null) list = list.filter((o) => o.edge.grossSpreadPct >= filter.minSpreadPct!);
    if (filter.tierUsd != null) list = list.filter((o) => o.tierUsd === filter.tierUsd);
    if (filter.chainId != null)
      list = list.filter((o) => o.buyChainId === filter.chainId || o.sellChainId === filter.chainId);
    if (filter.verifiedOnly) list = list.filter((o) => o.verification?.verified);
    if (filter.executableOnly) list = list.filter((o) => o.simulation?.executable === true);
    if (filter.maxAgeMs != null) {
      const cutoff = Date.now() - filter.maxAgeMs;
      list = list.filter((o) => o.computedAt >= cutoff);
    }
    // Spread screener: rank by the raw round-trip gross spread (the price gap), highest first; break
    // ties by id (code-unit order, mirroring the RPC's `order by …, id`) so the order — and the
    // per-token winner kept below — is deterministic.
    const byGross = (a: Opportunity, b: Opportunity) =>
      b.edge.grossSpreadPct - a.edge.grossSpreadPct || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    list.sort(byGross);
    // One row per token (family): keep the highest-spread row per debridgeId — FRESH-FIRST when
    // freshBandMs is set (0017 parity): a row inside the band beats ANY older row of the same token, so
    // a stale-but-flattering quote can't shadow the token's current data on the all-time dashboard view.
    // Among ALL-STALE rows the pick is MOST-RECENT-first (then gross): a dead token's honest
    // representative is its last-known state, not its best-ever gross (re-rank, not exclusion).
    if (filter.groupByToken) {
      const freshCutoff =
        filter.freshBandMs != null && Number.isFinite(filter.freshBandMs) && filter.freshBandMs > 0
          ? Date.now() - filter.freshBandMs
          : null;
      if (freshCutoff != null) {
        const isFresh = (o: Opportunity) => (o.computedAt >= freshCutoff ? 1 : 0);
        list.sort(
          (a, b) =>
            isFresh(b) - isFresh(a) ||
            (isFresh(a) === 0 ? b.computedAt - a.computedAt : 0) || // both stale → most recent first
            byGross(a, b)
        );
      }
      const seen = new Set<string>();
      list = list.filter((o) => {
        if (seen.has(o.debridgeId)) return false;
        seen.add(o.debridgeId);
        return true;
      });
      // Outward page order stays gross desc (parity with the RPC's unchanged `page` CTE).
      if (freshCutoff != null) list.sort(byGross);
    }
    const total = list.length;
    const page = filter.page ?? 1;
    const take = filter.take ?? 50;
    const start = (page - 1) * take;
    return { opportunities: list.slice(start, start + take), total };
  }

  async enqueue(units: ScanUnit[], priorityOf?: (u: ScanUnit) => number): Promise<void> {
    for (const u of units) {
      const k = unitKey(u);
      const priority = priorityOf ? priorityOf(u) : 0;
      if (this.queued.has(k)) {
        // parity with arb_enqueue_work's ON CONFLICT DO UPDATE priority
        const item = this.queue.find((i) => unitKey(i.unit) === k);
        if (item) item.priority = priority;
        continue;
      }
      this.queued.add(k);
      this.queue.push({ unit: u, priority, lastScannedAt: null, failCount: 0 });
    }
  }

  async saveGraph(graph: LockGraph): Promise<void> {
    this.graph = graph;
  }

  async loadGraph(): Promise<LockGraph | null> {
    return this.graph;
  }

  async filterNewAlerts(ids: string[]): Promise<string[]> {
    const fresh: string[] = [];
    for (const id of ids) {
      if (!this.alerted.has(id)) {
        this.alerted.add(id);
        fresh.push(id);
      }
    }
    return fresh;
  }

  async dequeue(n: number): Promise<ScanUnit[]> {
    // Mirror arb_dequeue_batch: least-recently-scanned first (fair cycling), priority breaks ties, with a
    // reserved HOT lane for the proven set so live routes refresh fast instead of competing time-fairly
    // with the ~1000 dead routes.
    const now = Date.now();
    const cmp = (
      a: { priority: number; lastScannedAt: number | null },
      b: { priority: number; lastScannedAt: number | null }
    ) => {
      const at = a.lastScannedAt ?? -Infinity;
      const bt = b.lastScannedAt ?? -Infinity;
      return at !== bt ? at - bt : b.priority - a.priority;
    };
    // Freshness gate (fix #3): a route demoted into the future (lastScannedAt = now + penalty) is NOT
    // eligible until that time passes — otherwise a small queue re-dequeues it immediately and the
    // dead-route penalty never holds. Only null (never scanned) or past timestamps are eligible.
    const eligible = this.queue.filter((i) => i.lastScannedAt === null || i.lastScannedAt <= now);
    const want = Math.max(0, n);
    // Hot lane first (proven, priority>=1), then cold fills the rest from the REMAINING eligible. One
    // snapshot + a `taken` set ⇒ a row can never be taken by both lanes in a single dequeue.
    const hotN = Math.ceil(want * HOT_RATIO);
    // Hot lane = proven best rows (priority>=1) that are at least HOT_MIN_INTERVAL_MS stale, so the tiny hot
    // set doesn't busy-spin; unfilled hot slots fall through to the cold fill below (4b).
    const hot = eligible
      .filter((i) => i.priority >= 1 && (i.lastScannedAt === null || i.lastScannedAt <= now - HOT_MIN_INTERVAL_MS))
      .sort(cmp)
      .slice(0, hotN);
    const taken = new Set(hot);
    const cold = eligible.filter((i) => !taken.has(i)).sort(cmp).slice(0, want - hot.length);
    const batch = [...hot, ...cold];
    for (const item of batch) item.lastScannedAt = now;
    return batch.map((i) => i.unit);
  }

  async markScanned(outcomes: ScanOutcome[]): Promise<void> {
    const now = Date.now();
    for (const { unit, live, transient } of outcomes) {
      const k = unitKey(unit);
      const item = this.queue.find((i) => unitKey(i.unit) === k);
      if (!item) continue;
      // Proven = has produced an opportunity WITHIN PROVEN_MAX_AGE_MS. A single failure on such a route is a
      // blip, not a dead pool, so it keeps cycling. But a route that quoted once long ago and has failed
      // since is NOT kept — it demotes like any dead route (4c). Among the non-kept: a TRANSIENT upstream
      // error (5xx/429/network) gets a short backoff; a permanent no-route gets the exponential dead-route
      // backoff (6h·2^fail_count, capped), so the persistent-dead long tail is re-checked ever more rarely (4d).
      const opp = this.opps.get(k);
      const keep = live || (opp != null && (opp.computedAt ?? 0) > now - PROVEN_MAX_AGE_MS);
      if (keep) {
        item.lastScannedAt = now;
        item.failCount = 0; // recovery resets the dead-route backoff
      } else if (transient) {
        item.lastScannedAt = now + TRANSIENT_RETRY_MS;
      } else {
        item.lastScannedAt = now + Math.min(DEAD_ROUTE_PENALTY_MS * 2 ** item.failCount, MAX_DEAD_PENALTY_MS);
        item.failCount++;
      }
    }
  }

  async requeueFresh(ids: string[]): Promise<void> {
    // Warm-start priority only (fix #1/#2): bump proven routes to the proven-priority marker so they
    // win the dequeue tie-break against equally-stale peers. Deliberately does NOT reset lastScannedAt
    // (would let the whole proven set jump ahead of never-scanned routes) nor touch leases.
    const set = new Set(ids);
    for (const item of this.queue) {
      if (set.has(unitKey(item.unit))) item.priority = Math.max(item.priority, 1);
    }
  }

  async knownUnitIds(): Promise<Set<string>> {
    return new Set(this.opps.keys());
  }

  async deleteUnitsByDebridgeIds(debridgeIds: string[]): Promise<void> {
    if (debridgeIds.length === 0) return;
    const denied = new Set(debridgeIds);
    this.queue = this.queue.filter((i) => !denied.has(i.unit.debridgeId));
    for (const k of this.queued) {
      // unit ids are `${debridgeId}:…` and debridgeId is 0x-hex (no colon), so the prefix is unambiguous.
      if (denied.has(k.slice(0, k.indexOf(":")))) this.queued.delete(k);
    }
  }

  async queueSize(): Promise<number> {
    return this.queue.length;
  }

  async recordScanRun(run: ScanRunRecord): Promise<void> {
    this.lastRun = run;
  }

  async lastScanRun(): Promise<ScanRunRecord | null> {
    return this.lastRun;
  }
}

let store: Store | null = null;

/** Returns a SupabaseStore when SUPABASE_* env is present, else a process-wide MemoryStore. */
export function getStore(): Store {
  if (store) return store;
  // SupabaseStore's module has no import-time side effects (the client is created lazily), so a
  // static import is safe; it only connects when SUPABASE_* env is present.
  store =
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? new SupabaseStore()
      : new MemoryStore();
  return store;
}

export function __setStore(s: Store | null) {
  store = s;
}
