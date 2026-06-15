"use client";

import { useState } from "react";
import { getChainByInternalId } from "@/lib/deport/registry";
import { getExplorerAddressUrl } from "@/lib/chains";

/**
 * One lock-path leg's token address, optimized for fast copying: the full address is a click-to-copy
 * target, with an always-visible "Copy" button (and feedback) plus a separate explorer link. Centralizes
 * the internal-chain-id → EVM-chain-id → explorer-URL mapping so the table's expandable row and the
 * detail drawer render addresses identically. (The shared CopyableAddress is intentionally not used
 * here — its copy affordance is hover-only, which is hard to discover and unusable on touch.)
 */
export function LegAddress({ chainId, address }: { chainId: number; address: string }) {
  const [copied, setCopied] = useState(false);
  const evmId = getChainByInternalId(chainId)?.evmChainId ?? chainId;
  const url = getExplorerAddressUrl(evmId, address);

  const copy = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — ignore */
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={copy}
        title="Click to copy address"
        className="rounded bg-muted/40 px-1.5 py-0.5 text-left font-mono text-xs text-foreground transition-colors hover:bg-muted/70 break-all"
      >
        {address}
      </button>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Address copied" : "Copy address"}
        className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
          copied ? "bg-green-100 text-green-800" : "text-accent hover:bg-accent/10"
        }`}
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="View on block explorer"
          aria-label="View on block explorer"
          className="shrink-0 px-1 text-xs text-muted transition-colors hover:text-foreground"
        >
          ↗
        </a>
      )}
    </span>
  );
}
