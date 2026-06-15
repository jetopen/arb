import { describe, it, expect } from "vitest";
import { parseJupiter, SOLANA_USDC_MINT } from "../quotes/jupiter";

const KAKA = "FH6jc68WzeAUXKp6uDg9QPciTeU75o32xFDzKLzmbonk";
const SOL = 7565164;

describe("parseJupiter", () => {
  it("USDC→token: amountInUsd is exact from the USDC raw amount; impact pct (fraction) → bps", () => {
    const q = parseJupiter(
      { inAmount: "1000000000", outAmount: "78000000000000", priceImpactPct: "0.05", slippageBps: 100, swapUsdValue: 1000 },
      { tokenIn: SOLANA_USDC_MINT, tokenOut: KAKA }
    );
    expect(q.internalChainId).toBe(SOL);
    expect(q.source).toBe("jupiter");
    expect(q.amountInUsd).toBe(1000); // 1,000,000,000 / 1e6 — USDC side, exact
    expect(q.amountOutUsd).toBe(1000); // token side → swapUsdValue
    expect(q.priceImpactBps).toBeCloseTo(500, 6); // 0.05 fraction × 10_000
    expect(q.tokenIn).toBe(SOLANA_USDC_MINT); // base58 preserved, not lowercased
    expect(q.tokenOut).toBe(KAKA);
  });

  it("token→USDC: amountOutUsd is exact from the USDC raw output amount", () => {
    const q = parseJupiter(
      { inAmount: "78000000000000", outAmount: "995000000", priceImpactPct: "0.02", swapUsdValue: 990 },
      { tokenIn: KAKA, tokenOut: SOLANA_USDC_MINT }
    );
    expect(q.amountOutUsd).toBe(995); // 995,000,000 / 1e6 — USDC side, exact
    expect(q.amountInUsd).toBe(990); // token side → swapUsdValue
    expect(q.priceImpactBps).toBeCloseTo(200, 6);
  });

  it("a routeless quote degrades to amountOut 0 (caller treats as dead, like the EVM path)", () => {
    const q = parseJupiter({ inAmount: "1000000000" }, { tokenIn: SOLANA_USDC_MINT, tokenOut: KAKA });
    expect(q.amountOut).toBe("0");
  });
});
