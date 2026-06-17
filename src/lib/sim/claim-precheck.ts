import type { Hex } from "viem";
import { isEvmDeportChain, getChainByInternalId } from "../deport/registry";
import { readDebridgeInfo } from "../onchain/debridge-gate";
import { getNativeUsd } from "../quotes/native-price";
import type { ClaimPrecheck } from "./types";

/**
 * Destination-chain dePort claim precheck.
 *
 * A real claim can't be eth_call'd cold (the validator signatures that authorize it are gathered only
 * AFTER the origin send()), so instead we READ the gate's live reserve/limit state on the destination and
 * judge whether the redemption could be honored.
 *
 * Two claim shapes, and we only block on the one we can judge with confidence:
 *  - RELEASE leg (sell chain == the family's native/home chain): the claim UNLOCKS native from the gate's
 *    reserves. `balance`, `lockedInStrategies` and `maxAmount` are all in native units here and line up
 *    with the bridged amount, so we check exist + cap + idle reserves (balance − lockedInStrategies). We
 *    deliberately do NOT gate on `minReservesBps` — its live value is often 10000 (100%), which would
 *    false-fail every redemption; idle-vs-amount is the high-confidence reserve signal.
 *  - MINT leg (sell chain is a deAsset rep): the claim MINTS a representation 1:1 — unconstrained by
 *    reserves — so we only assert the asset `exist`s and don't risk a false "fail" on uncertain units.
 *
 * Quote-only destination chains (no viem client / gate) → `skipped`. Never throws.
 */
export async function claimPrecheck(args: {
  /** destination chain where the claim lands (the sell chain). */
  sellChainId: number;
  debridgeId: string;
  /** native base units the claim must release (= the bridged / sellAmountIn). */
  bridgedAmount: string;
}): Promise<ClaimPrecheck> {
  if (!isEvmDeportChain(args.sellChainId)) {
    return { status: "skipped", reason: "destination is a quote-only chain (no gate read)" };
  }

  let info;
  try {
    info = await readDebridgeInfo(args.sellChainId, args.debridgeId as Hex);
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? String(e);
    return { status: "skipped", reason: `gate read failed: ${msg.slice(0, 160)}` };
  }

  if (!info.exist) return { status: "fail", reason: "asset not registered on destination gate" };

  let amount: bigint;
  try {
    amount = BigInt(args.bridgedAmount);
  } catch {
    return { status: "skipped", reason: "unparseable bridged amount" };
  }

  const chain = getChainByInternalId(args.sellChainId);
  const nativeDecimals = chain?.nativeDecimals ?? 18;
  const nativeUsd = await getNativeUsd(args.sellChainId).catch(() => 0);
  const toUsd = (wei: bigint): number | undefined =>
    nativeUsd > 0 ? (Number(wei) / 10 ** nativeDecimals) * nativeUsd : undefined;

  const idle = info.balance > info.lockedInStrategies ? info.balance - info.lockedInStrategies : 0n;
  const idleReserveUsd = toUsd(idle);
  const maxAmountUsd = info.maxAmount > 0n ? toUsd(info.maxAmount) : undefined;

  // RELEASE leg: the sell chain is the family's home chain → the claim unlocks from reserves.
  const isReleaseLeg = args.sellChainId === info.nativeChainId;

  if (isReleaseLeg) {
    if (info.maxAmount > 0n && amount > info.maxAmount) {
      return { status: "fail", reason: "amount exceeds per-asset transfer cap (maxAmount)", idleReserveUsd, maxAmountUsd };
    }
    if (idle < amount) {
      return { status: "fail", reason: "idle gate reserves below redemption amount", idleReserveUsd, maxAmountUsd };
    }
  }
  // MINT leg: representation is minted 1:1, unconstrained by reserves — exist already passed.
  return { status: "pass", idleReserveUsd, maxAmountUsd };
}
