"use client";

import { useState, useCallback } from "react";
import { useMessages, useSearch } from "@/lib/hooks";
import { MessagesTable } from "@/components/messages-table";
import { ChainFilter } from "@/components/filters/chain-filter";
import { StatusFilter } from "@/components/filters/status-filter";
import { DateRangeFilter } from "@/components/filters/date-range-filter";
import { SearchBar } from "@/components/search-bar";
import { StatusBadge } from "@/components/status-badge";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ExportButton } from "@/components/export-button";
import { MessageDetail } from "@/components/message-detail";
import { LastUpdated } from "@/components/last-updated";
import type { NormalizedMessage } from "@/lib/types";

export default function MessagesPage() {
  const [page, setPage] = useState(1);
  const [chainFrom, setChainFrom] = useState("");
  const [chainTo, setChainTo] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [tradeType, setTradeType] = useState<"all" | "bridge" | "swap">("all");
  const [nonNativeOnly, setNonNativeOnly] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<NormalizedMessage | null>(null);

  const { data, error, isLoading, mutate } = useMessages({
    chainFrom: chainFrom || undefined,
    chainTo: chainTo || undefined,
    status: status || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    take: 50,
  });

  const { data: searchData, isLoading: searchLoading } = useSearch(
    searchQuery.length >= 10 ? searchQuery : ""
  );

  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  const showSearchResult = searchQuery.length >= 10 && searchData;

  const NATIVE_SYMBOLS = new Set(["ETH", "SOL", "BNB", "MATIC", "AVAX", "FTM", "XDAI", "HT", "OP", "ARB", "S", "MNT", "BERA", "CRO", "INJ", "SEI", "MON", "HYPE", "FLOW"]);

  const filteredMessages = data?.messages?.filter((msg) => {
    if (tradeType === "bridge" && msg.fromTokenSymbol !== msg.toTokenSymbol) return false;
    if (tradeType === "swap" && msg.fromTokenSymbol === msg.toTokenSymbol) return false;
    if (nonNativeOnly && NATIVE_SYMBOLS.has(msg.fromTokenSymbol) && NATIVE_SYMBOLS.has(msg.toTokenSymbol)) return false;
    return true;
  }) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Messages</h1>
        <div className="flex items-center gap-3">
          <LastUpdated lastFetched={data ? Date.now() : undefined} />
          <ExportButton messages={filteredMessages} />
          <button
            onClick={() => mutate()}
            className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted/50 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <SearchBar onSearch={handleSearch} />
        <div className="flex flex-wrap items-end gap-4">
          <ChainFilter label="From Chain" value={chainFrom} onChange={(v) => { setChainFrom(v); setPage(1); }} />
          <ChainFilter label="To Chain" value={chainTo} onChange={(v) => { setChainTo(v); setPage(1); }} />
          <StatusFilter value={status} onChange={(v) => { setStatus(v); setPage(1); }} />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted uppercase tracking-wider">Type</label>
            <select
              value={tradeType}
              onChange={(e) => { setTradeType(e.target.value as "all" | "bridge" | "swap"); setPage(1); }}
              className="px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
            >
              <option value="all">All</option>
              <option value="bridge">Bridge (Same Token)</option>
              <option value="swap">Swap (Diff Token)</option>
            </select>
          </div>
          <button
            onClick={() => { setNonNativeOnly(!nonNativeOnly); setPage(1); }}
            className={`px-3 py-2 text-sm rounded-md border transition-colors self-end ${nonNativeOnly ? "bg-accent text-white border-accent" : "border-border hover:bg-muted/50"}`}
          >
            {nonNativeOnly ? "✓ Non-Native" : "Non-Native"}
          </button>
          <DateRangeFilter
            dateFrom={dateFrom}
            dateTo={dateTo}
            onFromChange={(v) => { setDateFrom(v); setPage(1); }}
            onToChange={(v) => { setDateTo(v); setPage(1); }}
          />
        </div>
      </div>

      {showSearchResult ? (
        <div className="space-y-4">
          <h2 className="text-sm font-medium text-muted">Search Result</h2>
          {searchLoading ? (
            <LoadingSpinner />
          ) : searchData?.message ? (
            <div className="rounded-lg border border-border p-4 space-y-2">
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted">Order:</span>
                <span className="font-mono text-sm">{searchData.message.orderId}</span>
                <StatusBadge status={searchData.message.status} />
              </div>
              <div className="text-sm text-muted">
                {searchData.message.txHash}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">No messages found for &ldquo;{searchQuery}&rdquo;</p>
          )}
        </div>
      ) : (
        <MessagesTable
          messages={filteredMessages}
          loading={isLoading}
          error={error?.message ?? null}
          page={page}
          total={tradeType === "all" ? (data?.total ?? 0) : filteredMessages.length}
          pageSize={50}
          onPageChange={handlePageChange}
          onRetry={() => mutate()}
        />
      )}
      {selectedMessage && (
        <MessageDetail
          message={selectedMessage}
          onClose={() => setSelectedMessage(null)}
        />
      )}
    </div>
  );
}
