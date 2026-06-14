"use client";

import type { ReactNode } from "react";

type StatusType =
  | "Awaiting Confirmation"
  | "Awaiting Execution"
  | "Executing"
  | "Executed"
  | "Cancelled"
  | "Failed";

const STATUS_STYLES: Record<StatusType, string> = {
  "Awaiting Confirmation": "bg-yellow-100 text-yellow-800",
  "Awaiting Execution": "bg-amber-100 text-amber-800",
  Executing: "bg-blue-100 text-blue-800",
  Executed: "bg-green-100 text-green-800",
  Cancelled: "bg-gray-100 text-gray-600",
  Failed: "bg-red-100 text-red-800",
};

interface StatusBadgeProps {
  status: string;
  children?: ReactNode;
}

export function StatusBadge({ status, children }: StatusBadgeProps) {
  const normalized = status as StatusType;
  const classes = STATUS_STYLES[normalized] ?? "bg-gray-100 text-gray-600";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${classes}`}
      data-testid="status-badge"
    >
      {children ?? status}
    </span>
  );
}
