import { describe, it, expect, vi, afterEach } from "vitest";
import type { DexQuote } from "../types";

// Mock the source modules so the router's CHOICE is observable without HTTP.
const calls = vi.hoisted(() => ({ kyber: 0, debridge: 0, jupiter: 0, oneinch: 0, kyberThrow: null as Error | null, oneinchResult: null as DexQuote | null }));

function q(source: DexQuote["source"], over: Partial<DexQuote> = {}): DexQuote {
  return {
    internalChainId: 56,
    tokenIn: "0xin",
    tokenOut: "0xout",
    amountIn: "1",
    amountOut: "2",
    amountInUsd: 1,
    amountOutUsd: 1,
    priceImpactBps: 0,
    gasUsd: 0,
    recommendedSlippageBps: 10,
    source,
    ...over,
  };
}

vi.mock("../quotes/kyberswap", async (orig) => ({
  ...(await orig<typeof import("../quotes/kyberswap")>()),
  fetchKyberScanQuote: vi.fn(async () => {
    calls.kyber++;
    if (calls.kyberThrow) throw calls.kyberThrow;
    return q("kyberswap");
  }),
}));
vi.mock("../quotes/debridge", () => ({
  fetchDexQuote: vi.fn(async () => {
    calls.debridge++;
    return q("debridge");
  }),
}));
vi.mock("../quotes/jupiter", () => ({
  fetchJupiterQuote: vi.fn(async () => {
    calls.jupiter++;
    return q("jupiter");
  }),
}));
vi.mock("../quotes/oneinch", async (orig) => ({
  ...(await orig<typeof import("../quotes/oneinch")>()),
  fetchOneInchQuote: vi.fn(async () => {
    calls.oneinch++;
    return calls.oneinchResult;
  }),
}));

import { makeScanQuoteFetcher, kyberScanEnabled, normalizeScanQuote } from "../quotes/scan-quote";
import { QuoteHttpError } from "../quotes/quote-error";
import { SOLANA_INTERNAL_ID } from "../deport/address-codec";

describe("makeScanQuoteFetcher routing", () => {
  afterEach(() => {
    delete process.env.ARB_SCAN_KYBER;
    delete process.env.ARB_SCAN_1INCH_FALLBACK;
    delete process.env.ONEINCH_API_KEY;
    delete process.env.ARB_SCAN_SLIPPAGE_FLOOR_BPS;
    calls.kyber = calls.debridge = calls.jupiter = calls.oneinch = 0;
    calls.kyberThrow = null;
    calls.oneinchResult = null;
  });

  it("routes Solana → Jupiter, Kyber-slugged → Kyber, uncovered → deBridge", async () => {
    const fetchQuote = makeScanQuoteFetcher();
    expect((await fetchQuote(SOLANA_INTERNAL_ID, "a", "b", "1")).source).toBe("jupiter");
    expect((await fetchQuote(56, "0xa", "0xb", "1")).source).toBe("kyberswap"); // BSC
    expect((await fetchQuote(100000022, "0xa", "0xb", "1")).source).toBe("debridge"); // HyperEVM
    expect((await fetchQuote(100000026, "0xa", "0xb", "1")).source).toBe("debridge"); // Tron
    expect(calls.jupiter).toBe(1);
    expect(calls.kyber).toBe(1);
    expect(calls.debridge).toBe(2);
  });

  it("kill-switch ARB_SCAN_KYBER=false reverts all EVM to deBridge, read per-call", async () => {
    const fetchQuote = makeScanQuoteFetcher();
    process.env.ARB_SCAN_KYBER = "false";
    expect(kyberScanEnabled(56)).toBe(false);
    expect((await fetchQuote(56, "0xa", "0xb", "1")).source).toBe("debridge");
    delete process.env.ARB_SCAN_KYBER; // flip mid-run — next call goes back to Kyber
    expect((await fetchQuote(56, "0xa", "0xb", "1")).source).toBe("kyberswap");
  });

  it("1inch rung rescues a Kyber transient when the key is present", async () => {
    process.env.ONEINCH_API_KEY = "k";
    calls.kyberThrow = new QuoteHttpError(429, "kyber 429");
    calls.oneinchResult = q("1inch", { recommendedSlippageBps: 0 });
    const fetchQuote = makeScanQuoteFetcher();
    const got = await fetchQuote(56, "0xa", "0xb", "1");
    expect(got.source).toBe("1inch");
    expect(calls.oneinch).toBe(1);
  });

  it("propagates the ORIGINAL Kyber transient error when 1inch is off / returns null", async () => {
    calls.kyberThrow = new QuoteHttpError(429, "kyber 429");
    const fetchQuote = makeScanQuoteFetcher();
    // no key → rung inert
    await expect(fetchQuote(56, "0xa", "0xb", "1")).rejects.toBeInstanceOf(QuoteHttpError);
    expect(calls.oneinch).toBe(0);
    // key present but 1inch has no route → original error still propagates
    process.env.ONEINCH_API_KEY = "k";
    calls.oneinchResult = null;
    const err = await fetchQuote(56, "0xa", "0xb", "1").catch((e) => e);
    expect(err).toBeInstanceOf(QuoteHttpError);
    expect(err.status).toBe(429);
    // explicit kill-switch beats the key
    process.env.ARB_SCAN_1INCH_FALLBACK = "false";
    calls.oneinch = 0;
    await expect(fetchQuote(56, "0xa", "0xb", "1")).rejects.toBeInstanceOf(QuoteHttpError);
    expect(calls.oneinch).toBe(0);
  });
});

describe("normalizeScanQuote", () => {
  afterEach(() => {
    delete process.env.ARB_SCAN_SLIPPAGE_FLOOR_BPS;
  });

  const BSC_USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"; // 18-dec base
  const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"; // 6-dec base

  it("derives buy-leg amountInUsd from the 18-dec BSC base when the source omits USD", () => {
    const n = normalizeScanQuote(
      q("1inch", { tokenIn: BSC_USDC, amountIn: (25n * 10n ** 18n).toString(), amountInUsd: 0 }),
      56
    );
    expect(n.amountInUsd).toBeCloseTo(25, 6);
  });

  it("derives sell-leg amountOutUsd from a 6-dec base; leaves a dead quote (amountOut 0) at 0", () => {
    const n = normalizeScanQuote(
      q("1inch", { tokenOut: ARB_USDC, amountOut: "25000000", amountOutUsd: 0 }),
      42161
    );
    expect(n.amountOutUsd).toBeCloseTo(25, 6);
    const dead = normalizeScanQuote(q("1inch", { tokenOut: ARB_USDC, amountOut: "0", amountOutUsd: 0 }), 42161);
    expect(dead.amountOutUsd).toBe(0);
  });

  it("does not touch USD fields for non-base tokens or when the source already priced them", () => {
    const nonBase = normalizeScanQuote(q("1inch", { tokenOut: "0xnotusdc", amountOutUsd: 0 }), 42161);
    expect(nonBase.amountOutUsd).toBe(0);
    const priced = normalizeScanQuote(q("kyberswap", { tokenOut: ARB_USDC, amountOutUsd: 24.5 }), 42161);
    expect(priced.amountOutUsd).toBe(24.5);
  });

  it("applies the slippage floor only when the source returned 0 (default 50, env-overridable, clamps garbage)", () => {
    expect(normalizeScanQuote(q("kyberswap", { recommendedSlippageBps: 0 }), 56).recommendedSlippageBps).toBe(50);
    expect(normalizeScanQuote(q("debridge", { recommendedSlippageBps: 80 }), 56).recommendedSlippageBps).toBe(80);
    process.env.ARB_SCAN_SLIPPAGE_FLOOR_BPS = "25";
    expect(normalizeScanQuote(q("kyberswap", { recommendedSlippageBps: 0 }), 56).recommendedSlippageBps).toBe(25);
    process.env.ARB_SCAN_SLIPPAGE_FLOOR_BPS = "garbage";
    expect(normalizeScanQuote(q("kyberswap", { recommendedSlippageBps: 0 }), 56).recommendedSlippageBps).toBe(50);
  });
});
