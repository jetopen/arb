import type { NormalizedMessage } from "./types";
import { getChainName } from "./chains";

export function exportToCSV(messages: NormalizedMessage[]): string {
  const headers = [
    "Order ID",
    "Tx Hash",
    "From Chain",
    "To Chain",
    "From Amount",
    "To Amount",
    "From Token",
    "To Token",
    "Fee",
    "Status",
    "Timestamp",
  ];

  const rows = messages.map((m) => [
    m.orderId,
    m.txHash,
    getChainName(m.fromChainId),
    getChainName(m.toChainId),
    m.fromAmount,
    m.toAmount,
    m.fromTokenSymbol,
    m.toTokenSymbol,
    m.fee,
    m.status,
    new Date(m.timestamp * 1000).toISOString(),
  ]);

  const escapeCsv = (val: string): string => {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const headerLine = headers.map(escapeCsv).join(",");
  const dataLines = rows.map((row) => row.map(escapeCsv).join(","));
  return [headerLine, ...dataLines].join("\n");
}

export function exportToJSON(messages: NormalizedMessage[]): string {
  return JSON.stringify(messages, null, 2);
}
