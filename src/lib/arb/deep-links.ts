import { getChainByInternalId } from "../deport/registry";
import { kyberSlug } from "../quotes/kyberswap";
import { baseToken } from "./base-tokens";
import { SOLANA_INTERNAL_ID } from "../deport/address-codec";
import type { Opportunity } from "../types";

// Prefilled execution links for the drawer — pure URL templates over an opportunity's lockPath + the registry.
// A screener aid, not an executor: the user still reviews amounts and signs. All data needed is already on the
// row, so no network calls here.

export interface DeepLink {
  label: string;
  url: string;
}

/** deBridge app, prefilled to bridge the bought asset from the buy chain to the sell chain (the dePort leg). */
function debridgeLink(opp: Opportunity): DeepLink | null {
  const buy = opp.lockPath[0];
  const sell = opp.lockPath[1];
  if (!buy || !sell) return null;
  const buyEvm = getChainByInternalId(opp.buyChainId)?.evmChainId ?? opp.buyChainId;
  const sellEvm = getChainByInternalId(opp.sellChainId)?.evmChainId ?? opp.sellChainId;
  const q = new URLSearchParams({
    inputChain: String(buyEvm),
    outputChain: String(sellEvm),
    inputCurrency: buy.address,
    outputCurrency: sell.address,
  });
  return { label: "Bridge on deBridge", url: `https://app.debridge.finance/?${q.toString()}` };
}

/** Swap link for one leg (USDC↔token on the leg's chain): Jupiter on Solana, KyberSwap on Kyber-covered EVM
 *  chains, else a GeckoTerminal inspect link for chains no aggregator deep-link covers (Tron/Sei/HyperEVM/…).
 *  `side` orders the pair: buy = USDC→token (acquire the asset), sell = token→USDC (offload it). */
function swapLink(internalChainId: number, tokenAddr: string, side: "buy" | "sell", label: string): DeepLink | null {
  const usdc = baseToken(internalChainId)?.address;
  const [inTok, outTok] = side === "buy" ? [usdc, tokenAddr] : [tokenAddr, usdc];
  if (internalChainId === SOLANA_INTERNAL_ID) {
    return usdc ? { label, url: `https://jup.ag/swap/${inTok}-${outTok}` } : null;
  }
  const slug = kyberSlug(internalChainId);
  if (slug && usdc) return { label, url: `https://kyberswap.com/swap/${slug}/${inTok}-to-${outTok}` };
  return { label: `${label} (inspect)`, url: `https://www.geckoterminal.com/search?query=${tokenAddr}` };
}

/** The ordered set of execution links for a route: bridge, then the buy and sell swap legs. */
export function executeLinks(opp: Opportunity): DeepLink[] {
  const links: DeepLink[] = [];
  const bridge = debridgeLink(opp);
  if (bridge) links.push(bridge);
  const buy = opp.lockPath[0];
  const sell = opp.lockPath[1];
  if (buy) {
    const l = swapLink(opp.buyChainId, buy.address, "buy", "Buy leg swap");
    if (l) links.push(l);
  }
  if (sell) {
    const l = swapLink(opp.sellChainId, sell.address, "sell", "Sell leg swap");
    if (l) links.push(l);
  }
  return links;
}
