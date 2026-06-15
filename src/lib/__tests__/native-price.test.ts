import { describe, it, expect, vi, afterEach } from "vitest";
import { getNativeUsd } from "../quotes/native-price";

/**
 * Fix #9: a transient DefiLlama failure must NOT be cached as $0 (which would zero the dePort fee and
 * flip borderline routes to "profitable" for the whole TTL). Only successful, positive prices are cached.
 * We stub the global fetch the module's fetchWithRetry uses. Each test uses a DISTINCT chain id because
 * the price cache is module-level and persists across tests in this file.
 */

// price keyed by the DefiLlama slug the module builds for each chain (`${slug}:0x000...0`).
function okJson(slug: string, price: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ coins: { [`${slug}:0x0000000000000000000000000000000000000000`]: { price } } }),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getNativeUsd caching (fix #9)", () => {
  it("does NOT cache a failed (non-ok) response — the next call retries and can succeed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as unknown as Response)
      .mockResolvedValueOnce(okJson("bsc", 600));
    vi.stubGlobal("fetch", fetchMock);

    // chain 56 = bsc
    expect(await getNativeUsd(56)).toBe(0); // failure → 0, NOT cached
    expect(await getNativeUsd(56)).toBe(600); // retry hits the network again and gets the real price
    expect(fetchMock).toHaveBeenCalledTimes(2); // proves the failure was not stuck in the cache
  });

  it("does NOT cache a thrown (network) error", async () => {
    // fetchWithRetry(maxRetries:1) retries once on a thrown error, so the first getNativeUsd makes up
    // to 2 fetch attempts; reject BOTH so it returns 0, then let the next getNativeUsd succeed.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(okJson("ethereum", 2500));
    vi.stubGlobal("fetch", fetchMock);

    // chain 1 = ethereum
    expect(await getNativeUsd(1)).toBe(0); // both attempts threw → 0, NOT cached
    expect(await getNativeUsd(1)).toBe(2500); // a fresh call retries and succeeds (no sticky $0)
  });

  it("caches a SUCCESSFUL positive price (second call served from cache, no refetch)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson("base", 1.23));
    vi.stubGlobal("fetch", fetchMock);

    // chain 8453 = base
    expect(await getNativeUsd(8453)).toBe(1.23);
    expect(await getNativeUsd(8453)).toBe(1.23);
    expect(fetchMock).toHaveBeenCalledTimes(1); // hit the cache on the 2nd call
  });

  it("returns 0 without fetching for an unknown chain slug", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getNativeUsd(999_999_999)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
