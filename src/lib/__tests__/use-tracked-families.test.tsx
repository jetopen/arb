import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useTrackedFamilies } from "../hooks";
import type { GraphDetailResponse } from "../hooks";

/**
 * Fix #12: toggling "Multi-chain only" changes the SWR key. Without keepPreviousData the hook drops to
 * `data === undefined` (full skeleton) on every toggle. With it, the previous rows stay visible while
 * the new request is in flight. We drive the hook with renderHook + a controllable fetch.
 */

function resp(total: number): GraphDetailResponse {
  return { families: [], total, page: 1, take: 250, partial: false, builtAt: 0, chainsScanned: [] };
}

// Fresh isolated SWR cache per test so keys don't leak between tests.
function wrapper({ children }: { children: React.ReactNode }) {
  return createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useTrackedFamilies keepPreviousData (fix #12)", () => {
  it("keeps the previous data across a key change (multiChainOnly toggle) instead of going undefined", async () => {
    // Resolve fetch based on the requested URL: the all-families key vs the multiChainOnly key.
    let releaseSecond: () => void = () => {};
    const secondGate = new Promise<void>((r) => (releaseSecond = r));
    const fetchMock = vi.fn(async (url: string) => {
      const isMulti = url.includes("multiChainOnly=1");
      if (isMulti) await secondGate; // hold the second response in-flight so we can observe the gap
      return { ok: true, json: async () => resp(isMulti ? 7 : 42) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(({ multi }: { multi: boolean }) => useTrackedFamilies({ multiChainOnly: multi }), {
      wrapper,
      initialProps: { multi: false },
    });

    // First load resolves to the all-families set.
    await waitFor(() => expect(result.current.data?.total).toBe(42));

    // Flip the toggle → new SWR key, second fetch is held in-flight.
    rerender({ multi: true });

    // The crux of the fix: previous rows remain (data is NOT undefined) while revalidating the new key.
    await waitFor(() => expect(result.current.isValidating).toBe(true));
    expect(result.current.data?.total).toBe(42); // previous data kept, not dropped to undefined

    // Once the second response lands, the hook shows the new set.
    releaseSecond();
    await waitFor(() => expect(result.current.data?.total).toBe(7));
  });
});
