import type { SymRouteRaw, SymOpportunity, SymToken } from "./types";

/** Symbiosis chain id → display name (spans many chains beyond the dePort set). */
const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum", 10: "Optimism", 56: "BNB", 137: "Polygon", 8453: "Base", 42161: "Arbitrum",
  43114: "Avalanche", 59144: "Linea", 324: "zkSync", 534352: "Scroll", 5000: "Mantle",
  250: "Fantom", 1284: "Moonbeam", 2222: "Kava", 7000: "Zeta", 81457: "Blast", 169: "Manta",
  30: "Rootstock", 4200: "Merlin", 223: "BSquared", 999: "HyperEVM", 1625: "Gravity",
  33139: "ApeChain", 1101: "PolygonzkEVM", 146: "Sonic", 80094: "Berachain", 130: "Unichain",
  143: "Monad", 4217: "?", 13863860: "Symbiosis",
};

export function chainLabel(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

/** EVM heuristic — non-EVM Symbiosis legs (native BTC, the Symbiosis intermediary) use huge ids. */
export function isEvmChain(chainId: number): boolean {
  return chainId > 0 && chainId < 10_000_000;
}

const BTC_RE = /btc/i;

/** A feed token leg is usable only if its address is a string and amount/price/decimals are finite. */
function isValidLeg(t: (SymToken & { amount: string }) | null | undefined): t is SymToken & { amount: string } {
  return (
    !!t &&
    typeof t.address === "string" &&
    t.address.length > 0 &&
    Number.isFinite(Number(t.amount)) &&
    Number.isFinite(t.priceUsd) &&
    Number.isFinite(t.decimals) &&
    Number.isFinite(t.chainId)
  );
}

/**
 * PURE: parse a raw feed route into a UI opportunity (size = input notional in USD).
 * Returns null for a malformed feed row (fix #10): the Symbiosis feed is untrusted, so a null address
 * or non-numeric amount/price must SKIP the row (filtered out by mapRoutes) rather than throw on
 * `.toLowerCase()` / yield a `$NaN` size and 500 the whole /api/arb/symbiosis response.
 */
export function mapRoute(r: SymRouteRaw): SymOpportunity | null {
  const tin = r?.tokenAmountIn;
  const tout = r?.tokenAmountOut;
  if (!isValidLeg(tin) || !isValidLeg(tout) || !Number.isFinite(r?.profitBps)) return null;

  const sizeUsd = (Number(tin.amount) / 10 ** tin.decimals) * tin.priceUsd;
  if (!Number.isFinite(sizeUsd)) return null; // belt-and-suspenders against overflow/odd inputs
  const inSymbol = tin.symbol ?? "";
  const outSymbol = tout.symbol ?? "";
  return {
    id: `${tin.chainId}:${tin.address.toLowerCase()}->${tout.chainId}:${tout.address.toLowerCase()}`,
    inSymbol,
    inChainId: tin.chainId,
    inAddress: tin.address,
    inDecimals: tin.decimals,
    inPriceUsd: tin.priceUsd,
    outSymbol,
    outChainId: tout.chainId,
    outAddress: tout.address,
    outDecimals: tout.decimals,
    outPriceUsd: tout.priceUsd,
    profitBps: r.profitBps,
    sizeUsd,
    evmOnly: isEvmChain(tin.chainId) && isEvmChain(tout.chainId),
    btcFamily: BTC_RE.test(inSymbol) && BTC_RE.test(outSymbol),
  };
}

/** PURE: map + rank by spread descending, dropping malformed feed rows (mapRoute → null). */
export function mapRoutes(routes: SymRouteRaw[]): SymOpportunity[] {
  return routes
    .map(mapRoute)
    .filter((o): o is SymOpportunity => o !== null)
    .sort((a, b) => b.profitBps - a.profitBps);
}

/** Base units for a USD clip of the input token. Returns "0" on any non-finite/garbage input
 * (never throws — `BigInt(Math.floor(Infinity|NaN))` would otherwise RangeError). */
export function clipToBaseUnits(usd: number, priceUsd: number, decimals: number): string {
  if (!(priceUsd > 0) || !Number.isFinite(usd) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return "0";
  }
  const scaled = Math.floor((usd / priceUsd) * 10 ** decimals);
  if (!Number.isFinite(scaled)) return "0";
  return BigInt(scaled).toString();
}
