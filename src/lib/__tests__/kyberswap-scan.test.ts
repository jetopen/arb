import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchKyberScanQuote, fetchKyberQuote } from "../quotes/kyberswap";
import { QuoteHttpError, isTransientQuoteError } from "../quotes/quote-error";

const ROUTE_OK = {
  data: { routeSummary: { amountIn: "25000000", amountInUsd: "25", amountOut: "999", amountOutUsd: "24.9", gasUsd: "0.02" } },
};

function stubFetch(status: number, body: unknown = {}, ok = status >= 200 && status < 300) {
  const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchKyberScanQuote (scan face)", () => {
  afterEach(() => {
    delete process.env.ARB_KYBER_CLIENT_ID;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("throws QuoteHttpError on 429 and 5xx (transient — never a 6h dead-route demotion)", async () => {
    stubFetch(429);
    await expect(fetchKyberScanQuote(56, "0xusdc", "0xtkn", "1")).rejects.toBeInstanceOf(QuoteHttpError);
    stubFetch(503);
    const err = await fetchKyberScanQuote(56, "0xusdc", "0xtkn", "1").catch((e) => e);
    expect(err).toBeInstanceOf(QuoteHttpError);
    expect(err.status).toBe(503);
    expect(isTransientQuoteError(err)).toBe(true);
  });

  it("returns a dead quote (amountOut 0) on 4xx and on ok-without-routeSummary (genuine no-route)", async () => {
    stubFetch(400, { code: 4008, message: "route not found" });
    const dead = await fetchKyberScanQuote(56, "0xUSDC", "0xTKN", "1");
    expect(dead.amountOut).toBe("0");
    expect(dead.source).toBe("kyberswap");
    stubFetch(200, { data: {} });
    expect((await fetchKyberScanQuote(56, "0xusdc", "0xtkn", "1")).amountOut).toBe("0");
  });

  it("classifies a block/timeout status (403/408/409) as TRANSIENT, not a per-route dead verdict", async () => {
    for (const s of [403, 408, 409]) {
      stubFetch(s, { message: "blocked" });
      const err = await fetchKyberScanQuote(56, "0xusdc", "0xtkn", "1").catch((e) => e);
      // The load-bearing property is transient classification (NOT a QuoteHttpError, which for a 4xx would
      // be treated PERMANENT and re-create the 6h mass-demote); a plain Error → default-transient.
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(QuoteHttpError);
      expect(isTransientQuoteError(err)).toBe(true);
    }
  });

  it("classifies a 2xx with an unparseable body as TRANSIENT — a network hiccup, NOT a dead route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected end of JSON input");
        },
      }) as unknown as Response)
    );
    const err = await fetchKyberScanQuote(42161, "0xusdc", "0xtkn", "1").catch((e) => e);
    expect(isTransientQuoteError(err)).toBe(true);
  });

  it("parses a good route with real USD fields", async () => {
    stubFetch(200, ROUTE_OK);
    const q = await fetchKyberScanQuote(56, "0xUSDC", "0xTKN", "25000000");
    expect(q.amountOut).toBe("999");
    expect(q.amountInUsd).toBe(25);
    expect(q.amountOutUsd).toBe(24.9);
    expect(q.gasUsd).toBe(0.02);
  });

  it("sends the x-client-id header (default arb-scanner, env-overridable)", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ headers: (init?.headers ?? {}) as Record<string, string> });
        return { ok: true, status: 200, json: async () => ROUTE_OK } as unknown as Response;
      })
    );
    await fetchKyberScanQuote(56, "0xa", "0xb", "1");
    expect(calls[0].headers["x-client-id"]).toBe("arb-scanner");
    process.env.ARB_KYBER_CLIENT_ID = "my-app";
    await fetchKyberScanQuote(56, "0xa", "0xb", "1");
    expect(calls[1].headers["x-client-id"]).toBe("my-app");
  });

  it("throws loudly for a chain without a Kyber slug (router bug, not a dead route)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchKyberScanQuote(100000022, "0xa", "0xb", "1")).rejects.toThrow(/unsupported chain/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verify face still swallows HTTP errors to null (no-opinion contract preserved)", async () => {
    stubFetch(429);
    expect(await fetchKyberQuote(56, "0xa", "0xb", "1")).toBeNull();
  });

  it("throttles: a second call waits for the ARB_KYBER_RPS min interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60 * 60 * 1000); // clear module-level lastResolve from earlier tests
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ROUTE_OK }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const p1 = fetchKyberScanQuote(56, "0xa", "0xb", "1");
    const p2 = fetchKyberScanQuote(56, "0xa", "0xb", "1");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(150); // < 200ms (default 5 RPS)
    expect(fetchMock.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([p1, p2]);
    expect(fetchMock.mock.calls.length).toBe(2);
  });
});
