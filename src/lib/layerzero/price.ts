import { fetchWithRetry } from "@/lib/api-client";

/** Per-chain token metrics surfaced by the LayerZero tracker for price + cross-chain spread. */
export interface TokenMetrics {
  priceUsd: number | null;
  liquidityUsd: number | null;
  volumeH24Usd: number | null;
  fdvUsd: number | null;
}

const NULL_METRICS: TokenMetrics = {
  priceUsd: null,
  liquidityUsd: null,
  volumeH24Usd: null,
  fdvUsd: null,
};

/** Shape of the relevant slice of a GeckoTerminal token response. All fields optional/loose. */
interface GtTokenResponse {
  data?: {
    attributes?: {
      price_usd?: unknown;
      total_reserve_in_usd?: unknown;
      volume_usd?: { h24?: unknown };
      fdv_usd?: unknown;
    };
  };
}

/** null-safe string|number -> finite number, otherwise null. */
function toNum(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * PURE: extract per-chain token metrics from a GeckoTerminal token response.
 * Reads `data.attributes.{ price_usd, total_reserve_in_usd, volume_usd.h24, fdv_usd }`,
 * coercing strings to numbers and mapping NaN/missing to null.
 */
export function parseGtToken(raw: unknown): TokenMetrics {
  const attrs = (raw as GtTokenResponse | null | undefined)?.data?.attributes;
  if (!attrs) return { ...NULL_METRICS };
  return {
    priceUsd: toNum(attrs.price_usd),
    liquidityUsd: toNum(attrs.total_reserve_in_usd),
    volumeH24Usd: toNum(attrs.volume_usd?.h24),
    fdvUsd: toNum(attrs.fdv_usd),
  };
}

/**
 * Fetch a token's metrics from GeckoTerminal for the given network slug + address.
 * Returns all-null metrics on a non-OK response or any thrown error (never rejects).
 */
export async function fetchTokenMetrics(
  gtSlug: string,
  address: string
): Promise<TokenMetrics> {
  if (!gtSlug || !address) return { ...NULL_METRICS };
  const url = `https://api.geckoterminal.com/api/v2/networks/${gtSlug}/tokens/${address}`;
  try {
    const res = await fetchWithRetry(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      { maxRetries: 1 }
    );
    if (!res.ok) return { ...NULL_METRICS };
    return parseGtToken(await res.json());
  } catch {
    return { ...NULL_METRICS };
  }
}
