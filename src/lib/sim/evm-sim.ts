import { encodeFunctionData, pad, toHex, type Address, type Hex } from "viem";
import { getPublicClient } from "../onchain/client";
import { isEvmDeportChain, deBridgeGate } from "../deport/registry";
import { getFixedFeeWei, GATE_SEND_ABI } from "../onchain/debridge-gate";
import { resolveErc20Slots, balanceSlotKey, allowanceSlotKey } from "./slots";
import type { LegSim } from "./types";

/** Synthetic sim sender — funded with native + the input token via state overrides, never a real wallet.
 *  Used as both the eth_call `account` AND the build endpoint's senderAddress/recipient so calldata matches.
 *  MUST be all-lowercase: viem rejects mixed-case addresses that fail the EIP-55 checksum inside
 *  encodeFunctionData (all-lowercase is accepted as non-checksummed). */
export const SIM_SENDER = "0x000000000000000000000000000000000000a11c" as Address;

/** Large balance to hand the sim sender (gas + any native swap value). Below max to satisfy strict nodes. */
const FUND = 10n ** 27n;
/**
 * Value injected into the balance/allowance storage slots: 2^128−1. Huge for any probe trade, but with
 * the TOP BIT CLEAR — some tokens pack a flag into the high bit of the balance slot (USDC FiatTokenV2.2
 * stores the blacklist flag in bit 255), so a full 0xffff… would flip that flag and cause a false
 * "account is blacklisted" revert. A high-bit-clear value funds the balance without tripping packed flags.
 */
const BIG_SLOT_VALUE = pad(toHex((1n << 128n) - 1n), { size: 32 }) as Hex;

const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function isNativeIn(addr: string): boolean {
  const a = addr.toLowerCase();
  return a === NATIVE_SENTINEL || a === ZERO_ADDR;
}

type StateOverrideItem = { address: Address; balance?: bigint; stateDiff?: { slot: Hex; value: Hex }[] };

export interface EvmSwapSimArgs {
  internalChainId: number;
  /** input token of THIS swap (USDC for the buy leg; native/wnative for the sell leg). */
  tokenIn: string;
  to: string; // router (tx.to) — also the approval spender
  data: string; // calldata
  value?: string; // native value to attach (hex/decimal), "0" for ERC20-in
  builtVia: LegSim["builtVia"];
}

/** Pull a human-readable revert reason out of a viem call error. */
function extractRevert(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  return (err?.shortMessage || err?.details || err?.message || String(e)).slice(0, 300);
}

/**
 * Simulate a single DEX swap on an EVM chain via `eth_call` with state overrides (fund the input token
 * balance + approve the router, fund native for value/gas). Returns `pass` (no revert), `revert` (with a
 * decoded reason), or `skipped` (non-EVM chain, or the input token's storage slots couldn't be resolved —
 * an honest "unknown", never a false fail).
 */
export async function simulateEvmSwap(args: EvmSwapSimArgs): Promise<LegSim> {
  if (!isEvmDeportChain(args.internalChainId)) {
    return { status: "skipped", reason: "chain not eth_call-simulatable", builtVia: args.builtVia };
  }
  const client = getPublicClient(args.internalChainId);
  const to = args.to as Address;

  const overrides: StateOverrideItem[] = [{ address: SIM_SENDER, balance: FUND }];
  if (!isNativeIn(args.tokenIn)) {
    const slots = await resolveErc20Slots(client, args.internalChainId, args.tokenIn as Address);
    if (!slots) return { status: "skipped", reason: "input-token storage slots unresolved", builtVia: args.builtVia };
    overrides.push({
      address: args.tokenIn as Address,
      stateDiff: [
        { slot: balanceSlotKey(SIM_SENDER, slots.balance), value: BIG_SLOT_VALUE },
        { slot: allowanceSlotKey(SIM_SENDER, to, slots.allowance), value: BIG_SLOT_VALUE },
      ],
    });
  }

  try {
    let txValue: bigint | undefined;
    try { txValue = args.value ? BigInt(args.value) : undefined; } catch { txValue = undefined; }
    await client.call({
      account: SIM_SENDER,
      to,
      data: args.data as Hex,
      value: txValue,
      stateOverride: overrides,
    });
    return { status: "pass", builtVia: args.builtVia };
  } catch (e) {
    return { status: "revert", reason: extractRevert(e), builtVia: args.builtVia };
  }
}

export interface SendSimArgs {
  /** origin chain (= buyChain — where we hold the bought token and initiate the dePort move). */
  buyChainId: number;
  /** the bought token on the origin chain (deAsset for a redemption; native for home→rep). */
  token: string;
  /** raw base units to lock/burn (= buyLeg.amountOut). */
  amount: string;
  /** destination internal chain id (= sellChain). */
  chainIdTo: number;
  debridgeId: string;
}

/**
 * Simulate the origin-chain dePort `send()` via state-override eth_call: fund the bought token + approve
 * the gate, attach the flat fee as msg.value, and call `gate.send`. Catches deAsset-side reverts (the
 * token can't be burned/locked). EXPERIMENTAL — full-`send` semantics (fee/receiver/dest validation) can
 * cause false reverts, so it ships behind ARB_SIMULATE_SEND. Degrades to `skipped` (never throws).
 */
export async function simulateSend(args: SendSimArgs): Promise<LegSim> {
  if (!isEvmDeportChain(args.buyChainId)) return { status: "skipped", reason: "origin not eth_call-simulatable" };
  if (!isEvmDeportChain(args.chainIdTo))
    return { status: "skipped", reason: "non-EVM destination: SIM_SENDER bytes encoding invalid for Solana/Tron receiver" };
  const client = getPublicClient(args.buyChainId);
  const gate = deBridgeGate(args.buyChainId) as Address;

  // send() requires msg.value to cover the flat protocol fee (useAssetFee=false). Without a known fee we
  // can't build a faithful tx → skip rather than risk a false "fee not covered" revert.
  let feeWei: bigint;
  try {
    feeWei = await getFixedFeeWei(args.buyChainId, args.debridgeId as Hex);
  } catch {
    return { status: "skipped", reason: "fixed-fee read failed (send needs msg.value)" };
  }
  if (feeWei <= 0n) return { status: "skipped", reason: "no fixed fee available for send value" };

  let amount: bigint;
  try {
    amount = BigInt(args.amount);
  } catch {
    return { status: "skipped", reason: "unparseable send amount" };
  }

  const native = isNativeIn(args.token);
  const data = encodeFunctionData({
    abi: GATE_SEND_ABI,
    functionName: "send",
    args: [
      (native ? ZERO_ADDR : args.token) as Address, // address(0) == native to the gate
      amount,
      BigInt(args.chainIdTo),
      SIM_SENDER, // receiver bytes (20-byte EVM addr); non-EVM dests encode differently → see ARB_SIMULATE_SEND caveat
      "0x", // permitEnvelope
      false, // useAssetFee → pay protocol fee in native via msg.value
      0, // referralCode
      "0x", // autoParams
    ],
  });
  const value = native ? amount + feeWei : feeWei;

  const overrides: StateOverrideItem[] = [{ address: SIM_SENDER, balance: FUND }];
  if (!native) {
    const slots = await resolveErc20Slots(client, args.buyChainId, args.token as Address);
    if (!slots) return { status: "skipped", reason: "input-token storage slots unresolved" };
    overrides.push({
      address: args.token as Address,
      stateDiff: [
        { slot: balanceSlotKey(SIM_SENDER, slots.balance), value: BIG_SLOT_VALUE },
        { slot: allowanceSlotKey(SIM_SENDER, gate, slots.allowance), value: BIG_SLOT_VALUE },
      ],
    });
  }

  try {
    await client.call({ account: SIM_SENDER, to: gate, data, value, stateOverride: overrides });
    return { status: "pass" };
  } catch (e) {
    return { status: "revert", reason: extractRevert(e) };
  }
}
