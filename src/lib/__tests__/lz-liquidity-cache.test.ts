import { describe, it, expect } from "vitest";
import { evictToBound } from "../../app/api/lz/liquidity/route";

/**
 * Fix #11: when the liquidity cache is full, eviction must drop only the OLDEST slice (insertion order),
 * NOT cache.clear() the whole thing — a full wipe triggers a re-fetch storm against rate-limited
 * GeckoTerminal. evictToBound is the extracted pure helper.
 */

function fullCache(n: number, expiry: number): Map<string, { value: number | null; expiry: number }> {
  const m = new Map<string, { value: number | null; expiry: number }>();
  for (let i = 0; i < n; i++) m.set(`k${i}`, { value: i, expiry });
  return m;
}

describe("evictToBound (lz liquidity cache, fix #11)", () => {
  const MAX = 100;
  const now = 1_000_000;

  it("is a no-op when under the bound", () => {
    const m = fullCache(50, now + 10_000);
    evictToBound(m, MAX, now);
    expect(m.size).toBe(50);
  });

  it("sweeps expired entries first when full", () => {
    const m = new Map<string, { value: number | null; expiry: number }>();
    for (let i = 0; i < 60; i++) m.set(`exp${i}`, { value: i, expiry: now - 1 }); // expired
    for (let i = 0; i < 40; i++) m.set(`fresh${i}`, { value: i, expiry: now + 10_000 }); // fresh
    expect(m.size).toBe(100); // at MAX
    evictToBound(m, MAX, now);
    // The 60 expired entries are swept; the 40 fresh ones survive (no full clear needed).
    expect(m.size).toBe(40);
    expect(m.has("fresh0")).toBe(true);
    expect(m.has("exp0")).toBe(false);
  });

  it("evicts the OLDEST ~10% (NOT a full clear) when full of fresh entries", () => {
    const m = fullCache(MAX, now + 10_000); // all fresh, at MAX
    evictToBound(m, MAX, now);
    // Drops ceil(10% of 100)=10 oldest → 90 remain (definitely NOT 0 / a full wipe).
    expect(m.size).toBe(90);
    // The oldest 10 (k0..k9) are gone; the rest (k10..k99) survive in order.
    expect(m.has("k0")).toBe(false);
    expect(m.has("k9")).toBe(false);
    expect(m.has("k10")).toBe(true);
    expect(m.has("k99")).toBe(true);
    expect([...m.keys()][0]).toBe("k10"); // front is now the next-oldest
  });

  it("always frees room so a subsequent set stays within bound", () => {
    const m = fullCache(MAX, now + 10_000);
    evictToBound(m, MAX, now);
    m.set("new", { value: 1, expiry: now + 10_000 });
    expect(m.size).toBeLessThanOrEqual(MAX);
    expect(m.has("new")).toBe(true);
  });
});
