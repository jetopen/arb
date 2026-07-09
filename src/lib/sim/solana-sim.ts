import { buildJupiterSwapTx } from "./build/build-jupiter";
import type { LegSim } from "./types";

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

/**
 * Simulate a Solana swap via Jupiter + the RPC `simulateTransaction`.
 *
 * Honest limitation: Solana `simulateTransaction` has NO balance state-override (unlike EVM `eth_call`),
 * so the simulated transaction's input-token balance must really exist. We therefore build the swap for a
 * configured HOLDER of the input token (`userPublicKey`) and simulate unsigned (`sigVerify:false`,
 * `replaceRecentBlockhash:true`). This works for the BUY leg (USDC input → a USDC whale holds it) but not
 * the sell leg (selling a deAsset no whale holds) — the caller skips that. Best-effort: returns `skipped`
 * on any infra error, never throws.
 */
export async function simulateSolanaSwap(args: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  holder: string;
  slippageBps?: number;
}): Promise<LegSim> {
  let swapTx: string;
  try {
    swapTx = await buildJupiterSwapTx({ tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountIn: args.amountIn, userPublicKey: args.holder, slippageBps: args.slippageBps });
  } catch (e) {
    return { status: "skipped", reason: `jupiter build failed: ${(e as Error)?.message?.slice(0, 160) ?? String(e)}`, builtVia: "jupiter" };
  }

  try {
    const res = await fetch(SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: [swapTx, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" }],
      }),
    });
    if (!res.ok) return { status: "skipped", reason: `solana rpc ${res.status}`, builtVia: "jupiter" };
    const json = (await res.json()) as {
      result?: { value?: { err?: unknown; logs?: string[]; unitsConsumed?: number } };
      error?: { message?: string };
    };
    if (json.error) return { status: "skipped", reason: `solana rpc error: ${json.error.message ?? "unknown"}`, builtVia: "jupiter" };
    const value = json.result?.value;
    if (!value) return { status: "skipped", reason: "solana sim: empty result", builtVia: "jupiter" };
    if (value.err == null) {
      return { status: "pass", gasUsed: value.unitsConsumed != null ? String(value.unitsConsumed) : undefined, builtVia: "jupiter" };
    }
    // A program error → the swap would revert. Surface the error + the last log line for context.
    const lastLog = value.logs?.length ? value.logs[value.logs.length - 1] : "";
    const reason = `${typeof value.err === "string" ? value.err : JSON.stringify(value.err)}${lastLog ? ` | ${lastLog}` : ""}`;
    return { status: "revert", reason: reason.slice(0, 300), builtVia: "jupiter" };
  } catch (e) {
    return { status: "skipped", reason: `solana sim error: ${(e as Error)?.message?.slice(0, 160) ?? String(e)}`, builtVia: "jupiter" };
  }
}
