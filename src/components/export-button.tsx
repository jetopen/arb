"use client";

import { exportToCSV, exportToJSON } from "@/lib/export";
import type { NormalizedMessage } from "@/lib/types";
import { useState, useRef, useEffect } from "react";

interface ExportButtonProps {
  messages: NormalizedMessage[];
}

export function ExportButton({ messages }: ExportButtonProps) {
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

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted/50 transition-colors"
      >
        Export ▾
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-40 rounded-md border border-border bg-white shadow-lg z-10">
          <button
            onClick={() =>
              download(exportToCSV(messages), "debridge-messages.csv", "text/csv")
            }
            className="block w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
          >
            Export CSV
          </button>
          <button
            onClick={() =>
              download(exportToJSON(messages), "debridge-messages.json", "application/json")
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
