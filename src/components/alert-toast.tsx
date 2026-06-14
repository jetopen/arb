"use client";

import { useAlerts } from "@/lib/alerts/context";

export function AlertToast() {
  const { notifications, dismissNotification, dismissAll } = useAlerts();

  const active = notifications.filter((n) => !n.dismissed);

  if (active.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {active.length > 1 && (
        <button
          onClick={dismissAll}
          className="self-end text-xs text-muted hover:text-foreground transition-colors"
        >
          Dismiss all ({active.length})
        </button>
      )}
      {active.slice(0, 3).map((n) => (
        <div
          key={n.id}
          className="rounded-lg border border-border bg-white shadow-lg p-3 animate-in slide-in-from-right"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-foreground">{n.title}</p>
              <p className="text-xs text-muted mt-1">{n.body}</p>
            </div>
            <button
              onClick={() => dismissNotification(n.id)}
              className="text-muted hover:text-foreground text-xs"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
