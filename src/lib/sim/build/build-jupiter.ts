import { QuoteHttpError } from "../../quotes/quote-error";

// Jupiter swap API. The /swap endpoint needs the FULL quoteResponse object from /quote (not just amounts,
// which is all the scanner's quoter keeps), so we re-fetch the quote here for sim candidates.
const LITE_BASE = "https://lite-api.jup.ag/swap/v1";
const PRO_BASE = "https://api.jup.ag/swap/v1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const API_KEY = process.env.JUPITER_API_KEY || undefined;

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA };
  if (API_KEY) h["x-api-key"] = API_KEY;
  return h;
}

/**
 * Build an executable Solana swap via Jupiter: GET /quote (full route object) → POST /swap with the
 * `userPublicKey` (a real holder of the input token, so the simulated balance check passes). Returns the
 * base64 VersionedTransaction. Throws `QuoteHttpError` on non-2xx (caller → skipped, never a false revert).
 */
export async function buildJupiterSwapTx(args: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  userPublicKey: string;
  slippageBps?: number;
}): Promise<string> {
  const base = API_KEY ? PRO_BASE : LITE_BASE;
  const slip = args.slippageBps != null && args.slippageBps > 0 ? args.slippageBps : 100;
  const qUrl = `${base}/quote?inputMint=${args.tokenIn}&outputMint=${args.tokenOut}&amount=${args.amountIn}&slippageBps=${slip}`;
  const qRes = await fetch(qUrl, { method: "GET", headers: headers() });
  if (!qRes.ok) throw new QuoteHttpError(qRes.status, `jupiter quote ${qRes.status}`);
  const quoteResponse = (await qRes.json()) as Record<string, unknown>;

  const sRes = await fetch(`${base}/swap`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: args.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!sRes.ok) throw new QuoteHttpError(sRes.status, `jupiter swap ${sRes.status}`);
  const json = (await sRes.json()) as { swapTransaction?: string };
  if (!json.swapTransaction) throw new QuoteHttpError(502, "jupiter swap: missing swapTransaction");
  return json.swapTransaction;
}
