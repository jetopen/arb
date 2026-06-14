"use client";

import type { NormalizedMessage } from "@/lib/types";
import { useState } from "react";
import { getChainName, getExplorerTxUrl, getExplorerAddressUrl } from "@/lib/chains";
import { StatusBadge } from "./status-badge";

function formatAmount(amount: string, decimals: number, symbol: string): string {
  const value = Number(amount || 0) / Math.pow(10, decimals);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M ${symbol}`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K ${symbol}`;
  return `${value.toFixed(decimals > 6 ? 4 : 2)} ${symbol}`;
}

function formatFee(
  feeRaw: string,
  fromAmount: string,
  fromTokenDecimals: number,
  fromTokenSymbol: string
): string {
  const fee = Number(feeRaw || 0);
  const give = Number(fromAmount || 0);
  if (fee === 0) return "—";
  const feeHuman = fee / Math.pow(10, fromTokenDecimals);
  const parts: string[] = [];
  if (feeHuman >= 1_000_000) parts.push(`${(feeHuman / 1_000_000).toFixed(2)}M`);
  else if (feeHuman >= 1_000) parts.push(`${(feeHuman / 1_000).toFixed(2)}K`);
  else parts.push(feeHuman.toFixed(fromTokenDecimals > 6 ? 6 : 4));
  parts.push(fromTokenSymbol);
  if (give > 0) {
    const pct = (fee / give) * 100;
    if (pct > 0 && pct <= 100) parts.push(`(${pct.toFixed(2)}%)`);
  }
  return parts.join(" ");
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function CopyableAddress({ address, explorerUrl }: { address: string; explorerUrl: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span className="inline-flex items-center gap-1 group">
      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-xs text-accent hover:underline"
      >
        {address.slice(0, 6)}...{address.slice(-4)}
      </a>
      <button
        onClick={handleCopy}
        className="opacity-0 group-hover:opacity-100 text-xs text-muted hover:text-foreground transition-opacity px-0.5"
        title="Copy address"
      >
        {copied ? "✓" : "📋"}
      </button>
    </span>
  );
}

function TruncatedHash({ hash, explorerUrl }: { hash: string; explorerUrl?: string }) {
  const truncated = `${hash.slice(0, 6)}...${hash.slice(-4)}`;
  if (explorerUrl) {
    return (
      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-sm text-accent hover:underline"
      >
        {truncated}
      </a>
    );
  }
  return <span className="font-mono text-sm text-muted">{truncated}</span>;
}

interface MessageRowProps {
  message: NormalizedMessage;
  index: number;
}

export function MessageRow({ message, index }: MessageRowProps) {
  const fromChainName = getChainName(message.fromChainId);
  const toChainName = getChainName(message.toChainId);
  const txUrl = getExplorerTxUrl(message.fromChainId, message.txHash);
  const fromAddrUrl = getExplorerAddressUrl(message.fromChainId, message.fromTokenAddress);
  const toAddrUrl = getExplorerAddressUrl(message.toChainId, message.toTokenAddress);

  const fromAmount = formatAmount(
    message.fromAmount,
    message.fromTokenDecimals,
    message.fromTokenSymbol
  );
  const toAmount = formatAmount(
    message.toAmount,
    message.toTokenDecimals,
    message.toTokenSymbol
  );

  return (
    <tr className="border-b border-border hover:bg-muted/30 transition-colors">
      <td className="px-4 py-3 text-sm text-muted">{index + 1}</td>
      <td className="px-4 py-3 text-sm text-muted whitespace-nowrap">
        {formatTime(message.timestamp)}
      </td>
      <td className="px-4 py-3">
        <TruncatedHash hash={message.txHash} explorerUrl={txUrl ?? undefined} />
      </td>
      <td className="px-4 py-3 text-sm whitespace-nowrap">
        <span className="text-foreground">{fromChainName}</span>
        <span className="mx-2 text-muted">→</span>
        <span className="text-foreground">{toChainName}</span>
      </td>
      <td className="px-4 py-3">
        {fromAddrUrl ? (
          <CopyableAddress address={message.fromTokenAddress} explorerUrl={fromAddrUrl} />
        ) : (
          <span className="font-mono text-xs text-muted">
            {message.fromTokenAddress.slice(0, 6)}...{message.fromTokenAddress.slice(-4)}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        {toAddrUrl ? (
          <CopyableAddress address={message.toTokenAddress} explorerUrl={toAddrUrl} />
        ) : (
          <span className="font-mono text-xs text-muted">
            {message.toTokenAddress.slice(0, 6)}...{message.toTokenAddress.slice(-4)}
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-sm whitespace-nowrap">
        <div>{fromAmount}</div>
        {message.fromTokenSymbol !== message.toTokenSymbol && (
          <div className="text-muted text-xs">{toAmount}</div>
        )}
      </td>
      <td className="px-4 py-3 text-sm whitespace-nowrap">{formatFee(message.fee, message.fromAmount, message.fromTokenDecimals, message.fromTokenSymbol)}</td>
      <td className="px-4 py-3">
        <StatusBadge status={message.status} />
      </td>
    </tr>
  );
}
