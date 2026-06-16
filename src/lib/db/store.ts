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

/** Per-unit result fed back after a batch so the queue can demote routes that can't be quoted. */
export interface ScanOutcome {
  unit: ScanUnit;
  /** true when BOTH legs returned a real (non-zero, non-throwing) quote — i.e. the route has liquidity. */
  live: boolean;
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

/** Default read-freshness window for the Opportunities list — DECOUPLED from the dead-route penalty. The
 * work queue can take well over 6h to cycle when scanning is sparse, so a 6h read gate hid most still-valid
 * tokens (only those scanned in the last 6h showed). 24h surfaces the full live set; override via
 * ARB_OPP_MAX_AGE_MS, and maxAgeMs<=0 (at the route) disables the gate entirely. */
export const DEFAULT_OPP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Fraction of each dequeue batch reserved for the proven/realized-quotability set (priority>=1) so the
 * handful of live routes refresh fast instead of competing time-fairly with the ~1000 dead ones. 0..1. */
export function parseHotRatio(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.5;
}
export const HOT_RATIO = parseHotRatio(process.env.ARB_SCAN_HOT_RATIO);

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
}

/** Stable scan-unit / opportunity / queue-row id (same format across all three). */
export function workUnitId(u: ScanUnit): string {
  return `${u.debridgeId}:${u.buyChainId}:${u.sellChainId}:${u.tierUsd}:${u.kind}`;
}

const unitKey = workUnitId;

/** In-memory store (Phase 1). Swapped for a Supabase-backed store in Phase 2 via getStore(). */
export class MemoryStore implements Store {
  private opps = new Map<string, Opportunity>();
  private queue: { unit: ScanUnit; priority: number; lastScannedAt: number | null }[] = [];
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
    }
  }

  async topOpportunities(filter: OpportunityFilter): Promise<{ opportunities: Opportunity[]; total: number }> {
    let list = [...this.opps.values()];
    if (filter.minSpreadPct != null) list = list.filter((o) => o.edge.grossSpreadPct >= filter.minSpreadPct!);
    if (filter.chainId != null)
      list = list.filter((o) => o.buyChainId === filter.chainId || o.sellChainId === filter.chainId);
    if (filter.verifiedOnly) list = list.filter((o) => o.verification?.verified);
    if (filter.maxAgeMs != null) {
      const cutoff = Date.now() - filter.maxAgeMs;
      list = list.filter((o) => o.computedAt >= cutoff);
    }
    // Spread screener: rank by the raw round-trip gross spread (the price gap), highest first; break
    // ties by id (code-unit order, mirroring the RPC's `order by …, id`) so the order — and the
    // per-token winner kept below — is deterministic.
    list.sort((a, b) => b.edge.grossSpreadPct - a.edge.grossSpreadPct || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // One row per token (family): keep the highest-spread row per debridgeId. The list is already
    // sorted by spread desc, so the first occurrence of each debridgeId is its best.
    if (filter.groupByToken) {
      const seen = new Set<string>();
      list = list.filter((o) => {
        if (seen.has(o.debridgeId)) return false;
        seen.add(o.debridgeId);
        return true;
      });
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
      this.queue.push({ unit: u, priority, lastScannedAt: null });
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
    const hot = eligible.filter((i) => i.priority >= 1).sort(cmp).slice(0, hotN);
    const taken = new Set(hot);
    const cold = eligible.filter((i) => !taken.has(i)).sort(cmp).slice(0, want - hot.length);
    const batch = [...hot, ...cold];
    for (const item of batch) item.lastScannedAt = now;
    return batch.map((i) => i.unit);
  }

  async markScanned(outcomes: ScanOutcome[]): Promise<void> {
    const now = Date.now();
    for (const { unit, live } of outcomes) {
      const k = unitKey(unit);
      const item = this.queue.find((i) => unitKey(i.unit) === k);
      if (!item) continue;
      // A proven route (one that has ever produced a quote) is never demoted on a single failure —
      // that's a transient API blip, not a dead pool. Only unproven-dead routes get time-demoted so
      // dequeue (time-ordered) stops re-scanning the no-liquidity wrapped reps every cycle.
      const keep = live || this.opps.has(k);
      item.lastScannedAt = keep ? now : now + DEAD_ROUTE_PENALTY_MS;
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
