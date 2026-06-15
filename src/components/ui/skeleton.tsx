interface SkeletonProps {
  className?: string;
}

/** A single shimmering placeholder block. Compose with width/height utilities (e.g. "h-4 w-24"). */
export function Skeleton({ className = "" }: SkeletonProps) {
  return <div className={`animate-pulse rounded bg-muted/20 ${className}`} aria-hidden="true" />;
}

// Deterministic (SSR-safe) per-cell widths so the placeholder reads as real, varied content.
const CELL_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-1/3"];

interface TableSkeletonProps {
  /** Real column headers — kept visible so the layout doesn't jump when data arrives. */
  columns: string[];
  rows?: number;
  /** Wrapper classes; default matches the bare data tables. Pass a bordered card for standalone use. */
  wrapperClassName?: string;
}

interface CardGridSkeletonProps {
  count?: number;
  /** Lines of shimmer in each card body. */
  lines?: number;
  /** Grid classes — match the real grid so the layout doesn't jump. */
  className?: string;
}

/** A grid of placeholder cards, for card-based views (token lists, OFT cards) while loading. */
export function CardGridSkeleton({
  count = 6,
  lines = 3,
  className = "grid gap-4 md:grid-cols-2",
}: CardGridSkeletonProps) {
  return (
    <div className={className} aria-busy="true" aria-live="polite">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-white p-4">
          <div className="mb-3 flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
          <div className="space-y-2">
            {Array.from({ length: lines }).map((_, l) => (
              <Skeleton key={l} className={`h-3 ${l % 2 === 0 ? "w-full" : "w-2/3"}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A table-shaped loading placeholder: the real header over `rows` of shimmer cells. */
export function TableSkeleton({ columns, rows = 8, wrapperClassName = "overflow-x-auto" }: TableSkeletonProps) {
  return (
    <div className={wrapperClassName} aria-busy="true" aria-live="polite">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border text-left">
            {columns.map((h) => (
              <th key={h} className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r} className="border-b border-border/60 last:border-0">
              {columns.map((_, c) => (
                <td key={c} className="px-4 py-3">
                  <Skeleton className={`h-4 ${c === 0 ? "w-6" : CELL_WIDTHS[(r + c) % CELL_WIDTHS.length]}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
