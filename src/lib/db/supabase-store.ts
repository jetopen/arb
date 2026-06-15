import type { Family, Opportunity, OpportunityFilter, ScanUnit } from "../types";
import type { Store, ScanRunRecord, ScanOutcome } from "./store";
import { DEAD_ROUTE_PENALTY_MS, workUnitId } from "./store";
import { getServiceClient } from "./supabase";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function rowToOpp(r: any): Opportunity {
  return {
    id: r.id,
    debridgeId: r.debridge_id,
    kind: r.kind,
    symbol: r.symbol ?? undefined,
    buyChainId: r.buy_chain_id,
    sellChainId: r.sell_chain_id,
    nativeChainId: r.native_chain_id,
    tierUsd: r.tier_usd,
    edge: r.edge,
    verification: r.verification ?? null,
    lockPath: r.lock_path ?? [],
    computedAt: r.computed_at ? new Date(r.computed_at).getTime() : 0,
    timesSeen: r.times_seen ?? undefined,
    timesProfitable: r.times_profitable ?? undefined,
    firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at).getTime() : undefined,
  };
}

export function oppToItem(o: Opportunity) {
  return {
    id: o.id,
    debridge_id: o.debridgeId,
    kind: o.kind,
    symbol: o.symbol ?? null,
    buy_chain_id: o.buyChainId,
    sell_chain_id: o.sellChainId,
    native_chain_id: o.nativeChainId,
    tier_usd: o.tierUsd,
    net_edge_pct: o.edge.netEdgePct,
    net_usd: o.edge.netUsd,
    gross_spread_pct: o.edge.grossSpreadPct,
    edge: o.edge,
    verification: o.verification,
    lock_path: o.lockPath,
    // The authoritative cross-check result — distinct from edge.profitable.
    verified: o.verification?.verified ?? false,
  };
}

export function rowToUnit(r: any): ScanUnit {
  return {
    debridgeId: r.debridge_id,
    buyChainId: r.buy_chain_id,
    sellChainId: r.sell_chain_id,
    tierUsd: r.tier_usd,
    kind: r.kind,
  };
}

/** Postgres-backed store: survives restarts; the leased work_queue lets a route batch and a daemon
 * drain it without double-processing. All writes go through service_role (RLS-bypassing) on the server. */
export class SupabaseStore implements Store {
  private get db() {
    return getServiceClient();
  }

  async upsertOpportunities(opps: Opportunity[]): Promise<void> {
    if (opps.length === 0) return;
    const { error } = await this.db.rpc("arb_upsert_opportunities", { items: opps.map(oppToItem) });
    if (error) throw new Error(`upsertOpportunities: ${error.message}`);
  }

  async topOpportunities(filter: OpportunityFilter): Promise<{ opportunities: Opportunity[]; total: number }> {
    const page = filter.page ?? 1;
    const take = filter.take ?? 50;
    const start = (page - 1) * take;
    let q = this.db.from("arb_opportunities").select("*", { count: "exact" });
    if (filter.minNetPct != null && Number.isFinite(filter.minNetPct)) q = q.gte("net_edge_pct", filter.minNetPct);
    if (filter.tierUsd != null && Number.isFinite(filter.tierUsd)) q = q.eq("tier_usd", filter.tierUsd);
    if (filter.chainId != null && Number.isFinite(filter.chainId)) {
      const cid = Math.trunc(filter.chainId);
      q = q.or(`buy_chain_id.eq.${cid},sell_chain_id.eq.${cid}`);
    }
    if (filter.verifiedOnly) q = q.eq("verified", true);
    if (filter.maxAgeMs != null && Number.isFinite(filter.maxAgeMs)) {
      q = q.gte("computed_at", new Date(Date.now() - filter.maxAgeMs).toISOString());
    }
    q = q.order("net_edge_pct", { ascending: false }).range(start, start + take - 1);
    const { data, count, error } = await q;
    if (error) throw new Error(`topOpportunities: ${error.message}`);
    return { opportunities: (data ?? []).map(rowToOpp), total: count ?? 0 };
  }

  async enqueue(units: ScanUnit[], priorityOf?: (u: ScanUnit) => number): Promise<void> {
    if (units.length === 0) return;
    const items = units.map((u) => ({
      id: `${u.debridgeId}:${u.buyChainId}:${u.sellChainId}:${u.tierUsd}:${u.kind}`,
      debridge_id: u.debridgeId,
      buy_chain_id: u.buyChainId,
      sell_chain_id: u.sellChainId,
      tier_usd: u.tierUsd,
      kind: u.kind,
      priority: priorityOf ? priorityOf(u) : 0,
    }));
    const { error } = await this.db.rpc("arb_enqueue_work", { items });
    if (error) throw new Error(`enqueue: ${error.message}`);
  }

  async dequeue(n: number): Promise<ScanUnit[]> {
    const { data, error } = await this.db.rpc("arb_dequeue_work", { n });
    if (error) throw new Error(`dequeue: ${error.message}`);
    return (data ?? []).map(rowToUnit);
  }

  async markScanned(outcomes: ScanOutcome[]): Promise<void> {
    if (outcomes.length === 0) return;
    const now = Date.now();
    const liveIds = outcomes.filter((o) => o.live).map((o) => workUnitId(o.unit));
    const deadIds = outcomes.filter((o) => !o.live).map((o) => workUnitId(o.unit));

    // A dead route that has ever produced an opportunity is "proven" — a single failure is a transient
    // blip, not a dead pool, so it keeps cycling. Only UNproven-dead routes get time-demoted.
    let provenDead: string[] = [];
    if (deadIds.length > 0) {
      const { data, error } = await this.db.from("arb_opportunities").select("id").in("id", deadIds);
      if (error) throw new Error(`markScanned(proven): ${error.message}`);
      provenDead = (data ?? []).map((r: any) => r.id as string);
    }
    const provenSet = new Set(provenDead);
    const keepIds = [...liveIds, ...provenDead]; // cycle normally (now)
    const demoteIds = deadIds.filter((id) => !provenSet.has(id)); // push into the future

    // Two bulk updates (no RPC/DDL needed). Clearing the lease lets a kept route re-enter immediately.
    if (keepIds.length > 0) {
      const { error } = await this.db
        .from("arb_work_queue")
        .update({ last_scanned_at: new Date(now).toISOString(), leased_until: null })
        .in("id", keepIds);
      if (error) throw new Error(`markScanned(keep): ${error.message}`);
    }
    if (demoteIds.length > 0) {
      const { error } = await this.db
        .from("arb_work_queue")
        .update({ last_scanned_at: new Date(now + DEAD_ROUTE_PENALTY_MS).toISOString(), leased_until: null })
        .in("id", demoteIds);
      if (error) throw new Error(`markScanned(demote): ${error.message}`);
    }
  }

  async requeueFresh(ids: string[]): Promise<void> {
    // Warm-start priority only (fix #1/#2): bump proven routes to the proven-priority marker so the
    // time-ordered dequeue (last_scanned_at, then priority desc) prefers them among equally-stale peers.
    // Deliberately does NOT reset last_scanned_at — nulling it would shove the whole proven set to the
    // front (`nulls first`) and starve never-scanned routes. And does NOT touch leased_until — clearing
    // a lease would release units a concurrent /api/arb/scan is mid-processing → double-processing.
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      const { error } = await this.db
        .from("arb_work_queue")
        .update({ priority: 1 })
        .in("id", slice);
      if (error) throw new Error(`requeueFresh: ${error.message}`);
    }
  }

  async knownUnitIds(): Promise<Set<string>> {
    // Routes that have ever produced a quote (have an opportunity row) — the realized-quotability set
    // used to warm-start priority. Bounded select; the productive set is small relative to the queue.
    // Order by computed_at desc (fix #6): without an explicit order the 5000-row cap truncates an
    // arbitrary slice once the table grows past it (and diverges run-to-run / from MemoryStore).
    // Ordering keeps the freshest rows; the Set de-dupes (ids are PK-unique, but be defensive).
    const { data, error } = await this.db
      .from("arb_opportunities")
      .select("id")
      .order("computed_at", { ascending: false })
      .limit(5000);
    if (error) throw new Error(`knownUnitIds: ${error.message}`);
    return new Set((data ?? []).map((r: any) => r.id as string));
  }

  async queueSize(): Promise<number> {
    const { count, error } = await this.db
      .from("arb_work_queue")
      .select("*", { count: "exact", head: true });
    if (error) throw new Error(`queueSize: ${error.message}`);
    return count ?? 0;
  }

  async recordScanRun(run: ScanRunRecord): Promise<void> {
    const { error } = await this.db.from("arb_scan_runs").insert({
      started_at: new Date(run.startedAt).toISOString(),
      finished_at: new Date(run.finishedAt).toISOString(),
      units_processed: run.unitsProcessed,
      quotes_spent: run.quotesSpent,
      opportunities_found: run.opportunitiesFound,
      partial: run.partial,
    });
    if (error) throw new Error(`recordScanRun: ${error.message}`);
  }

  async lastScanRun(): Promise<ScanRunRecord | null> {
    const { data, error } = await this.db
      .from("arb_scan_runs")
      .select("*")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`lastScanRun: ${error.message}`);
    if (!data) return null;
    return {
      startedAt: new Date(data.started_at).getTime(),
      finishedAt: new Date(data.finished_at).getTime(),
      unitsProcessed: data.units_processed,
      quotesSpent: data.quotes_spent,
      opportunitiesFound: data.opportunities_found,
      partial: data.partial,
    };
  }

  async saveFamilies(families: Family[]): Promise<void> {
    if (families.length === 0) return;
    const rows = families.map((f) => ({
      debridge_id: f.debridgeId,
      native_chain_id: f.nativeChainId,
      native_address: f.nativeAddress,
      symbol: f.symbol ?? null,
      name: f.name ?? null,
      decimals: f.decimals ?? null,
      native_on_home_chain: f.nativeOnHomeChain,
      reps: f.reps,
    }));
    const { error } = await this.db.from("arb_families").upsert(rows, { onConflict: "debridge_id" });
    if (error) throw new Error(`saveFamilies: ${error.message}`);
  }

  async loadFamilies(): Promise<Family[] | null> {
    const { data, error } = await this.db.from("arb_families").select("*");
    if (error) throw new Error(`loadFamilies: ${error.message}`);
    if (!data || data.length === 0) return null;
    return data.map((r: any) => ({
      debridgeId: r.debridge_id,
      nativeChainId: r.native_chain_id,
      nativeAddress: r.native_address,
      symbol: r.symbol ?? undefined,
      name: r.name ?? undefined,
      decimals: r.decimals ?? undefined,
      nativeOnHomeChain: r.native_on_home_chain,
      reps: r.reps ?? [],
    }));
  }
}
