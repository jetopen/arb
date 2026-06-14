"use client";

import { useEffect, useState } from "react";
import type { NormalizedMessage } from "@/lib/types";
import { getChainName, getExplorerTxUrl } from "@/lib/chains";
import { StatusBadge } from "./status-badge";

interface MessageDetailProps {
  message: NormalizedMessage;
  onClose: () => void;
}

export function MessageDetail({ message, onClose }: MessageDetailProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => setVisible(true));
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  function close() {
    setVisible(false);
    setTimeout(onClose, 200); // Wait for animation
  }

  const srcExplorerUrl = getExplorerTxUrl(message.fromChainId, message.txHash);
  const dstExplorerUrl = message.dstTxHash
    ? getExplorerTxUrl(message.toChainId, message.dstTxHash)
    : "";

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/20 z-40 transition-opacity duration-200 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
        onClick={close}
      />

      {/* Drawer */}
      <div
        className={`fixed top-0 right-0 h-full w-full max-w-lg bg-white shadow-xl z-50 transition-transform duration-200 ${
          visible ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Message Detail</h2>
          <button
            onClick={close}
            className="text-muted hover:text-foreground text-lg"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto h-[calc(100%-64px)] px-6 py-4 space-y-6">
          <StatusSection message={message} />

          <Section title="Transaction">
            <DetailRow label="Source Tx">
              <ExplorerLink hash={message.txHash} url={srcExplorerUrl} />
            </DetailRow>
            {message.dstTxHash && dstExplorerUrl && (
              <DetailRow label="Destination Tx">
                <ExplorerLink hash={message.dstTxHash} url={dstExplorerUrl} />
              </DetailRow>
            )}
            <DetailRow label="Order ID">
              <span className="font-mono text-xs break-all">{message.orderId}</span>
            </DetailRow>
          </Section>

          <Section title="Route">
            <DetailRow label="From">
              {getChainName(message.fromChainId)}
            </DetailRow>
            <DetailRow label="To">
              {getChainName(message.toChainId)}
            </DetailRow>
          </Section>

          <Section title="Tokens">
            <DetailRow label="Send">
              {message.fromAmount} {message.fromTokenSymbol}
              <span className="text-muted text-xs ml-1">({message.fromTokenName})</span>
            </DetailRow>
            <DetailRow label="Receive">
              {message.toAmount} {message.toTokenSymbol}
              <span className="text-muted text-xs ml-1">({message.toTokenName})</span>
            </DetailRow>
          </Section>

          <Section title="Fees">
            <DetailRow label="Total Fee">{message.fee}</DetailRow>
            <DetailRow label="Fixed Fee">{message.fixFee}</DetailRow>
            <DetailRow label="Operating Expenses">{message.operatingExpenses}</DetailRow>
          </Section>

          <Section title="Metadata">
            <DetailRow label="State">{message.state}</DetailRow>
            <DetailRow label="External Call">{message.externalCallState}</DetailRow>
            <DetailRow label="Timestamp">
              {new Date(message.timestamp * 1000).toLocaleString()}
            </DetailRow>
          </Section>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-3">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm text-muted shrink-0">{label}</span>
      <span className="text-sm text-foreground text-right">{children}</span>
    </div>
  );
}

function ExplorerLink({ hash, url }: { hash: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-xs text-accent hover:underline break-all"
    >
      {hash}
    </a>
  );
}

function StatusSection({ message }: { message: NormalizedMessage }) {
  return (
    <div className="flex items-center gap-3">
      <StatusBadge status={message.status} />
      <span className="text-sm text-muted">
        {new Date(message.timestamp * 1000).toLocaleString()}
      </span>
    </div>
  );
}
