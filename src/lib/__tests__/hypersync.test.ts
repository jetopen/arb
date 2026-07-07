import { describe, it, expect, vi, afterEach } from "vitest";
import { hyperSyncSupported, TRANSFER_TOPIC0 } from "../hypersync/chains";
import {
  buildActivityQuery,
  extractLogs,
  aggregateActivity,
  getHeight,
  getChainActivity,
} from "../hypersync/client";

describe("hyperSyncSupported", () => {
  afterEach(() => {
    delete process.env.ENVIO_API_TOKEN;
  });

  it("requires both a token and a HyperSync-served chain", () => {
    delete process.env.ENVIO_API_TOKEN;
    expect(hyperSyncSupported(56)).toBe(false); // no token
    process.env.ENVIO_API_TOKEN = "t";
    expect(hyperSyncSupported(56)).toBe(true); // BSC
    expect(hyperSyncSupported(8453)).toBe(true); // Base
    expect(hyperSyncSupported(100000022)).toBe(true); // HyperEVM (internal id)
    expect(hyperSyncSupported(100000019)).toBe(false); // Cronos — gap
    expect(hyperSyncSupported(100000009)).toBe(false); // Flow — gap
    expect(hyperSyncSupported(7565164)).toBe(false); // Solana — non-EVM
    expect(hyperSyncSupported(100000026)).toBe(false); // Tron — non-EVM
  });
});

describe("buildActivityQuery (pure)", () => {
  it("filters by the lowercased address array + Transfer topic0 and selects address/block_number", () => {
    const q = buildActivityQuery(["0xAbC", "0xDeF"], 100, 200);
    expect(q.from_block).toBe(100);
    expect(q.to_block).toBe(201); // exclusive upper bound → +1 to include the tip
    expect(q.logs[0].address).toEqual(["0xabc", "0xdef"]);
    expect(q.logs[0].topics).toEqual([[TRANSFER_TOPIC0]]);
    expect(q.field_selection.log).toContain("address");
    expect(q.field_selection.log).toContain("block_number");
  });
});

describe("extractLogs (pure)", () => {
  it("handles data as an array of block-range batches", () => {
    const logs = extractLogs({
      data: [
        { logs: [{ address: "0xAA", block_number: 5 }] },
        { logs: [{ address: "0xBB", block_number: 7 }] },
      ],
    });
    expect(logs).toHaveLength(2);
  });

  it("handles data as an object with a logs array", () => {
    const logs = extractLogs({ data: { logs: [{ address: "0xAA", block_number: 9 }] } });
    expect(logs).toHaveLength(1);
  });

  it("returns [] for empty / missing data", () => {
    expect(extractLogs({ data: [] })).toEqual([]);
    expect(extractLogs({})).toEqual([]);
  });
});

describe("aggregateActivity (pure)", () => {
  it("counts transfers per lowercased address and tracks the last block", () => {
    const m = aggregateActivity([
      { address: "0xAA", block_number: 3 },
      { address: "0xaa", block_number: 5 },
      { address: "0xBB", block_number: 2 },
    ]);
    expect(m.get("0xaa")).toEqual({ transferCount: 2, lastBlock: 5 });
    expect(m.get("0xbb")).toEqual({ transferCount: 1, lastBlock: 2 });
  });

  it("accumulates across pages into the same map", () => {
    const m = aggregateActivity([{ address: "0xAA", block_number: 3 }]);
    aggregateActivity([{ address: "0xAA", block_number: 8 }], m);
    expect(m.get("0xaa")).toEqual({ transferCount: 2, lastBlock: 8 });
  });
});

describe("getHeight", () => {
  afterEach(() => {
    delete process.env.ENVIO_API_TOKEN;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns null without a token, without calling fetch", async () => {
    delete process.env.ENVIO_API_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getHeight(56)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hits /height with a Bearer token and parses the height", async () => {
    process.env.ENVIO_API_TOKEN = "test-token";
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        return { ok: true, status: 200, json: async () => ({ height: 42_000_000 }) } as unknown as Response;
      })
    );
    expect(await getHeight(56)).toBe(42_000_000);
    expect(calls[0].url).toBe("https://bsc.hypersync.xyz/height");
    expect(calls[0].headers.Authorization).toBe("Bearer test-token");
  });

  it("returns null on a non-OK response (fail-open)", async () => {
    process.env.ENVIO_API_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response));
    expect(await getHeight(56)).toBeNull();
  });
});

describe("getChainActivity", () => {
  afterEach(() => {
    delete process.env.ENVIO_API_TOKEN;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns null without a token / empty addresses, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getChainActivity(56, ["0xAA"], 0, 100)).toBeNull(); // no token
    process.env.ENVIO_API_TOKEN = "t";
    expect(await getChainActivity(56, [], 0, 100)).toBeNull(); // no addresses
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("paginates on next_block and aggregates across pages", async () => {
    process.env.ENVIO_API_TOKEN = "t";
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ logs: [{ address: "0xAA", block_number: 10 }] }], next_block: 100 }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ logs: [{ address: "0xAA", block_number: 150 }] }], next_block: 201 }),
        } as unknown as Response;
      })
    );
    const m = await getChainActivity(1, ["0xAA"], 0, 200);
    expect(call).toBe(2);
    expect(m!.get("0xaa")).toEqual({ transferCount: 2, lastBlock: 150 });
  });

  it("returns null when the first request fails (fail-open, never marks dead)", async () => {
    process.env.ENVIO_API_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response));
    expect(await getChainActivity(1, ["0xAA"], 0, 200)).toBeNull();
  });

  it("stops at maxPages so a very active address can't loop forever", async () => {
    process.env.ENVIO_API_TOKEN = "t";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      // next_block always advances by 1 but never reaches the end → bounded only by maxPages
      json: async () => ({ data: [{ logs: [{ address: "0xAA", block_number: 1 }] }], next_block: 2 }),
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    // next_block=2 <= cursor after first page? cursor becomes 2, then 2<=... stays; capped at maxPages
    await getChainActivity(1, ["0xAA"], 0, 1_000_000, { maxPages: 3 });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("throttles sequential calls (getHeight) to the min interval", async () => {
    process.env.ENVIO_API_TOKEN = "t";
    vi.useFakeTimers();
    // Jump past any module-level throttle state left by earlier tests so the first delay is deterministically 0.
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ height: 1 }) }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const p1 = getHeight(1);
    const p2 = getHeight(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.length).toBe(1); // first fires immediately

    await vi.advanceTimersByTimeAsync(150); // before the 200ms (RPS=5) interval
    expect(fetchMock.mock.calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(100); // crossing the interval releases the second
    await Promise.all([p1, p2]);
    expect(fetchMock.mock.calls.length).toBe(2);
  });
});
