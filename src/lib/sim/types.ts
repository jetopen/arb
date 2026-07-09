/**
 * Transaction-simulation result model.
 *
 * A quote can be profitable yet REVERT at execution time — transfer-tax / blacklist / paused / honeypot
 * tokens on the swaps, or an un-honorable redemption on the claim. The scanner simulates the executable
 * path best-effort and attaches this so the screener can separate genuine, executable edges from phantom
 * ones — WITHOUT hiding routes we simply can't simulate.
 *
 * Honesty rules baked into the verdict:
 *  - `skipped` (no build endpoint / quote-only chain / unresolved storage slot) NEVER flips `executable`
 *    to false — an un-simulatable leg is *unknown*, not broken.
 *  - a single `revert` / claim `fail` DOES flip it to false.
 *  - `executable: null` means nothing on the route could be simulated → UI badge "sim n/a".
 */

export type LegStatus = "pass" | "revert" | "skipped";

/** Result of simulating one DEX swap leg (or the origin gate send()). */
export interface LegSim {
  status: LegStatus;
  /** Decoded revert reason when status === "revert", or why it was skipped. */
  reason?: string;
  /** Gas used (EVM) as a decimal string, when the sim actually ran. */
  gasUsed?: string;
  /** Which builder produced the tx that was simulated. */
  builtVia?: "debridge" | "kyberswap" | "jupiter";
}

/**
 * Destination-chain dePort claim precheck. A real claim can't be eth_call'd cold (it needs validator
 * signatures gathered AFTER the origin send()), so instead we READ the gate's live reserve/limit state
 * (`getDebridge`) and judge whether the redemption could be honored.
 */
export interface ClaimPrecheck {
  status: "pass" | "fail" | "skipped";
  reason?: string;
  /** Idle gate reserves on the destination chain (balance − lockedInStrategies), valued in USD. */
  idleReserveUsd?: number;
  /** Per-asset transfer cap (maxAmount), valued in USD. */
  maxAmountUsd?: number;
}

export interface SimulationResult {
  /** true = every SIMULATABLE leg passed and the claim is honorable; false = some leg reverted / claim
   *  failed; null = nothing on the route could be simulated. */
  executable: boolean | null;
  /** buy DEX swap (USDC → deAsset). */
  buy: LegSim;
  /** sell DEX swap (native → USDC). */
  sell: LegSim;
  /** origin-chain gate send() state-override sim — the executable side of the claim we CAN test cold. */
  send: LegSim;
  /** destination-chain gate reserve/limit precheck — the side we can only READ, not eth_call. */
  claim: ClaimPrecheck;
  simulatedAt: number;
}
