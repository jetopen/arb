import { describe, it, expect } from "vitest";
import type { Address, PublicClient } from "viem";
import { simulateEvmSwap, SIM_SENDER } from "../sim/evm-sim";
import { balanceSlotKey, allowanceSlotKey, resolveErc20Slots, __clearSlotCache } from "../sim/slots";
import { __setPublicClient } from "../onchain/client";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // gateway native-token marker → no ERC20 override path
const ROUTER = "0x1111111111111111111111111111111111111111";

describe("simulateEvmSwap", () => {
  it("skips a non-EVM chain (no eth_call client)", async () => {
    const r = await simulateEvmSwap({ internalChainId: 7565164, tokenIn: NATIVE, to: ROUTER, data: "0x", builtVia: "debridge" });
    expect(r.status).toBe("skipped");
  });

  it("passes on a clean eth_call and funds the synthetic sender (native-in → no token override)", async () => {
    let captured: { account?: unknown; to?: unknown; value?: unknown; stateOverride?: Array<{ address: string; balance?: bigint }> } = {};
    __setPublicClient(42161, {
      call: async (a: typeof captured) => {
        captured = a;
        return { data: "0x" };
      },
    } as unknown as PublicClient);

    const r = await simulateEvmSwap({ internalChainId: 42161, tokenIn: NATIVE, to: ROUTER, data: "0xabcd", value: "0x16345785d8a0000", builtVia: "debridge" });
    expect(r.status).toBe("pass");
    expect(captured.account).toBe(SIM_SENDER);
    expect(captured.to).toBe(ROUTER);
    expect(captured.value).toBe(BigInt("0x16345785d8a0000"));
    // native input → only the sender balance override, no token stateDiff
    expect(captured.stateOverride).toHaveLength(1);
    expect(captured.stateOverride![0].address).toBe(SIM_SENDER);
    expect(typeof captured.stateOverride![0].balance).toBe("bigint");
  });

  it("reports revert (with the decoded reason) when eth_call throws", async () => {
    __setPublicClient(42161, {
      call: async () => {
        throw { shortMessage: "execution reverted: blacklisted" };
      },
    } as unknown as PublicClient);
    const r = await simulateEvmSwap({ internalChainId: 42161, tokenIn: NATIVE, to: ROUTER, data: "0x", builtVia: "debridge" });
    expect(r.status).toBe("revert");
    expect(r.reason).toMatch(/blacklisted/);
  });
});

describe("ERC20 storage-slot key derivation", () => {
  const HOLDER = "0x000000000000000000000000000000000000b0b0" as Address;
  const SPENDER = "0x000000000000000000000000000000000000c0de" as Address;

  it("produces a deterministic 32-byte key and distinguishes Solidity vs Vyper layout", () => {
    const sol = balanceSlotKey(HOLDER, { slot: 9, vyper: false });
    const vyp = balanceSlotKey(HOLDER, { slot: 9, vyper: true });
    expect(sol).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sol).toBe(balanceSlotKey(HOLDER, { slot: 9, vyper: false })); // stable
    expect(sol).not.toBe(vyp); // ordering matters
    // allowance is a nested mapping → a different (deterministic) slot from the balance mapping
    const allow = allowanceSlotKey(HOLDER, SPENDER, { slot: 10, vyper: false });
    expect(allow).toMatch(/^0x[0-9a-f]{64}$/);
    expect(allow).not.toBe(sol);
  });

  it("resolveErc20Slots runs the probe without a viem checksum throw (regression: synthetic prober address)", async () => {
    __clearSlotCache();
    // Echo the prober's sentinel back so the first candidate (slot 0, solidity) matches for both maps. This
    // exercises encodeFunctionData(balanceOf/allowance, [PROBE_*]) — which threw when the probers were
    // mixed-case addresses failing viem's EIP-55 check.
    const mock = {
      call: async ({ stateOverride }: { stateOverride?: Array<{ stateDiff?: Array<{ value: string }> }> }) => ({
        data: stateOverride?.[0]?.stateDiff?.[0]?.value,
      }),
    } as unknown as PublicClient;
    const slots = await resolveErc20Slots(mock, 42161, "0x000000000000000000000000000000000000dead" as Address);
    expect(slots).toEqual({ balance: { slot: 0, vyper: false }, allowance: { slot: 0, vyper: false } });
  });
});
