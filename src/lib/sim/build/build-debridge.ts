import { fetchWithRetry } from "../../api-client";
import { QuoteHttpError } from "../../quotes/quote-error";
import { DLN_BASE } from "../../quotes/debridge";

/** An executable single-chain swap transaction. EVM: {to,data,value}. Solana: {data} = hex serialized tx. */
export interface BuiltTx {
  /** EVM: target contract (DeBridgeRouter), also the token-approval spender. Solana: undefined. */
  to?: string;
  /** EVM: calldata hex. Solana: hex-encoded serialized VersionedTransaction. */
  data: string;
  /** EVM native value to attach (hex or decimal string); "0" for ERC20-in swaps. */
  value?: string;
  /** Estimated output amount (base units), echoed for an optional output-vs-quote cross-check. */
  amountOut?: string;
}

/**
 * Build an executable single-chain swap tx via deBridge `/v1.0/chain/transaction`. Because it is the
 * build-twin of `/v1.0/chain/estimation` (the endpoint the scanner quotes with), the built tx matches the
 * quoted route, and it covers EVERY deBridge-quotable chain — EVM calldata to DeBridgeRouter, or a Solana
 * serialized tx. `sender` is the synthetic sim address (used as both senderAddress and tokenOutRecipient).
 *
 * Throws `QuoteHttpError` on non-2xx so the caller can treat 5xx/429 as transient and a 4xx as "no build"
 * (→ leg `skipped`, never a false `revert`).
 */
export async function buildDebridgeSwapTx(args: {
  internalChainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  sender: string;
  /** DEX slippage in bps; <=0 / undefined → deBridge "auto". */
  slippageBps?: number;
  apiKey?: string;
}): Promise<BuiltTx> {
  const slippage = args.slippageBps != null && args.slippageBps > 0 ? (args.slippageBps / 100).toString() : "auto";
  const url =
    `${DLN_BASE}/v1.0/chain/transaction?chainId=${args.internalChainId}` +
    `&tokenIn=${args.tokenIn}&tokenInAmount=${args.amountIn}&tokenOut=${args.tokenOut}` +
    `&senderAddress=${args.sender}&tokenOutRecipient=${args.sender}&slippage=${slippage}`;
  const res = await fetchWithRetry(url, { method: "GET" }, { apiKey: args.apiKey });
  if (!res.ok) throw new QuoteHttpError(res.status, `chain/transaction ${res.status} for chain ${args.internalChainId}`);
  const json = (await res.json()) as {
    tx?: { to?: string; data?: string; value?: string };
    estimation?: { tokenOut?: { amount?: string } };
  };
  const tx = json.tx;
  if (!tx || !tx.data) throw new QuoteHttpError(502, `chain/transaction: missing tx.data for chain ${args.internalChainId}`);
  return { to: tx.to, data: tx.data, value: tx.value, amountOut: json.estimation?.tokenOut?.amount };
}
