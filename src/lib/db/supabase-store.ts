import type { Family, LockGraph, Opportunity, OpportunityFilter, ScanUnit } from "../types";
import type { Store, ScanRunRecord, ScanOutcome, OpportunityHistoryPoint } from "./store";
import { TRANSIENT_RETRY_MS, HOT_RATIO, HOT_MIN_INTERVAL_MS, PROVEN_MAX_AGE_MS, workUnitId } from "./store";
import { getServiceClient } from "./supabase";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** True when an RPC error means the function isn't in the DB yet (migration 0003 not applied). Used to
 *  fall back to JS-side grouping so the page keeps working until the migration runs. */
function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

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
    ...(r.simulation ? { simulation: r.simulation } : {}),
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
    simulation: o.simulation ?? null,
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

/** Family -> arb_families row (snake_case; reps stays jsonb). Undefined optionals become null. */
export function famToRow(f: Family) {
  return {
    debridge_id: f.debridgeId,
    native_chain_id: f.nativeChainId,
    native_address: f.nativeAddress,
    symbol: f.symbol ?? null,
    name: f.name ?? null,
    decimals: f.decimals ?? null,
    native_on_home_chain: f.nativeOnHomeChain,
    reps: f.reps,
  };
}

/** arb_families row (as emitted by arb_load_graph) -> Family. Null optionals become undefined. */
export function rowToFamily(r: any): Family {
  return {
    debridgeId: r.debridge_id,
    nativeChainId: r.native_chain_id,
    nativeAddress: r.native_address,
    symbol: r.symbol ?? undefined,
    name: r.name ?? undefined,
    decimals: r.decimals ?? undefined,
    nativeOnHomeChain: r.native_on_home_chain,
    reps: r.reps ?? [],
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

    const computedAfter =
      filter.maxAgeMs != null && Number.isFinite(filter.maxAgeMs)
        ? new Date(Date.now() - filter.maxAgeMs).toISOString()
        : null;
    const minSpread = filter.minSpreadPct != null && Number.isFinite(filter.minSpreadPct) ? filter.minSpreadPct : null;
    const chainId = filter.chainId != null && Number.isFinite(filter.chainId) ? Math.trunc(filter.chainId) : null;
    const tierUsd = filter.tierUsd != null && Number.isFinite(filter.tierUsd) ? Math.trunc(filter.tierUsd) : null;

    // Shared predicate builder for the ungrouped path and the grouped fallback (identical filters).
    const applyFilters = (q: any) => {
      if (minSpread != null) q = q.gte("gross_spread_pct", minSpread);
      if (chainId != null) q = q.or(`buy_chain_id.eq.${chainId},sell_chain_id.eq.${chainId}`);
      if (tierUsd != null) q = q.eq("tier_usd", tierUsd);
      if (filter.verifiedOnly) q = q.eq("verified", true);
      if (filter.executableOnly) q = q.eq("simulation->>executable", "true");
      if (computedAfter != null) q = q.gte("computed_at", computedAfter);
      return q;
    };

    // Spread screener, one row per token: collapse server-side via the distinct-on RPC (migration 0003)
    // so we fetch only the page we return and get an exact distinct-token total.
    if (filter.groupByToken) {
      // Only send p_executable_only when the filter is ON, so a default query still matches the pre-0011
      // RPC signature (graceful degradation until migration 0011 is applied; if it's on without the
      // migration, the param-mismatch trips the isMissingFunction JS fallback below, which also filters).
      const rpcArgs: Record<string, unknown> = {
        p_min_spread_pct: minSpread,
        p_chain_id: chainId,
        p_tier_usd: tierUsd,
        p_verified_only: !!filter.verifiedOnly,
        p_computed_after: computedAfter,
        p_limit: take,
        p_offset: start,
      };
      if (filter.executableOnly) rpcArgs.p_executable_only = true;
      const { data, error } = await this.db.rpc("arb_top_opportunities_by_token", rpcArgs);
      if (!error) {
        // The RPC returns a single jsonb object { total, rows } so the exact distinct-token total
        // survives even an out-of-range (empty) page.
        const payload = (data ?? {}) as { total?: number | string; rows?: unknown[] };
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        return { opportunities: rows.map((r) => rowToOpp(r)), total: Number(payload.total ?? 0) };
      }
      // Fallback when 0003 (the RPC) isn't applied yet: collapse in JS so the page keeps working. Bounded
      // by max-rows and less efficient — the RPC is the real fix once the migration runs.
      if (!isMissingFunction(error)) throw new Error(`topOpportunities: ${error.message}`);
      const { data: fbData, error: fbErr } = await applyFilters(this.db.from("arb_opportunities").select("*"))
        .order("gross_spread_pct", { ascending: false })
        .order("id", { ascending: true })
        .limit(1000);
      if (fbErr) throw new Error(`topOpportunities: ${fbErr.message}`);
      const seen = new Set<string>();
      const grouped = (fbData ?? []).filter((r: any) => {
        if (seen.has(r.debridge_id)) return false;
        seen.add(r.debridge_id);
        return true;
      });
      return { opportunities: grouped.slice(start, start + take).map(rowToOpp), total: grouped.length };
    }

    // Ungrouped (tests / future callers): exact count + DB pagination, id tiebreaker for determinism.
    const q = applyFilters(this.db.from("arb_opportunities").select("*", { count: "exact" }))
      .order("gross_spread_pct", { ascending: false })
      .order("id", { ascending: true })
      .range(start, start + take - 1);
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
    // Hot-lane split: reserve ceil(n*HOT_RATIO) slots for the proven set (priority>=1) so live routes
    // refresh fast. The RPC leases the hot rows in its first statement, so the cold fill (second statement)
    // can't re-grab them — one round-trip, no double-lease.
    const n_hot = Math.ceil(Math.max(0, n) * HOT_RATIO);
    // hot_min_interval_ms makes the ARB_HOT_MIN_INTERVAL_MS knob authoritative on the SQL path too
    // (migration 0015; before that the RPC hard-coded 10 min and the env only affected MemoryStore).
    const { data, error } = await this.db.rpc("arb_dequeue_batch", { n, n_hot, hot_min_interval_ms: HOT_MIN_INTERVAL_MS });
    if (error) throw new Error(`dequeue: ${error.message}`);
    return (data ?? []).map(rowToUnit);
  }

  async markScanned(outcomes: ScanOutcome[]): Promise<void> {
    if (outcomes.length === 0) return;
    const now = Date.now();
    const liveIds = outcomes.filter((o) => o.live).map((o) => workUnitId(o.unit));
    const failed = outcomes.filter((o) => !o.live);
    const failedIds = failed.map((o) => workUnitId(o.unit));

    // A failed route that produced an opportunity WITHIN PROVEN_MAX_AGE_MS is "proven" — a single failure is
    // a blip, not a dead pool, so it keeps cycling. The freshness bound (4c) stops a route that quoted once
    // long ago and has failed since from holding a hot slot forever. Among the non-kept: a TRANSIENT upstream
    // error (5xx/429/network) gets a short backoff; a permanent no-route gets exponential dead-route backoff.
    let provenSet = new Set<string>();
    if (failedIds.length > 0) {
      const { data, error } = await this.db
        .from("arb_opportunities")
        .select("id")
        .in("id", failedIds)
        .gte("computed_at", new Date(now - PROVEN_MAX_AGE_MS).toISOString());
      if (error) throw new Error(`markScanned(proven): ${error.message}`);
      provenSet = new Set((data ?? []).map((r: any) => r.id as string));
    }
    const keepIds = [...liveIds];
    const transientIds: string[] = [];
    const demoteIds: string[] = [];
    for (const o of failed) {
      const id = workUnitId(o.unit);
      if (provenSet.has(id)) keepIds.push(id); // proven & fresh → cycle normally
      else if (o.transient) transientIds.push(id); // transient blip → short backoff
      else demoteIds.push(id); // permanent no-route → exponential dead-route backoff (4d)
    }

    // Bulk time-stamp updates. Clearing the lease lets a kept route re-enter immediately; keep also resets
    // fail_count so a route that recovers restarts its backoff (4d).
    const bump = async (ids: string[], whenMs: number, label: string, extra: Record<string, unknown> = {}) => {
      if (ids.length === 0) return;
      const { error } = await this.db
        .from("arb_work_queue")
        .update({ last_scanned_at: new Date(whenMs).toISOString(), leased_until: null, ...extra })
        .in("id", ids);
      if (error) throw new Error(`markScanned(${label}): ${error.message}`);
    };
    // Dead routes get per-row exponential backoff (6h·2^fail_count, capped 72h) via the RPC — a bulk column
    // update can't compute a per-row interval from the row's own fail_count.
    const demoteDead = async () => {
      if (demoteIds.length === 0) return;
      const { error } = await this.db.rpc("arb_demote_dead", { p_ids: demoteIds });
      if (error) throw new Error(`markScanned(demote): ${error.message}`);
    };
    await Promise.all([
      bump(keepIds, now, "keep", { fail_count: 0 }),
      bump(transientIds, now + TRANSIENT_RETRY_MS, "transient"),
      demoteDead(),
    ]);
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

  async deleteUnitsByDebridgeIds(debridgeIds: string[]): Promise<void> {
    // Majors-denylist cleanup: drop every queued unit for these families. Chunked like requeueFresh so a
    // large denylist can't blow the URL/param limits. arb_opportunities rows are deliberately untouched.
    for (let i = 0; i < debridgeIds.length; i += 500) {
      const slice = debridgeIds.slice(i, i + 500);
      const { error } = await this.db.from("arb_work_queue").delete().in("debridge_id", slice);
      if (error) throw new Error(`deleteUnitsByDebridgeIds: ${error.message}`);
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

  async saveGraph(graph: LockGraph): Promise<void> {
    // An empty graph means discovery wholly failed — don't clobber the high-water-mark snapshot (the
    // RPC never deletes anyway) or stamp the meta row with a broken build. Mirrors the old length guard.
    if (graph.families.length === 0) return;
    const { error } = await this.db.rpc("arb_save_graph", {
      p_meta: { built_at: graph.builtAt, chains_scanned: graph.chainsScanned, partial: graph.partial },
      p_families: graph.families.map(famToRow),
    });
    if (error) throw new Error(`saveGraph: ${error.message}`);
  }

  async filterNewAlerts(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.db.rpc("arb_filter_new_alerts", { p_ids: ids });
    if (error) throw new Error(`filterNewAlerts: ${error.message}`);
    return (data ?? []).map((r: any) => (typeof r === "string" ? r : r.id));
  }

  async opportunityHistory(unitId: string, limit: number): Promise<OpportunityHistoryPoint[]> {
    const { data, error } = await this.db
      .from("arb_opportunity_history")
      .select("ts, gross_spread_pct, net_usd, tier_usd")
      .eq("unit_id", unitId)
      .order("ts", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`opportunityHistory: ${error.message}`);
    return (data ?? []).map((r: any) => ({
      ts: new Date(r.ts).getTime(),
      grossSpreadPct: r.gross_spread_pct,
      netUsd: r.net_usd,
      tierUsd: r.tier_usd,
    }));
  }

  async loadGraph(): Promise<LockGraph | null> {
    // Single jsonb value (not a row select) so the family list can't hit PostgREST's 1000-row cap.
    const { data, error } = await this.db.rpc("arb_load_graph");
    if (error) throw new Error(`loadGraph: ${error.message}`);
    const payload = (data ?? {}) as { meta?: any; families?: any[] };
    if (!payload.meta) return null; // snapshot never written → caller rebuilds
    const builtAt = Number(payload.meta.built_at);
    if (!Number.isFinite(builtAt)) return null; // corrupt/missing builtAt → treat as no snapshot, never NaN
    return {
      families: (payload.families ?? []).map(rowToFamily),
      builtAt,
      chainsScanned: Array.isArray(payload.meta.chains_scanned) ? payload.meta.chains_scanned.map(Number) : [],
      partial: !!payload.meta.partial,
    };
  }
}
