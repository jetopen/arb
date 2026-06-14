import type { Family, Opportunity, OpportunityFilter, ScanUnit } from "../types";
import { SupabaseStore } from "./supabase-store";

export interface ScanRunRecord {
  startedAt: number;
  finishedAt: number;
  unitsProcessed: number;
  quotesSpent: number;
  opportunitiesFound: number;
  partial: boolean;
}

export interface Store {
  upsertOpportunities(opps: Opportunity[]): Promise<void>;
  topOpportunities(filter: OpportunityFilter): Promise<{ opportunities: Opportunity[]; total: number }>;
  enqueue(units: ScanUnit[], priorityOf?: (u: ScanUnit) => number): Promise<void>;
  dequeue(n: number): Promise<ScanUnit[]>;
  queueSize(): Promise<number>;
  recordScanRun(run: ScanRunRecord): Promise<void>;
  lastScanRun(): Promise<ScanRunRecord | null>;
  saveFamilies(families: Family[]): Promise<void>;
  loadFamilies(): Promise<Family[] | null>;
}

function unitKey(u: ScanUnit): string {
  return `${u.debridgeId}:${u.buyChainId}:${u.sellChainId}:${u.tierUsd}:${u.kind}`;
}

/** In-memory store (Phase 1). Swapped for a Supabase-backed store in Phase 2 via getStore(). */
export class MemoryStore implements Store {
  private opps = new Map<string, Opportunity>();
  private queue: ScanUnit[] = [];
  private queued = new Set<string>();
  private lastRun: ScanRunRecord | null = null;
  private families: Family[] | null = null;

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
    if (filter.minNetPct != null) list = list.filter((o) => o.edge.netEdgePct >= filter.minNetPct!);
    if (filter.tierUsd != null) list = list.filter((o) => o.tierUsd === filter.tierUsd);
    if (filter.chainId != null)
      list = list.filter((o) => o.buyChainId === filter.chainId || o.sellChainId === filter.chainId);
    if (filter.verifiedOnly) list = list.filter((o) => o.verification?.verified);
    list.sort((a, b) => b.edge.netEdgePct - a.edge.netEdgePct);
    const total = list.length;
    const page = filter.page ?? 1;
    const take = filter.take ?? 50;
    const start = (page - 1) * take;
    return { opportunities: list.slice(start, start + take), total };
  }

  async enqueue(units: ScanUnit[]): Promise<void> {
    for (const u of units) {
      const k = unitKey(u);
      if (this.queued.has(k)) continue;
      this.queued.add(k);
      this.queue.push(u);
    }
  }

  async saveFamilies(families: Family[]): Promise<void> {
    this.families = families;
  }

  async loadFamilies(): Promise<Family[] | null> {
    return this.families;
  }

  async dequeue(n: number): Promise<ScanUnit[]> {
    const batch = this.queue.splice(0, n);
    for (const u of batch) this.queued.delete(unitKey(u));
    // re-enqueue at the tail so coverage keeps cycling
    this.queue.push(...batch);
    for (const u of batch) this.queued.add(unitKey(u));
    return batch;
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
