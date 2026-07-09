import { fetchWithRetry } from "../api-client";
import { HYPERSYNC_CHAINS, TRANSFER_TOPIC0 } from "./chains";

/**
 * HyperSync (Envio) raw HTTP-JSON client — bulk event-log reads to MEASURE on-chain activity per rep.
 * Raw HTTP (not the native @envio-dev/hypersync-client SDK) keeps it dependency-light and matches the
 * house fetchWithRetry style. Needs ENVIO_API_TOKEN (envio.dev/app/api-tokens); absent → every call
 * returns null. FAIL-OPEN like the liquidity prefilter: any outage / parse error returns null so an
 * Envio hiccup never marks a rep dead.
 *
 * The /query request/response uses snake_case (from_block, field_selection, next_block, archive_height).
 * Response parsing is deliberately defensive (tolerates data-as-array-of-batches OR data-as-object, and
 * snake/camel field casing) so minor API drift degrades gracefully instead of throwing.
 */

// Free-tier-friendly throttle: timestamp-based min-interval, same shape as oneinch.ts / jupiter.ts.
const RPS_RAW = Number(process.env.ARB_HYPERSYNC_RPS);
const RPS = Number.isFinite(RPS_RAW) && RPS_RAW > 0 ? RPS_RAW : 5;
const MIN_INTERVAL_MS = Math.max(1, Math.round(1000 / RPS));

let lastResolve = 0;
function throttle(): Promise<void> {
  const now = Date.now();
  const delay = Math.max(0, lastResolve + MIN_INTERVAL_MS - now);
  lastResolve = now + delay;
  return new Promise<void>((res) => setTimeout(res, delay));
}

/** Fields we ask HyperSync to return per log — just enough to attribute a transfer to a rep + timestamp it. */
export const LOG_FIELDS = ["address", "block_number"];

/** Per-rep on-chain activity over the sampled window. */
export interface RepActivity {
  transferCount: number;
  lastBlock: number;
}

interface HyperSyncLog {
  address?: string;
  block_number?: number;
  // tolerate camelCase / capitalized variants across API versions
  Address?: string;
  blockNumber?: number;
  BlockNumber?: number;
}

interface HyperSyncQueryResponse {
  data?: unknown;
  next_block?: number;
  nextBlock?: number;
  archive_height?: number;
  archiveHeight?: number;
}

/** PURE: the /query request body for a Transfer-activity sweep over `addresses` in [fromBlock, toBlock]. */
export function buildActivityQuery(addresses: string[], fromBlock: number, toBlock: number) {
  return {
    from_block: fromBlock,
    to_block: toBlock + 1, // HyperSync to_block is exclusive; +1 to include the sampled tip block
    logs: [{ address: addresses.map((a) => a.toLowerCase()), topics: [[TRANSFER_TOPIC0]] }],
    field_selection: { log: LOG_FIELDS },
  };
}

/**
 * PURE: pull a flat log list out of a /query response, tolerating both shapes:
 *  - data: [ { logs: [...] }, ... ]  (array of block-range batches)
 *  - data: { logs: [...] }           (object)
 * plus a top-level `logs` fallback.
 */
export function extractLogs(json: HyperSyncQueryResponse): HyperSyncLog[] {
  const d = json?.data as unknown;
  if (Array.isArray(d)) {
    return d.flatMap((b) => {
      if (Array.isArray(b)) return b as HyperSyncLog[]; // array-of-logs
      const logs = (b as { logs?: unknown })?.logs;
      if (Array.isArray(logs)) return logs as HyperSyncLog[];
      // a bare log object (has an address) — accept it
      return b && ((b as HyperSyncLog).address || (b as HyperSyncLog).Address) ? [b as HyperSyncLog] : [];
    });
  }
  const objLogs = (d as { logs?: unknown })?.logs;
  if (Array.isArray(objLogs)) return objLogs as HyperSyncLog[];
  const top = (json as { logs?: unknown })?.logs;
  if (Array.isArray(top)) return top as HyperSyncLog[];
  return [];
}

function logAddress(l: HyperSyncLog): string | null {
  const a = l.address ?? l.Address;
  return a ? a.toLowerCase() : null;
}
function logBlock(l: HyperSyncLog): number {
  return Number(l.block_number ?? l.blockNumber ?? l.BlockNumber ?? 0);
}
function nextBlockOf(json: HyperSyncQueryResponse): number | undefined {
  const nb = json.next_block ?? json.nextBlock;
  return typeof nb === "number" ? nb : undefined;
}

/** PURE: fold a flat log list into per-address transfer counts + last-seen block. */
export function aggregateActivity(
  logs: HyperSyncLog[],
  into: Map<string, RepActivity> = new Map()
): Map<string, RepActivity> {
  for (const log of logs) {
    const a = logAddress(log);
    if (!a) continue;
    const blk = logBlock(log);
    const prev = into.get(a);
    if (prev) {
      prev.transferCount++;
      if (blk > prev.lastBlock) prev.lastBlock = blk;
    } else {
      into.set(a, { transferCount: 1, lastBlock: blk });
    }
  }
  return into;
}

/** Current archive height for a chain, or null (no token / unsupported / outage). */
export async function getHeight(internalChainId: number): Promise<number | null> {
  const token = process.env.ENVIO_API_TOKEN;
  const chain = HYPERSYNC_CHAINS.get(internalChainId);
  if (!token || !chain) return null;
  try {
    await throttle();
    const res = await fetchWithRetry(
      `${chain.url}/height`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      { maxRetries: 1 }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { height?: number };
    return typeof json.height === "number" ? json.height : null;
  } catch {
    return null;
  }
}

/**
 * Sweep Transfer activity for MANY rep addresses on one chain in a single query stream (address-array
 * filter), paginating on next_block across the 5-second processing window. Returns a per-address
 * {transferCount,lastBlock} map (addresses with no activity are simply absent), or null when the sweep
 * can't be COMPLETED to the tip of the requested window (no token / unsupported chain / empty input / any
 * mid-sweep error / the maxPages cap). FAIL-OPEN: a null return means "unknown", never "dead" — and that
 * MUST include a partial scan, since a truncated count would look identical to a genuinely-quiet rep and
 * get mis-classified as dead. So we never return a partial map: it's the fully-scanned window or null.
 */
export async function getChainActivity(
  internalChainId: number,
  addresses: string[],
  fromBlock: number,
  toBlock: number,
  opts: { maxPages?: number } = {}
): Promise<Map<string, RepActivity> | null> {
  const token = process.env.ENVIO_API_TOKEN;
  const chain = HYPERSYNC_CHAINS.get(internalChainId);
  if (!token || !chain || addresses.length === 0) return null;
  const maxPages = Math.max(1, opts.maxPages ?? 50);
  const start = Math.max(0, Math.floor(fromBlock));
  const end = Math.max(start, Math.floor(toBlock));

  const acc = new Map<string, RepActivity>();
  let cursor = start;
  let pages = 0;
  // Only return `acc` once the window is scanned to the tip. Any interruption — a mid-stream outage, a
  // parse throw, or the maxPages cap — returns null (unknown) so the caller skips the chain, never a
  // partial (which would masquerade as a genuinely-quiet rep and mark a live route dead).
  let completed = false;
  try {
    while (cursor <= end && pages < maxPages) {
      pages++;
      const body = JSON.stringify(buildActivityQuery(addresses, cursor, end));
      await throttle();
      const res = await fetchWithRetry(
        `${chain.url}/query`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` }, body },
        { maxRetries: 1 }
      );
      if (!res.ok) return null; // mid-sweep outage → unknown, NOT a truncated (false-dead) count
      const json = (await res.json()) as HyperSyncQueryResponse; // parse throw → catch → null
      aggregateActivity(extractLogs(json), acc);
      const nb = nextBlockOf(json);
      if (nb === undefined || nb > end) {
        completed = true; // reached the tip of the requested window
        break;
      }
      if (nb <= cursor) return null; // server not advancing → can't guarantee full coverage
      cursor = nb;
    }
    // Fell out of the loop with completed=false → the maxPages cap bit before the tip: partial, so null.
    return completed ? acc : null;
  } catch {
    return null; // parse / network error mid-sweep → unknown (never a partial map)
  }
}
