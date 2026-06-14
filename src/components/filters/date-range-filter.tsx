"use client";

interface DateRangeFilterProps {
  dateFrom: string;
  dateTo: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}

export function DateRangeFilter({
  dateFrom,
  dateTo,
  onFromChange,
  onToChange,
}: DateRangeFilterProps) {
  return (
    <div className="flex items-end gap-2">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted uppercase tracking-wider">
          From
        </label>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => onFromChange(e.target.value)}
          className="px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted uppercase tracking-wider">
          To
        </label>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => onToChange(e.target.value)}
          className="px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </div>
    </div>
  );
}
