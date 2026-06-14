import type { ReactNode } from "react";

interface Props {
  title?: string;
  message?: string;
  icon?: ReactNode;
}

export function EmptyState({
  title = "No data found",
  message,
  icon,
}: Props) {
  return (
    <div className="card text-center py-12">
      {icon && <div className="flex justify-center mb-3">{icon}</div>}
      <p className="text-muted font-medium">{title}</p>
      {message && <p className="text-muted text-sm mt-1">{message}</p>}
    </div>
  );
}
