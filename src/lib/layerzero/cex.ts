import { fetchWithRetry } from "@/lib/api-client";

/**
 * CEX listing + price lookup for a token symbol across major venues.
 *
 * Each parser is PURE: given the raw JSON body of a venue's public ticker
 * endpoint, it returns the last/spot price as a finite number, or `null` when
 * the symbol is not listed (empty payload, error envelope, unparseable price).
 * A venue counts as "listed" iff its parser yields a finite number.
 */

/** Coerce an unknown to a finite number, or null. Accepts numeric strings. */
function finiteNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * PURE: Gate.io `/spot/tickers` returns a JSON array; for a listed pair the
 * first element carries `last` (a string price). Empty array / non-array /
 * missing price ⇒ not listed.
 */
export function parseGate(raw: unknown): number | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0];
  if (!first || typeof first !== "object") return null;
  return finiteNumber((first as { last?: unknown }).last);
}

/**
 * PURE: MEXC `/ticker/price` returns `{ symbol, price }` for a listed pair.
 * An error envelope carries a `code` (and no usable price) ⇒ not listed.
 */
export function parseMexc(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { price?: unknown; code?: unknown };
  if (obj.code != null) return null;
  return finiteNumber(obj.price);
}

/**
 * PURE: Bitget `/spot/market/tickers` returns `{ code, data: [ { lastPr } ] }`.
 * Empty / missing `data` ⇒ not listed.
 */
export function parseBitget(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (!first || typeof first !== "object") return null;
  return finiteNumber((first as { lastPr?: unknown }).lastPr);
}

export interface CexListing {
  listedOn: string[];
  prices: { gate?: number; mexc?: number; bitget?: number };
}

/** GET a public ticker URL and return parsed JSON, or null on any failure. */
async function fetchJson(url: string): Promise<unknown> {
  try {
    const res = await fetchWithRetry(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      { maxRetries: 1 }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Check the three major CEXs for `symbol` (paired vs USDT) and return which
 * venues list it plus their last prices. The symbol is uppercased for the pair.
 */
export async function fetchCexListing(symbol: string): Promise<CexListing> {
  const sym = symbol.trim().toUpperCase();
  const prices: CexListing["prices"] = {};
  const listedOn: string[] = [];
  if (!sym) return { listedOn, prices };

  const [gateRaw, mexcRaw, bitgetRaw] = await Promise.all([
    fetchJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${sym}_USDT`),
    fetchJson(`https://api.mexc.com/api/v3/ticker/price?symbol=${sym}USDT`),
    fetchJson(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}USDT`),
  ]);

  const gate = parseGate(gateRaw);
  if (gate != null) {
    prices.gate = gate;
    listedOn.push("gate");
  }

  const mexc = parseMexc(mexcRaw);
  if (mexc != null) {
    prices.mexc = mexc;
    listedOn.push("mexc");
  }

  const bitget = parseBitget(bitgetRaw);
  if (bitget != null) {
    prices.bitget = bitget;
    listedOn.push("bitget");
  }

  return { listedOn, prices };
}
