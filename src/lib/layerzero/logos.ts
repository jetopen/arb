import { getTokenListForChain } from "@/lib/api-client";

/**
 * Pure logo lookup: find `address` (lowercased) in a token-list Map and return its
 * `logoURI`, or null when the entry is missing / has no logo. No I/O, no throwing.
 */
export function pickLogo(
  tokenList: Map<string, { logoURI?: string }>,
  address: string
): string | null {
  const entry = tokenList.get(address.toLowerCase());
  return entry?.logoURI ?? null;
}

/**
 * Resolve a token logo URL for an EVM chain id + address.
 *
 * When `evmChainId` is non-null, fetches the deBridge token list for that chain (itself
 * cached in api-client) and applies {@link pickLogo}. Returns null for a null chain
 * (non-EVM), a miss, or any error — never throws.
 */
export async function resolveLogo(
  evmChainId: number | null,
  address: string
): Promise<string | null> {
  if (evmChainId === null) return null;
  try {
    const tokenList = await getTokenListForChain(evmChainId);
    return pickLogo(tokenList, address);
  } catch {
    return null;
  }
}
