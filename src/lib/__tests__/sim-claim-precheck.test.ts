import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PublicClient } from "viem";
import { claimPrecheck } from "../sim/claim-precheck";
import { __setPublicClient } from "../onchain/client";

// getDebridge tuple: [nativeChainId, maxAmount, balance, lockedInStrategies, tokenAddress, minReservesBps, exist]
type Tuple = readonly [bigint, bigint, bigint, bigint, string, number, boolean];
function mockGate(tuple: Tuple): PublicClient {
  return { readContract: async () => tuple } as unknown as PublicClient;
}

const TOKEN = "0x1111111111111111111111111111111111111111";

describe("claimPrecheck", () => {
  beforeEach(() => {
    // getNativeUsd() hits DefiLlama for the USD valuation — stub fetch so the unit test never touches network
    // (it catches failure → 0, leaving the USD fields undefined; the pass/fail logic is USD-independent).
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as Response));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("skips a quote-only destination chain (no gate to read)", async () => {
    const r = await claimPrecheck({ sellChainId: 7565164, debridgeId: "0xd", bridgedAmount: "1" }); // Solana
    expect(r.status).toBe("skipped");
  });

  it("fails when the asset is not registered on the destination gate (exist=false)", async () => {
    __setPublicClient(42161, mockGate([42161n, 0n, 0n, 0n, TOKEN, 0, false]));
    const r = await claimPrecheck({ sellChainId: 42161, debridgeId: "0xd", bridgedAmount: "1000" });
    expect(r.status).toBe("fail");
    expect(r.reason).toMatch(/not registered/i);
  });

  it("RELEASE leg: fails when idle reserves (balance − lockedInStrategies) are below the redemption amount", async () => {
    // sell chain == native chain (42161) → release leg. balance 100, locked 0 → idle 100 < amount 200.
    __setPublicClient(42161, mockGate([42161n, 0n, 100n, 0n, TOKEN, 0, true]));
    const r = await claimPrecheck({ sellChainId: 42161, debridgeId: "0xd", bridgedAmount: "200" });
    expect(r.status).toBe("fail");
    expect(r.reason).toMatch(/idle gate reserves/i);
  });

  it("RELEASE leg: fails when the amount exceeds the per-asset transfer cap (maxAmount)", async () => {
    // maxAmount 50, amount 100, but idle is plenty — the cap is what trips.
    __setPublicClient(42161, mockGate([42161n, 50n, 10_000n, 0n, TOKEN, 0, true]));
    const r = await claimPrecheck({ sellChainId: 42161, debridgeId: "0xd", bridgedAmount: "100" });
    expect(r.status).toBe("fail");
    expect(r.reason).toMatch(/cap|maxAmount/i);
  });

  it("RELEASE leg: passes when idle reserves cover the amount and no cap is breached", async () => {
    __setPublicClient(42161, mockGate([42161n, 0n, 10n ** 24n, 0n, TOKEN, 0, true]));
    const r = await claimPrecheck({ sellChainId: 42161, debridgeId: "0xd", bridgedAmount: (10n ** 18n).toString() });
    expect(r.status).toBe("pass");
  });

  it("MINT leg: passes on exist alone (reserves don't constrain a 1:1 mint) even with zero balance", async () => {
    // sell chain (42161) != native chain (56) → mint leg. balance 0 must NOT cause a false fail.
    __setPublicClient(42161, mockGate([56n, 0n, 0n, 0n, TOKEN, 0, true]));
    const r = await claimPrecheck({ sellChainId: 42161, debridgeId: "0xd", bridgedAmount: (10n ** 18n).toString() });
    expect(r.status).toBe("pass");
  });

  it("skips (not fails) when the gate read throws — an infra error is unknown, not broken", async () => {
    __setPublicClient(42161, {
      readContract: async () => {
        throw new Error("rpc down");
      },
    } as unknown as PublicClient);
    const r = await claimPrecheck({ sellChainId: 42161, debridgeId: "0xd", bridgedAmount: "1" });
    expect(r.status).toBe("skipped");
  });
});
