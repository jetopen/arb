import type { SymRouteRaw, SymOpportunity } from "./types";

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

/** PURE: parse a raw feed route into a UI opportunity (size = input notional in USD). */
export function mapRoute(r: SymRouteRaw): SymOpportunity {
  const tin = r.tokenAmountIn;
  const tout = r.tokenAmountOut;
  const sizeUsd = (Number(tin.amount) / 10 ** tin.decimals) * tin.priceUsd;
  return {
    id: `${tin.chainId}:${tin.address.toLowerCase()}->${tout.chainId}:${tout.address.toLowerCase()}`,
    inSymbol: tin.symbol,
    inChainId: tin.chainId,
    inAddress: tin.address,
    inDecimals: tin.decimals,
    inPriceUsd: tin.priceUsd,
    outSymbol: tout.symbol,
    outChainId: tout.chainId,
    outAddress: tout.address,
    outDecimals: tout.decimals,
    outPriceUsd: tout.priceUsd,
    profitBps: r.profitBps,
    sizeUsd,
    evmOnly: isEvmChain(tin.chainId) && isEvmChain(tout.chainId),
    btcFamily: BTC_RE.test(tin.symbol) && BTC_RE.test(tout.symbol),
  };
}

/** PURE: map + rank by spread descending. */
export function mapRoutes(routes: SymRouteRaw[]): SymOpportunity[] {
  return routes.map(mapRoute).sort((a, b) => b.profitBps - a.profitBps);
}

/** Base units for a USD clip of the input token. */
export function clipToBaseUnits(usd: number, priceUsd: number, decimals: number): string {
  if (priceUsd <= 0) return "0";
  const tokens = usd / priceUsd;
  return BigInt(Math.floor(tokens * 10 ** decimals)).toString();
}
