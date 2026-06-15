"use client";

import { getChainByInternalId } from "@/lib/deport/registry";
import { getExplorerAddressUrl } from "@/lib/chains";
import { CopyableAddress } from "../ui/copyable-address";

/**
 * One lock-path leg's token address as a copyable, explorer-linked value. Centralizes the
 * internal-chain-id → EVM-chain-id → explorer-URL mapping so the table's expandable row and the
 * detail drawer render addresses identically (previously duplicated in both).
 */
export function LegAddress({ chainId, address }: { chainId: number; address: string }) {
  const evmId = getChainByInternalId(chainId)?.evmChainId ?? chainId;
  const url = getExplorerAddressUrl(evmId, address);
  return <CopyableAddress address={address} explorerUrl={url} label={address} className="break-all" />;
}
