import { describe, it, expect } from "vitest";
import { RpmBudget } from "../arb/budget";
import { parseEstimation } from "../quotes/debridge";

describe("RpmBudget", () => {
  it("starts full and spends down to empty", () => {
    const t0 = 1_000_000;
    const b = new RpmBudget(60, t0);
    expect(b.available(t0)).toBe(60);
    for (let i = 0; i < 60; i++) expect(b.tryAcquire(1, t0)).toBe(true);
    expect(b.tryAcquire(1, t0)).toBe(false);
  });

  it("refills over time at the configured rate", () => {
    const t0 = 1_000_000;
    const b = new RpmBudget(60, t0); // 1 token/sec
    for (let i = 0; i < 60; i++) b.tryAcquire(1, t0);
    expect(b.tryAcquire(1, t0)).toBe(false);
    // 10s later -> ~10 tokens back
    expect(b.available(t0 + 10_000)).toBe(10);
    expect(b.tryAcquire(5, t0 + 10_000)).toBe(true);
  });

  it("never exceeds capacity", () => {
    const t0 = 1_000_000;
    const b = new RpmBudget(30, t0);
    expect(b.available(t0 + 10 * 60_000)).toBe(30);
  });
});

describe("parseEstimation", () => {
  it("maps the deBridge estimation response into a DexQuote (gas, slippage, best route)", () => {
    const raw = {
      estimation: {
        tokenIn: { amount: "10000000000", approximateUsdValue: 10000 },
        tokenOut: { amount: "6004569781261305885", approximateUsdValue: 10002.26 },
        slippage: 0.3,
        recommendedSlippage: 0.3,
        estimatedTransactionFee: { approximateUsdValue: 0.1116 },
        comparedAggregators: [
          { name: "0x", amount: "6004569781261305885", priceDrop: 0, approximateUsdValue: 9994 },
          { name: "kyber", amount: "5990540145375505722", priceDrop: 0.29, approximateUsdValue: 9990 },
        ],
      },
    };
    const q = parseEstimation(raw, { internalChainId: 42161, tokenIn: "0xUSDC", tokenOut: "0xWETH" });
    expect(q.amountOut).toBe("6004569781261305885");
    expect(q.amountOutUsd).toBeCloseTo(10002.26, 2);
    expect(q.gasUsd).toBeCloseTo(0.1116, 4);
    expect(q.recommendedSlippageBps).toBeCloseTo(30, 6);
    expect(q.priceImpactBps).toBe(0); // best route had no drop
    expect(q.tokenIn).toBe("0xusdc");
    expect(q.source).toBe("debridge");
  });
});
