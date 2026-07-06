import { describe, it, expect, vi, afterEach } from "vitest";
import { parseOneInchQuote, fetchOneInchQuote, oneInchSupported } from "../quotes/oneinch";

describe("parseOneInchQuote", () => {
  it("parses dstAmount into a DexQuote (source 1inch), lowercasing tokens", () => {
    const q = parseOneInchQuote(
      { dstAmount: "151074262386" },
      { internalChainId: 56, tokenIn: "0xUSDC", tokenOut: "0xGRASS", amountIn: "25000000000000000000" }
    );
    expect(q).not.toBeNull();
    expect(q!.amountOut).toBe("151074262386");
    expect(q!.amountIn).toBe("25000000000000000000");
    expect(q!.source).toBe("1inch");
    expect(q!.tokenIn).toBe("0xusdc");
    expect(q!.tokenOut).toBe("0xgrass");
  });

  it("returns null when dstAmount is absent or zero (no route)", () => {
    expect(parseOneInchQuote({ dstAmount: "0" }, { internalChainId: 1, tokenIn: "a", tokenOut: "b", amountIn: "1" })).toBeNull();
    expect(parseOneInchQuote({}, { internalChainId: 1, tokenIn: "a", tokenOut: "b", amountIn: "1" })).toBeNull();
  });
});

describe("oneInchSupported / fetchOneInchQuote", () => {
  afterEach(() => {
    delete process.env.ONEINCH_API_KEY;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("requires both an API key and a 1inch-supported chain", () => {
    delete process.env.ONEINCH_API_KEY;
    expect(oneInchSupported(1)).toBe(false); // no key
    process.env.ONEINCH_API_KEY = "k";
    expect(oneInchSupported(1)).toBe(true); // Ethereum
    expect(oneInchSupported(8453)).toBe(true); // Base
    expect(oneInchSupported(56)).toBe(true); // BNB
    expect(oneInchSupported(100000023)).toBe(false); // Mantle (evm 5000) — not 1inch-supported
    expect(oneInchSupported(100000022)).toBe(false); // HyperEVM — not 1inch-supported
    expect(oneInchSupported(7565164)).toBe(false); // Solana — not EVM
  });

  it("returns null without an API key, without calling fetch", async () => {
    delete process.env.ONEINCH_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchOneInchQuote(1, "0xa", "0xb", "1000000")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on an unsupported chain, without calling fetch", async () => {
    process.env.ONEINCH_API_KEY = "k";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchOneInchQuote(100000019, "0xa", "0xb", "1000000")).toBeNull(); // Cronos
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds the v6.1 URL with the EVM chain id and sends the Bearer key", async () => {
    process.env.ONEINCH_API_KEY = "test-key";
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        return { ok: true, status: 200, json: async () => ({ dstAmount: "555" }) } as unknown as Response;
      })
    );
    const q = await fetchOneInchQuote(56, "0xUSDC", "0xTKN", "1000000");
    expect(q).not.toBeNull();
    expect(q!.amountOut).toBe("555");
    expect(calls[0].url).toContain("https://api.1inch.dev/swap/v6.1/56/quote");
    expect(calls[0].url).toContain("src=0xUSDC");
    expect(calls[0].url).toContain("dst=0xTKN");
    expect(calls[0].url).toContain("amount=1000000");
    expect(calls[0].headers.Authorization).toBe("Bearer test-key");
  });

  it("returns null on HTTP 400 (no route)", async () => {
    process.env.ONEINCH_API_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "insufficient liquidity" }) }) as unknown as Response)
    );
    expect(await fetchOneInchQuote(1, "0xa", "0xb", "1000000")).toBeNull();
  });

  it("throttles: a second call does not fire its request before the min interval elapses", async () => {
    process.env.ONEINCH_API_KEY = "k";
    vi.useFakeTimers();
    // Jump the clock far past any throttle state left by earlier tests (module-level lastResolve),
    // so the first call's delay is deterministically 0 and the second is exactly one interval behind.
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ dstAmount: "1" }) }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const p1 = fetchOneInchQuote(1, "0xa", "0xb", "1");
    const p2 = fetchOneInchQuote(1, "0xa", "0xb", "1");

    // First call's throttle delay is 0 — it fires immediately; the second stays queued behind the interval.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.length).toBe(1);

    // Just before the 1000ms (default ONEINCH_RPS=1) interval: still no second request.
    await vi.advanceTimersByTimeAsync(900);
    expect(fetchMock.mock.calls.length).toBe(1);

    // Crossing the interval releases the second request.
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([p1, p2]);
    expect(fetchMock.mock.calls.length).toBe(2);
  });
});
