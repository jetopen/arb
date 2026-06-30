/** Human "Xs/Xm/Xh ago" for a past epoch-ms timestamp; "—" when absent (ts undefined or 0). Shared by the
 *  scan-status bar, the last-updated chip, and the per-row freshness badge so the format stays consistent. */
export function timeAgo(ts?: number): string {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
