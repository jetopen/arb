import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  passesLiquidityPrefilter,
  evictToBound,
  __clearPrefilterCache,
  NEGATIVE_TTL_MS,
  POSITIVE_TTL_MS,
  MAX_CACHE,
} from "../arb/liquidity-prefilter";
import type { GtTokenStats } from "../liquidity/geckoterminal";

const stats = (liquidityUsd: number | null): GtTokenStats => ({ liquidityUsd, priceUsd: null });

describe("passesLiquidityPrefilter", () => {
  const prevEnv = process.env.ARB_PREFILTER;
  beforeEach(() => {
    __clearPrefilterCache();
    delete process.env.ARB_PREFILTER;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.ARB_PREFILTER;
    else process.env.ARB_PREFILTER = prevEnv;
  });

  it("returns false for a token GT confirms has no liquidity, true when it has some", async () => {
    expect(await passesLiquidityPrefilter(56, "0xdead", async () => stats(0))).toBe(false);
    expect(await passesLiquidityPrefilter(56, "0xlive", async () => stats(12345))).toBe(true);
  });

  it("treats a successful response with NULL reserve as no-liquidity (GT knows the token, no pools)", async () => {
    expect(await passesLiquidityPrefilter(56, "0xdead", async () => stats(null))).toBe(false);
  });

  it("caches results — the second call does not re-probe", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return stats(0);
    };
    await passesLiquidityPrefilter(56, "0xDEAD", fn);
    // Same token, different case → same cache key (address is lowercased).
    expect(await passesLiquidityPrefilter(56, "0xdead", fn)).toBe(false);
    expect(calls).toBe(1);
  });

  it("fails open WITHOUT caching on a null probe (outage/429/unknown network)", async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      return null;
    };
    expect(await passesLiquidityPrefilter(56, "0xtok", failing)).toBe(true);
    expect(await passesLiquidityPrefilter(56, "0xtok", failing)).toBe(true);
    expect(calls).toBe(2); // outage result was NOT cached — probed again
    // Once GT recovers and reports no liquidity, the negative result IS cached.
    expect(await passesLiquidityPrefilter(56, "0xtok", async () => stats(0))).toBe(false);
  });

  it("fails open when the probe throws", async () => {
    expect(
      await passesLiquidityPrefilter(56, "0xtok", async () => {
        throw new Error("network");
      })
    ).toBe(true);
  });

  it("expires negative entries after NEGATIVE_TTL_MS and positive after POSITIVE_TTL_MS", async () => {
    const t0 = 1_000_000;
    await passesLiquidityPrefilter(56, "0xdead", async () => stats(0), t0);
    await passesLiquidityPrefilter(56, "0xlive", async () => stats(500), t0);
    // Inside the TTLs: cache answers (probe fn would flip the answer if called).
    expect(await passesLiquidityPrefilter(56, "0xdead", async () => stats(1), t0 + NEGATIVE_TTL_MS - 1)).toBe(false);
    expect(await passesLiquidityPrefilter(56, "0xlive", async () => stats(0), t0 + POSITIVE_TTL_MS - 1)).toBe(true);
    // Past the TTLs: re-probes and flips.
    expect(await passesLiquidityPrefilter(56, "0xdead", async () => stats(1), t0 + NEGATIVE_TTL_MS)).toBe(true);
    expect(await passesLiquidityPrefilter(56, "0xlive", async () => stats(0), t0 + POSITIVE_TTL_MS)).toBe(false);
  });

  it("ARB_PREFILTER=false bypasses the gate entirely (no probe)", async () => {
    process.env.ARB_PREFILTER = "false";
    let calls = 0;
    const fn = async () => {
      calls++;
      return stats(0);
    };
    expect(await passesLiquidityPrefilter(56, "0xdead", fn)).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("evictToBound", () => {
  it("sweeps expired entries first, then evicts the oldest ~10% — never clears the whole map", () => {
    const now = 1_000_000;
    const m = new Map<string, { hasLiquidity: boolean; expiry: number }>();
    for (let i = 0; i < 60; i++) m.set(`exp${i}`, { hasLiquidity: false, expiry: now - 1 }); // expired
    for (let i = 0; i < 40; i++) m.set(`fresh${i}`, { hasLiquidity: true, expiry: now + 10_000 });
    evictToBound(m, 100, now);
    // The 60 expired entries are swept; the 40 fresh ones survive (no oldest-eviction needed).
    expect(m.size).toBe(40);
    expect([...m.keys()].every((k) => k.startsWith("fresh"))).toBe(true);

    // All fresh at the bound → drop only the oldest ~10%, keep the rest warm.
    const m2 = new Map<string, { hasLiquidity: boolean; expiry: number }>();
    for (let i = 0; i < 100; i++) m2.set(`k${i}`, { hasLiquidity: true, expiry: now + 10_000 });
    evictToBound(m2, 100, now);
    expect(m2.size).toBe(90);
    expect(m2.has("k0")).toBe(false); // oldest evicted
    expect(m2.has("k99")).toBe(true); // newest kept
  });

  it("caps the live cache at MAX_CACHE via insertion into passesLiquidityPrefilter", async () => {
    __clearPrefilterCache();
    const now = 1_000_000;
    for (let i = 0; i < MAX_CACHE + 10; i++) {
      await passesLiquidityPrefilter(1, `0x${i}`, async () => stats(0), now);
    }
    // No direct size accessor — the behavioral check: the newest entry is cached (answer without probe)…
    let probed = false;
    await passesLiquidityPrefilter(1, `0x${MAX_CACHE + 9}`, async () => {
      probed = true;
      return stats(1);
    }, now);
    expect(probed).toBe(false);
    // …while the very first entry was evicted (probe runs again).
    await passesLiquidityPrefilter(1, "0x0", async () => {
      probed = true;
      return stats(1);
    }, now);
    expect(probed).toBe(true);
  });
});
