import { describe, it, expect } from "vitest";
import { mapRoute, mapRoutes, chainLabel, isEvmChain, clipToBaseUnits } from "../symbiosis/scanner";
import type { SymRouteRaw } from "../symbiosis/types";

// Real-shaped routes from GET /v1/positive-spread-routes
const btcbToWbtc: SymRouteRaw = {
  tokenAmountIn: { symbol: "BTCB", address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", amount: "100000000000000000", chainId: 56, decimals: 18, priceUsd: 63779 },
  tokenAmountOut: { symbol: "WBTC", address: "0xF6D226f9Dc15d9bB51182815b320D3fBE324e1bA", amount: "100340000000000000", chainId: 4200, decimals: 18, priceUsd: 63781 },
  profit: 1.5,
  profitBps: 15.47,
};
const gToWg: SymRouteRaw = {
  tokenAmountIn: { symbol: "G", address: "0x9C7BEBa8F6eF6643aBd725e45a4E8387eF260649", amount: "2519706276334494351687639", chainId: 8453, decimals: 18, priceUsd: 0.0027283 },
  tokenAmountOut: { symbol: "wG", address: "0xBB859E225ac8Fb6BE1C7e38D87b767e95Fef0EbD", amount: "2541635591543599834653522", chainId: 1625, decimals: 18, priceUsd: 0.0027283 },
  profitBps: 87.03,
};

describe("symbiosis mapRoute", () => {
  it("parses a route into an opportunity with USD size and flags", () => {
    const o = mapRoute(btcbToWbtc);
    expect(o.inSymbol).toBe("BTCB");
    expect(o.outSymbol).toBe("WBTC");
    expect(o.profitBps).toBeCloseTo(15.47, 2);
    // 0.1 BTCB × $63779 ≈ $6,378
    expect(o.sizeUsd).toBeCloseTo(6377.9, 0);
    expect(o.btcFamily).toBe(true);
    expect(o.evmOnly).toBe(true); // 56 and 4200 are both EVM
    expect(o.id).toContain("56:");
  });

  it("flags non-BTC routes correctly", () => {
    const o = mapRoute(gToWg);
    expect(o.btcFamily).toBe(false);
    expect(o.sizeUsd).toBeCloseTo(6875, -2);
  });

  it("mapRoutes ranks by spread descending", () => {
    const ranked = mapRoutes([btcbToWbtc, gToWg]);
    expect(ranked[0].inSymbol).toBe("G"); // 87 bps > 15 bps
    expect(ranked[1].inSymbol).toBe("BTCB");
  });
});

describe("symbiosis helpers", () => {
  it("chainLabel maps known chains, falls back otherwise", () => {
    expect(chainLabel(8453)).toBe("Base");
    expect(chainLabel(4200)).toBe("Merlin");
    expect(chainLabel(999999999)).toBe("Chain 999999999");
  });

  it("isEvmChain excludes native-BTC / Symbiosis intermediary big ids", () => {
    expect(isEvmChain(56)).toBe(true);
    expect(isEvmChain(4200)).toBe(true);
    expect(isEvmChain(534352)).toBe(true); // Scroll
    expect(isEvmChain(3652501241)).toBe(false); // native BTC
    expect(isEvmChain(13863860)).toBe(false); // Symbiosis chain
  });

  it("clipToBaseUnits converts a USD clip to token base units", () => {
    // $50 of BTCB at $63779, 18 decimals
    const units = clipToBaseUnits(50, 63779, 18);
    expect(Number(units) / 1e18).toBeCloseTo(50 / 63779, 9);
    expect(clipToBaseUnits(100, 0, 18)).toBe("0");
  });

  it("clipToBaseUnits returns '0' on non-finite/garbage input instead of throwing", () => {
    expect(() => clipToBaseUnits(Infinity, 1, 18)).not.toThrow();
    expect(clipToBaseUnits(Infinity, 1, 18)).toBe("0"); // usd=1e400 -> Infinity
    expect(clipToBaseUnits(50, 1, NaN)).toBe("0"); // missing/garbage decimals
    expect(clipToBaseUnits(50, 1, 400)).toBe("0"); // decimals too large -> overflow guard
    expect(clipToBaseUnits(50, -5, 18)).toBe("0"); // negative price
    expect(() => clipToBaseUnits(1e30, 1e-30, 18)).not.toThrow();
  });
});
