"use client";

import { useEffect, useRef, useState } from "react";

/** One flat row of the token×chain matrix. */
export interface LzExportRow {
  symbol: string;
  chainName: string;
  /** The OFT / adapter contract address. */
  address: string;
  /** The tradeable (inner) ERC-20 address. */
  tradeAddress: string;
  liquidityUsd: number | null;
  priceUsd: number | null;
}

const COLUMNS: { key: keyof LzExportRow; header: string }[] = [
  { key: "symbol", header: "symbol" },
  { key: "chainName", header: "chainName" },
  { key: "address", header: "address" },
  { key: "tradeAddress", header: "tradeAddress" },
  { key: "liquidityUsd", header: "liquidityUsd" },
  { key: "priceUsd", header: "priceUsd" },
];

function escapeCsv(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function cell(v: string | number | null): string {
  if (v == null) return "";
  return String(v);
}

/** Token×chain matrix → CSV. Local to this unit (lib/export.ts is typed for messages). */
export function toCsv(rows: LzExportRow[]): string {
  const headerLine = COLUMNS.map((c) => escapeCsv(c.header)).join(",");
  const dataLines = rows.map((r) =>
    COLUMNS.map((c) => escapeCsv(cell(r[c.key]))).join(",")
  );
  return [headerLine, ...dataLines].join("\n");
}

/** Token×chain matrix → pretty JSON. */
export function toJson(rows: LzExportRow[]): string {
  return JSON.stringify(rows, null, 2);
}

export function ExportButton({ rows }: { rows: LzExportRow[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function download(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setOpen(false);
  }

  const disabled = rows.length === 0;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Export ▾
      </button>
      {open && !disabled && (
        <div className="absolute right-0 mt-1 w-44 rounded-md border border-border bg-white shadow-lg z-10">
          <button
            type="button"
            onClick={() => download(toCsv(rows), "layerzero-ofts.csv", "text/csv")}
            className="block w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={() =>
              download(toJson(rows), "layerzero-ofts.json", "application/json")
            }
            className="block w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
          >
            Export JSON
          </button>
        </div>
      )}
    </div>
  );
}
