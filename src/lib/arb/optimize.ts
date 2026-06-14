import type { DexQuote } from "../types";
import { redemptionEdge } from "./edge";
import { baseToken, tierToBaseUnits } from "./base-tokens";

/**
 * Trade-size optimization for a dePort redemption route.
 *
 * Why it matters for small capital: price impact shrinks as the trade shrinks (a tiny trade barely
 * moves a thin pool), so the GROSS spread often turns positive at small size — but the flat dePort
 * fee does NOT shrink, so as a % it explodes. Net is a U-curve; this finds its bottom (the
 * net-maximizing size) and the break-even notional, which fixed tiers ($1k/$10k/$50k) miss entirely.
 */

export const DEFAULT_SIZE_GRID = [25, 50, 100, 250, 500, 1000, 2500, 5000];

export interface SizePoint {
  sizeUsd: number;
  grossPct: number;
  netUsd: number;
  netEdgePct: number;
}

export interface OptimizeRoute {
  debridgeId: string;
  buyChainId: number;
  sellChainId: number;
  buyToken: string;
  sellToken: string;
  symbol?: string;
}

export interface OptimizeResult {
  route: OptimizeRoute;
  feeUsd: number;
  curve: SizePoint[];
  /** Size with the highest net$ (the practical sweet spot). Null if no size quoted. */
  best: SizePoint | null;
  /** Smallest notional where net ≥ 0 (linear-interpolated between grid points). Null if never profitable. */
  breakEvenSizeUsd: number | null;
  /** Largest notional where the gross spread is still positive (interp.). Null if never gross-positive. */
  grossPositiveMaxUsd: number | null;
}

export interface OptimizeDeps {
  fetchQuote: (chainId: number, tokenIn: string, tokenOut: string, amountIn: string) => Promise<DexQuote>;
  getFeeUsd: (buyChainId: number, debridgeId: string) => Promise<number>;
}

/** Linear interpolation of the x (size) where y (metric) crosses `target`, between two points. */
function interpCross(a: SizePoint, b: SizePoint, ya: number, yb: number, target: number): number {
  if (yb === ya) return b.sizeUsd;
  const t = (target - ya) / (yb - ya);
  return a.sizeUsd + t * (b.sizeUsd - a.sizeUsd);
}

/** PURE: derive best / break-even / gross-positive-max from a computed curve. */
export function summarizeCurve(curve: SizePoint[]): Pick<OptimizeResult, "best" | "breakEvenSizeUsd" | "grossPositiveMaxUsd"> {
  if (curve.length === 0) return { best: null, breakEvenSizeUsd: null, grossPositiveMaxUsd: null };
  const sorted = [...curve].sort((a, b) => a.sizeUsd - b.sizeUsd);
  const best = sorted.reduce((acc, p) => (p.netUsd > acc.netUsd ? p : acc), sorted[0]);

  // Smallest size where net >= 0 (interp across the first upward crossing).
  let breakEvenSizeUsd: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].netUsd >= 0) {
      breakEvenSizeUsd =
        i > 0 && sorted[i - 1].netUsd < 0
          ? interpCross(sorted[i - 1], sorted[i], sorted[i - 1].netUsd, sorted[i].netUsd, 0)
          : sorted[i].sizeUsd;
      break;
    }
  }

  // Largest size where gross > 0 (interp across the last downward crossing).
  let grossPositiveMaxUsd: number | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].grossPct > 0) {
      grossPositiveMaxUsd =
        i < sorted.length - 1 && sorted[i + 1].grossPct <= 0
          ? interpCross(sorted[i], sorted[i + 1], sorted[i].grossPct, sorted[i + 1].grossPct, 0)
          : sorted[i].sizeUsd;
      break;
    }
  }

  return { best, breakEvenSizeUsd, grossPositiveMaxUsd };
}

/**
 * Sweep trade sizes for one route and return the net-edge curve + sweet-spot summary.
 * The flat dePort fee is fetched once (it's size-independent). Sizes are evaluated concurrently.
 */
export async function optimizeRoute(
  route: OptimizeRoute,
  deps: OptimizeDeps,
  sizes: number[] = DEFAULT_SIZE_GRID
): Promise<OptimizeResult> {
  const buyBase = baseToken(route.buyChainId);
  const sellBase = baseToken(route.sellChainId);
  const empty: OptimizeResult = { route, feeUsd: 0, curve: [], best: null, breakEvenSizeUsd: null, grossPositiveMaxUsd: null };
  if (!buyBase || !sellBase) return empty;

  const feeUsd = await deps.getFeeUsd(route.buyChainId, route.debridgeId);

  const points = await Promise.all(
    sizes.map(async (sizeUsd): Promise<SizePoint | null> => {
      try {
        const amountIn = tierToBaseUnits(sizeUsd, buyBase);
        const buyLeg = await deps.fetchQuote(route.buyChainId, buyBase.address, route.buyToken, amountIn);
        if (buyLeg.amountOut === "0") return null;
        const sellLeg = await deps.fetchQuote(route.sellChainId, route.sellToken, sellBase.address, buyLeg.amountOut);
        const edge = redemptionEdge(buyLeg, sellLeg, feeUsd);
        return { sizeUsd, grossPct: edge.grossSpreadPct, netUsd: edge.netUsd, netEdgePct: edge.netEdgePct };
      } catch {
        return null;
      }
    })
  );

  const curve = points.filter((p): p is SizePoint => p !== null);
  return { route, feeUsd, curve, ...summarizeCurve(curve) };
}
