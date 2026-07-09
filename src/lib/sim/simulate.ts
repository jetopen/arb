import { SOLANA_INTERNAL_ID, SOLANA_USDC_MINT, isEvmDeportChain } from "../deport/registry";
import { buildDebridgeSwapTx } from "./build/build-debridge";
import { simulateEvmSwap, simulateSend, SIM_SENDER } from "./evm-sim";
import { simulateSolanaSwap } from "./solana-sim";
import { claimPrecheck } from "./claim-precheck";
import type { ClaimPrecheck, LegSim, SimulationResult } from "./types";

/** The origin send() sim is EXPERIMENTAL (can false-revert on fee/receiver/dest validation) → opt-in. */
function sendSimEnabled(): boolean {
  return process.env.ARB_SIMULATE_SEND === "true";
}

export interface SimulateArgs {
  kind: "redemption" | "cross_rep";
  debridgeId: string;
  // buy leg: USDC -> deAsset on buyChain
  buyChainId: number;
  buyUsdc: string;
  buyToken: string;
  amountIn: string;
  // sell leg: native -> USDC on sellChain
  sellChainId: number;
  sellToken: string;
  sellUsdc: string;
  sellAmountIn: string; // = bridged (buy output rescaled to sell decimals)
  // recommended DEX slippage per leg (bps), used when building the executable tx
  buySlippageBps?: number;
  sellSlippageBps?: number;
  /** buy leg output (deAsset base units) — the amount the origin send() would lock (Phase C). */
  buyAmountOut?: string;
  apiKey?: string;
}

const skip = (reason: string): LegSim => ({ status: "skipped", reason });

/**
 * Simulate one DEX swap leg: build the executable tx (deBridge transaction endpoint), then eth_call it
 * with state overrides. Best-effort — a build failure or non-EVM chain returns `skipped`, never throws.
 */
async function simulateSwapLeg(
  internalChainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippageBps: number | undefined,
  apiKey: string | undefined
): Promise<LegSim> {
  if (internalChainId === SOLANA_INTERNAL_ID) {
    // No balance state-override on Solana → only the USDC-input (buy) leg can be funded via a known holder.
    const holder = process.env.ARB_SOL_USDC_HOLDER;
    const inputIsUsdc = tokenIn === SOLANA_USDC_MINT;
    if (!inputIsUsdc) return skip("Solana sell-leg sim unsupported (no funded holder for the deAsset)");
    if (!holder) return skip("Solana sim needs ARB_SOL_USDC_HOLDER (a USDC holder) configured");
    return simulateSolanaSwap({ tokenIn, tokenOut, amountIn, holder, slippageBps });
  }
  if (!isEvmDeportChain(internalChainId)) return skip("chain not eth_call-simulatable");
  let built;
  try {
    built = await buildDebridgeSwapTx({ internalChainId, tokenIn, tokenOut, amountIn, sender: SIM_SENDER, slippageBps, apiKey });
  } catch (e) {
    const err = e as { message?: string };
    return skip(`build failed: ${(err?.message || String(e)).slice(0, 200)}`);
  }
  if (!built.to) return skip("no EVM tx target in build");
  return simulateEvmSwap({ internalChainId, tokenIn, to: built.to, data: built.data, value: built.value, builtVia: "debridge" });
}

/**
 * Combine the per-leg outcomes into the route verdict. A `skipped` leg is UNKNOWN and never blocks; a
 * single `revert` / claim `fail` blocks; all-skipped → null (UI "sim n/a").
 */
export function verdict(legs: LegSim[], claim: ClaimPrecheck): boolean | null {
  const statuses = [...legs.map((l) => l.status), claim.status];
  if (statuses.some((s) => s === "revert" || s === "fail")) return false;
  if (statuses.some((s) => s === "pass")) return true;
  return null;
}

/**
 * Simulate the full executable arb path and produce a `SimulationResult`. Phase A covers the two DEX swaps
 * (buy + sell); the claim precheck (Phase B) and origin send() sim (Phase C) plug into the same verdict.
 * Never throws — every leg degrades to `skipped` on infra error.
 */
export async function simulateOpportunity(args: SimulateArgs): Promise<SimulationResult> {
  const sendP: Promise<LegSim> = sendSimEnabled()
    ? args.buyAmountOut === undefined
      ? Promise.resolve(skip("send() sim skipped: buy output amount unknown"))
      : simulateSend({
          buyChainId: args.buyChainId,
          token: args.buyToken,
          amount: args.buyAmountOut,
          chainIdTo: args.sellChainId,
          debridgeId: args.debridgeId,
        }).catch((e): LegSim => skip(`send sim error: ${(e as Error)?.message?.slice(0, 160) ?? String(e)}`))
    : Promise.resolve(skip("send() sim disabled (ARB_SIMULATE_SEND)"));

  const [buy, sell, claim, send] = await Promise.all([
    simulateSwapLeg(args.buyChainId, args.buyUsdc, args.buyToken, args.amountIn, args.buySlippageBps, args.apiKey),
    simulateSwapLeg(args.sellChainId, args.sellToken, args.sellUsdc, args.sellAmountIn, args.sellSlippageBps, args.apiKey),
    claimPrecheck({ sellChainId: args.sellChainId, debridgeId: args.debridgeId, bridgedAmount: args.sellAmountIn }).catch(
      (e): ClaimPrecheck => ({ status: "skipped", reason: `precheck error: ${(e as Error)?.message?.slice(0, 160) ?? String(e)}` })
    ),
    sendP,
  ]);
  return { executable: verdict([buy, sell, send], claim), buy, sell, send, claim, simulatedAt: Date.now() };
}
