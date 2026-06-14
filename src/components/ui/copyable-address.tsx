"use client";

import { useState } from "react";

interface CopyableAddressProps {
  address: string;
  /** Block-explorer URL; when absent the text renders as plain (non-link) muted mono. */
  explorerUrl?: string | null;
  /** Override the displayed text (default: truncated 0x1234…abcd). */
  label?: string;
  className?: string;
}

function truncate(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Truncated address with an explorer link (when known) and a hover-reveal copy button.
 * Shared component extracted from the messages table so the LayerZero tracker and any
 * future view render copyable addresses identically.
 */
export function CopyableAddress({ address, explorerUrl, label, className }: CopyableAddressProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — ignore */
    }
  };

  const text = label ?? truncate(address);

  return (
    <span className={`inline-flex items-center gap-1 group ${className ?? ""}`}>
      {explorerUrl ? (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-accent hover:underline"
        >
          {text}
        </a>
      ) : (
        <span className="font-mono text-xs text-muted">{text}</span>
      )}
      <button
        onClick={handleCopy}
        className="opacity-0 group-hover:opacity-100 text-xs text-muted hover:text-foreground transition-opacity px-0.5"
        title={copied ? "Copied!" : "Copy address"}
        aria-label="Copy address"
      >
        {copied ? "✓" : "📋"}
      </button>
    </span>
  );
}
