"use client";

import type { NormalizedMessage } from "@/lib/types";
import { MessageRow } from "./message-row";
import { TableSkeleton } from "./ui/skeleton";
import { EmptyState } from "./ui/empty-state";
import { ErrorState } from "./ui/error-state";

const COLUMNS = ["#", "Time", "Tx Hash", "From → To", "From Token", "To Token", "Amount", "Fee", "Status"];

interface MessagesTableProps {
  messages: NormalizedMessage[];
  loading: boolean;
  error: string | null;
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onRetry?: () => void;
}

export function MessagesTable({
  messages,
  loading,
  error,
  page,
  total,
  pageSize,
  onPageChange,
  onRetry,
}: MessagesTableProps) {
  const totalPages = Math.ceil(total / pageSize);

  if (loading && messages.length === 0) {
    return <TableSkeleton columns={COLUMNS} rows={pageSize > 0 ? Math.min(pageSize, 12) : 10} />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={onRetry} />;
  }

  if (messages.length === 0) {
    return <EmptyState message="No messages found" />;
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-left">
              {COLUMNS.map((h) => (
                <th key={h} className="px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {messages.map((msg, i) => (
              <MessageRow
                key={msg.orderId}
                message={msg}
                index={(page - 1) * pageSize + i}
              />
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="px-3 py-1.5 text-sm rounded-md border border-border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
          >
            ← Previous
          </button>
          <span className="text-sm text-muted">
            Page {page} of {totalPages} ({total} messages)
          </span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="px-3 py-1.5 text-sm rounded-md border border-border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
